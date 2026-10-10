#!/usr/bin/env node
// Applying a package-file patch.
//
// This is the only writer in the system. The host refuses to touch an
// installed package, for reasons spelled out in src/adapters/package-file.ts;
// this process exists so the write can still happen, with a lock nobody else
// holds, in a place whose failure modes are visible.
//
// What it will not do is guess. It reads the patch out of the spec, checks the
// package is at the version the spec named, and refuses to write a byte when
// any of that is not true — including when the edit matches zero times or more
// than once. A wrong patch applied confidently is worse than no patch, because
// it is indistinguishable from a working one until the thing breaks.
//
// The helpers below are exported and guarded by import.meta.main so the test
// suite can pin their semantics. assessEdits in particular is duplicated from
// the host adapter on purpose: this script has to run outside a built host,
// and test/apply-code-patch.test.ts asserts the two agree.
import { spawn } from 'node:child_process'
import {
  existsSync,
  statSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { parseDocument } from 'yaml'

export const NAMESPACE = 'dsh-plugin-patcher'

function say(line) {
  process.stdout.write(line + '\n')
}

function die(message) {
  process.stderr.write('apply-code-patch: ' + message + '\n')
  process.exit(1)
}

export function parseArgs(argv) {
  const out = {
    profile: process.env.DSH_PROFILE ?? 'web',
    dryRun: false,
    install: false,
    importSmoke: true,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => {
      const value = argv[++i]
      if (value === undefined) die(arg + ' needs a value')
      return value
    }
    if (arg === '--patch-id') out.patchId = next()
    else if (arg === '--pkg') out.pkg = next()
    else if (arg === '--spec') out.spec = next()
    else if (arg === '--profile') out.profile = next()
    else if (arg === '--dsh-home') out.dshHome = next()
    else if (arg === '--profile-dir') out.profileDir = next()
    else if (arg === '--dry-run') out.dryRun = true
    else if (arg === '--install') out.install = true
    else if (arg === '--patcher-root') out.patcherRoot = next()
    else if (arg === '--no-import-smoke') out.importSmoke = false
    else if (arg === '--help' || arg === '-h') out.help = true
    else die('unknown argument: ' + arg)
  }
  return out
}

export const HELP = [
  'Usage:',
  '  node scripts/apply-code-patch.mjs --patch-id <id> [options]',
  '',
  'Options:',
  '  --spec <file>        spec document; defaults to the profile patch file',
  '  --pkg <name>         sanity check: fail unless the patch targets this package',
  '  --profile <name>     profile name (default: DSH_PROFILE or "web")',
  '  --dsh-home <dir>     harness home (default: DSH_HOME or ~/.dsh)',
  '  --profile-dir <dir>  profile directory; overrides --profile and --dsh-home',
  '  --dry-run            show what would change, write nothing',
  '  --install            run pnpm install afterwards so the patched copy is the one on disk',
  '  --patcher-root <dir> package holding patches/; defaults to this script\'s own package',
  '  --no-import-smoke    skip the load-the-result check (see the comment on importSmoke)',
].join('\n')

/**
 * Pull the patcher config out of a document.
 *
 * Three shapes are accepted because all three are things a person could
 * reasonably hand this script: the config itself, the config nested under its
 * namespace, and the whole profile patch file where the config sits in the
 * config key of the row with our id. Refusing two of the three would be a
 * papercut for a script that only runs when something has already gone wrong.
 */
export function configFrom(value) {
  if (value === null || typeof value !== 'object') return undefined
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item === null || typeof item !== 'object') continue
      if (item.id !== NAMESPACE) continue
      if (item.config && Array.isArray(item.config.patches)) return item.config
    }
    return undefined
  }
  if (Array.isArray(value.patches)) return value
  if (value[NAMESPACE] && Array.isArray(value[NAMESPACE].patches)) return value[NAMESPACE]
  if (value.config && Array.isArray(value.config.patches)) return value.config
  return undefined
}

export function loadConfig(specPath) {
  const text = readFileSync(specPath, 'utf8')
  // JSON is a subset of YAML, so one parser covers both. The custom tags let
  // the rows around ours survive parsing on the way to our own.
  const document = parseDocument(text, {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value) => value }],
  })
  if (document.errors[0] !== undefined) {
    die(specPath + ' is not valid YAML: ' + document.errors[0].message)
  }
  // toJS rather than walking nodes: a Document is not a Node, and the shape
  // checks above are written against plain values.
  const config = configFrom(document.toJS())
  if (config === undefined) {
    die('no ' + NAMESPACE + ' spec in ' + specPath + '. Expected a document holding a "patches" list.')
  }
  return config
}

/**
 * The spec lives in the profile patch file, in the config key of our own row.
 * That is not a guess: dsh-settings persists through configEditor.edit, whose
 * documentPath is the profile patch path.
 */
function defaultSpecPath(profileDir) {
  const path = join(profileDir, 'cordis.patch.yml')
  if (!existsSync(path)) {
    die('no profile patch file at ' + path + '. Pass --spec <file> to point at one.')
  }
  return path
}

function countOf(text, needle) {
  if (needle === '') return -1
  let at = text.indexOf(needle)
  let count = 0
  while (at >= 0) {
    count++
    at = text.indexOf(needle, at + needle.length)
  }
  return count
}

/**
 * Mirrors assessEdits in src/adapters/package-file.ts. See the header for why
 * this duplication exists.
 */
function spansOf(text, needle) {
  const spans = []
  if (needle === '') return spans
  let at = text.indexOf(needle)
  while (at >= 0) {
    spans.push([at, at + needle.length])
    at = text.indexOf(needle, at + needle.length)
  }
  return spans
}

// See isApplied in src/adapters/package-file.ts: an insertion leaves its own
// find inside its own replacement, so "the find is gone" is the wrong test.
// Every occurrence of the find must lie inside an occurrence of the replace.
function isApplied(text, edit) {
  if (edit.replace === '') return false
  const replaces = spansOf(text, edit.replace)
  if (replaces.length === 0) return false
  return spansOf(text, edit.find).every(([start, end]) =>
    replaces.some(([from, to]) => start >= from && end <= to),
  )
}

export function assessEdits(text, edits) {
  if (edits.length === 0) return { kind: 'already-applied' }
  let applied = 0
  for (const edit of edits) {
    const found = countOf(text, edit.find)
    if (found === -1) return { kind: 'empty-find', edit }
    if (isApplied(text, edit)) {
      applied++
      continue
    }
    if (found === 0) return { kind: 'no-match', edit }
    if (found > 1) return { kind: 'many-matches', edit, count: found }
  }
  if (applied === 0) return { kind: 'applicable' }
  if (applied === edits.length) return { kind: 'already-applied' }
  return { kind: 'partial', applied, total: edits.length }
}
export function firstLine(text) {
  const line = text.split('\n')[0] ?? ''
  return '  ' + (line.length > 70 ? line.slice(0, 67) + '...' : line)
}

/** A reason to stop, or undefined when the edits are good to go. */
function whyNot(text, edits) {
  const verdict = assessEdits(text, edits)
  if (verdict.kind === 'empty-find') return 'an edit has an empty find, which would match everywhere'
  if (verdict.kind === 'no-match') return 'the text to find is not in the file:\n' + firstLine(verdict.edit.find)
  if (verdict.kind === 'many-matches') {
    return 'the text to find appears ' + verdict.count + ' times; the spec has to say which one'
  }
  if (verdict.kind === 'partial') {
    return (
      'only ' + verdict.applied + ' of ' + verdict.total +
      ' edits are already in the file. Re-running would rewrite the ones that are not; apply the rest by hand.'
    )
  }
  return undefined
}

function applyEdits(text, edits) {
  let out = text
  for (const edit of edits) {
    const at = out.indexOf(edit.find)
    out = out.slice(0, at) + edit.replace + out.slice(at + edit.find.length)
  }
  return out
}

/** The longest a single line is shown at, so one minified row cannot flood the report. */
const LINE_LIMIT = 200

function clipped(line) {
  return line.length > LINE_LIMIT ? line.slice(0, LINE_LIMIT) + '... (' + line.length + ' characters)' : line
}

/**
 * A diff narrow enough to read.
 *
 * Line-based, not character-based, and that is the whole point. The usual trick
 * of printing the common prefix, the differing middle and the common suffix
 * produces something unreadable for exactly the edits this script exists to
 * apply: `execute(sessionId, line)` becoming `execute(sessionId, line, [])` is
 * three characters in the middle of a line, and a character diff renders that
 * as a removed empty line and an added `, []`. Which line changed, in full, is
 * the question a dry run exists to answer. Long lines are clipped with a stated
 * length rather than silently cut.
 */
export function describeChange(before, after) {
  const oldLines = before.split('\n')
  const newLines = after.split('\n')
  let start = 0
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++
  let end = 0
  while (
    end < oldLines.length - start &&
    end < newLines.length - start &&
    oldLines[oldLines.length - 1 - end] === newLines[newLines.length - 1 - end]
  )
    end++

  const context = 2
  const out = []
  if (start > context) out.push('  ...')
  for (const line of oldLines.slice(Math.max(0, start - context), start)) out.push('  ' + clipped(line))
  // Identical texts share every line, so both middles come out empty on their
  // own; there is no phantom removed and added line to suppress here.
  for (const line of oldLines.slice(start, oldLines.length - end)) out.push('- ' + clipped(line))
  for (const line of newLines.slice(start, newLines.length - end)) out.push('+ ' + clipped(line))
  const tailFrom = oldLines.length - end
  for (const line of oldLines.slice(tailFrom, tailFrom + context)) out.push('  ' + clipped(line))
  if (end > context) out.push('  ...')
  return out.join('\n')
}

/**
 * Run a child process, optionally under a deadline.
 *
 * A deadline is not a nicety here. The one child that can legitimately hang is
 * the import smoke, because loading a third-party module runs its top level and
 * we do not control what that does; escalating SIGTERM to SIGKILL means a
 * misbehaving package costs fifteen seconds instead of the run never finishing.
 */
function run(command, args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let killTimer
    if (timeoutMs !== undefined) {
      killTimer = setTimeout(() => {
        timedOut = true
        child.kill('SIGTERM')
        setTimeout(() => child.kill('SIGKILL'), 2000).unref()
      }, timeoutMs)
      killTimer.unref?.()
    }
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    const done = (result) => {
      clearTimeout(killTimer)
      resolve(result)
    }
    child.on('error', (error) => done({ code: -1, stdout, stderr: String(error), timedOut }))
    child.on('close', (code) => done({ code: code ?? -1, stdout, stderr, timedOut }))
  })
}

/**
 * This script's own package root.
 *
 * Duplicated from src/host/defaults.ts on purpose: this process has to run
 * from a checkout or an installed copy with nothing built, so it cannot import
 * host code that only exists after a bundle. Both walk up to the first package.json.
 */
export function packageRoot(fromUrl = import.meta.url) {
  let dir = dirname(fileURLToPath(fromUrl))
  for (let depth = 0; depth < 8; depth++) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const up = dirname(dir)
    if (up === dir) return dir
    dir = up
  }
  return dir
}

/**
 * Read a source file a code patch wants to add, from inside this package.
 *
 * The spec already requires the reference to sit under patches/, so the
 * containment check below is belt and braces rather than the primary guard. It
 * is here because this process is the one that writes, and a writer that trusts
 * a path it read from a file it does not own is a writer that can be aimed at
 * anything on the disk.
 */
export function readSource(patcherRoot, ref) {
  const root = resolvePath(patcherRoot)
  const file = resolvePath(root, ref)
  if (file !== root && !file.startsWith(root + sep)) {
    return { error: 'the source reference "' + ref + '" resolves outside the patcher package' }
  }
  // existsSync is true for a directory, and readFileSync on one throws EISDIR
  // with a stack instead of the sentence every other unusable reference gets.
  if (!existsSync(file) || !statSync(file).isFile()) {
    return {
      error:
        'there is no file at ' + ref + ' in ' + root +
        '. The spec points at a file this package does not ship.',
    }
  }
  return { text: readFileSync(file, 'utf8'), path: file }
}

/**
 * Whether one whole file is already what the spec wants there.
 *
 * Deliberately a three-way answer rather than a boolean. A missing file and a
 * file whose content differs are both work to do, but they are different
 * situations for a person reading the output, and a patch that adds a file is
 * never satisfied while that file is absent.
 */
export function assessFile(installed, source) {
  if (installed === undefined) return { kind: 'missing' }
  if (installed === source) return { kind: 'already-applied' }
  return { kind: 'differs', installedBytes: Buffer.byteLength(installed), sourceBytes: Buffer.byteLength(source) }
}

/**
 * Drop one edit directory from pnpm's patch bookkeeping.
 *
 * pnpm records every `pnpm patch` directory in .pnpm_patches/state.json, and a
 * `patch-commit` that finds state naming a directory which is not there exits
 * non-zero having printed nothing at all. Removing the directory by hand —
 * which is what a person does when they are cleaning up, and what a previous
 * run of this script did — leaves exactly that state behind, so the failure
 * outlives the thing that caused it. Other entries are other packages'
 * business and are left alone; a file that no longer parses is left alone
 * too, because rewriting pnpm's file on a guess is worse than a stale entry
 * that this same function will clean on the next run.
 */
export function forgetPatchState(editRoot, editDir) {
  const statePath = join(editRoot, 'state.json')
  if (!existsSync(statePath)) return false

  let state
  try {
    state = JSON.parse(readFileSync(statePath, 'utf8'))
  } catch {
    return false
  }
  if (state === null || typeof state !== 'object' || Array.isArray(state)) return false
  if (Object.hasOwn(state, editDir) === false) return false

  delete state[editDir]
  writeFileSync(statePath, JSON.stringify(state, undefined, 2) + '\n')
  return true
}

/**
 * A unified diff that creates a file, for a file the package never had.
 *
 * `pnpm patch-commit` only emits hunks for files the extracted package
 * already contained, so a patch that adds a module comes out of it silently
 * short: the diff is applied, the import lands, and the module is missing —
 * a plugin that fails to load for a reason the patch file does not show.
 * pnpm's own applier accepts this shape, so the hunk is written here and
 * appended to the committed patch.
 *
 * The text is emitted verbatim: a line that does not end in a newline gets
 * git's no-newline marker rather than a silently added one, because a file
 * that gains a byte it never had is a different file.
 */
export function newFileHunk(relativePath, text) {
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  const count = body === '' ? 0 : body.split('\n').length
  const added = count === 0 ? [] : body.split('\n').map((line) => `+${line}`)
  const tail = text.endsWith('\n') || body === '' ? [] : ['\\ No newline at end of file']
  return [
    `diff --git a/${relativePath} b/${relativePath}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${relativePath}`,
    ...(count === 0 ? [] : [`@@ -0,0 +1,${count} @@`]),
    ...added,
    ...tail,
    '',
  ].join('\n')
}

/**
 * Parse-check a file that is already sitting where it will be published.
 *
 * Checking the real path rather than a copy in a temp directory means the
 * package.json that decides whether .js is CommonJS or ESM is the one the file
 * will actually be judged by. A file that only parses under the wrong module
 * system is exactly the failure this exists to catch, and copying it out of
 * the package is what hides it.
 */
function checkSyntaxAt(path) {
  if (!/\.[cm]?js$/.test(path)) return Promise.resolve({ ok: true, stderr: '' })
  return run(process.execPath, ['--check', path], dirname(path)).then((result) => ({
    ok: result.code === 0,
    stderr: result.stderr,
  }))
}

/** How long the load-the-result check is allowed to take. */
export const SMOKE_TIMEOUT_MS = 15_000

/**
 * Load the patched package and see whether it holds together.
 *
 * node --check only proves the bytes parse. It says nothing about whether the
 * module they belong to can be assembled: an injected import of a sibling file
 * that never got written, or a reference to a symbol the upstream release no
 * longer exports, both parse perfectly and fail the moment DSH loads the
 * plugin. So the last gate before committing is loading the thing, with the
 * profile's own node_modules laid out around it so bare imports resolve.
 *
 * The result is a three-way answer, and the third value is the interesting one:
 * a package whose top level does not terminate is reported as skipped, not as
 * a failure. We did not time out because the patch is wrong; we stopped
 * watching, and saying otherwise would be inventing a verdict.
 */
export async function importSmoke(dir, pkg, profileDir) {
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) return { status: 'skipped', detail: 'the extracted copy has no package.json' }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const entry = String(manifest.main ?? 'index.js').replace(/^\.\//, '')
  const entryFile = join(dir, entry)
  if (!existsSync(entryFile)) {
    return { status: 'skipped', detail: 'the package has no ' + entry + ' on disk to load' }
  }

  // Node resolves symlinks to their real path, which would put the module
  // back in the edit directory where its dependencies are not. Laying out a
  // node_modules of symlinks and loading through it with --preserve-symlinks
  // makes the patched copy load exactly as it will once it is installed.
  //
  // Both flags, and the second is the one that was missing: --preserve-symlinks
  // covers what the entry imports, but node still resolves the entry itself to
  // its real path before it is loaded, so an ESM package was being judged with
  // the edit directory as its base rather than the probe. Nothing wrong came of
  // it in practice, because the edit directory sits inside the profile's own
  // node_modules and the ordinary walk finds its dependencies anyway — but the
  // check was reporting on a layout nobody will ever install.
  const probe = mkdtempSync(join(tmpdir(), 'patcher-smoke-'))
  const modules = join(probe, 'node_modules')
  const hostModules = join(profileDir, 'node_modules')
  mkdirSync(modules, { recursive: true })
  try {
    if (existsSync(hostModules)) {
      for (const name of readdirSync(hostModules)) {
        if (name === pkg || name.startsWith('.')) continue
        try {
          symlinkSync(join(hostModules, name), join(modules, name), 'junction')
        } catch {
          // A name that will not link (a broken entry, a permission problem)
          // is exactly the case the load is going to tell us about.
        }
      }
    }
    try {
      symlinkSync(dir, join(modules, pkg), 'junction')
    } catch (error) {
      // Not being able to lay out the probe is not the patch failing to load.
      // Say the check did not happen instead of dressing it up as a verdict.
      return { status: 'skipped', detail: 'the patched copy could not be linked into a probe tree (' + error.code + ')' }
    }
    const result = await run(
      process.execPath,
      ['--preserve-symlinks', '--preserve-symlinks-main', join(modules, pkg, entry)],
      probe,
      SMOKE_TIMEOUT_MS,
    )
    if (result.timedOut) {
      return {
        status: 'skipped',
        detail: pkg + ' did not finish loading within ' + SMOKE_TIMEOUT_MS / 1000 + 's, so it was not judged',
      }
    }
    if (result.code !== 0) {
      return { status: 'failed', detail: (result.stderr.trim() || result.stdout.trim() || 'it exited ' + result.code) }
    }
    return { status: 'ok', detail: pkg + '@' + (manifest.version ?? '?') + ' loaded' }
  } finally {
    rmSync(probe, { recursive: true, force: true })
  }
}

function describeNewFile(text) {
  return text.replace(/\n$/, '').split('\n').map((line) => '+ ' + line).join('\n')
}

export async function main(argv) {
  const args = parseArgs(argv)
  if (args.help) {
    say(HELP)
    return 0
  }
  if (!args.patchId) die('--patch-id is required.\n\n' + HELP)

  const dshHome = args.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const profileDir = args.profileDir ?? join(dshHome, 'profiles', args.profile)
  const specPath = args.spec ? resolvePath(args.spec) : defaultSpecPath(profileDir)
  const patcherRoot = args.patcherRoot ? resolvePath(args.patcherRoot) : packageRoot()

  say('spec:   ' + specPath)
  const config = loadConfig(specPath)

  const matches = (config.patches ?? []).filter((patch) => patch?.id === args.patchId)
  if (matches.length === 0) die('no patch with id "' + args.patchId + '" in ' + specPath)
  if (matches.length > 1) {
    die('the spec has ' + matches.length + ' patches with id "' + args.patchId + '". Ids have to be unique; fix the spec.')
  }

  const patch = matches[0]
  if (patch.enabled === false) die('patch "' + args.patchId + '" is disabled. Enable it first.')
  if (patch.target?.kind !== 'package-file') {
    die('patch "' + args.patchId + '" targets ' + (patch.target?.kind ?? 'nothing') + ', not a package file.')
  }
  const target = patch.target
  if (patch.op?.kind !== 'code') {
    die('patch "' + args.patchId + '" is a ' + (patch.op?.kind ?? 'nothing') + ' operation, not a code edit.')
  }

  // Specs written before a code patch could add files have no files key at all,
  // so both lists are read defensively rather than assuming the current shape.
  const edits = Array.isArray(patch.op.edits) ? patch.op.edits : []
  const addedFiles = (Array.isArray(patch.op.files) ? patch.op.files : []).filter(
    (entry) => typeof entry?.path === 'string' && typeof entry?.source === 'string',
  )
  if (edits.length === 0 && addedFiles.length === 0) {
    die('patch "' + args.patchId + '" has neither edits nor files, so it would not change anything.')
  }
  for (const entry of addedFiles) {
    if (entry.path === target.path) {
      die(
        entry.path + ' is both the target path and an added file. Which of the two wins would be a' +
        ' property of the order they happen to be listed in, so the spec has to pick one.',
      )
    }
  }
  if (args.pkg !== undefined && args.pkg !== target.pkg) {
    die('patch "' + args.patchId + '" targets ' + target.pkg + ', not ' + args.pkg + '.')
  }
  if (typeof target.version !== 'string' || target.version === '') {
    die('a package-file patch must pin a version. Without one, a package upgrade would silently stop being patched.')
  }
  say('patch:  ' + patch.id + ' (' + patch.reason + ')')

  const installedJson = join(profileDir, 'node_modules', target.pkg, 'package.json')
  if (!existsSync(installedJson)) {
    die(target.pkg + ' is not installed in ' + profileDir + '. Install it, or point --profile-dir at the profile that has it.')
  }
  const installed = JSON.parse(readFileSync(installedJson, 'utf8')).version
  if (installed !== target.version) {
    die(
      target.pkg + ' is at ' + installed + ' but the spec was written against ' + target.version +
      '. Rewrite the spec for the version you are running.',
    )
  }
  say(
    'target: ' + target.pkg + '@' + installed + ' :: ' + target.path +
    (edits.length === 0 ? '  (read only; this patch adds files)' : ''),
  )

  const packageDir = join(profileDir, 'node_modules', target.pkg)
  const installedFile = join(packageDir, target.path)
  if (!existsSync(installedFile)) {
    die(target.pkg + ' has no file at ' + target.path + '. Nothing was written.')
  }
  const installedText = readFileSync(installedFile, 'utf8')

  // What the spec wants added, read out of this package. Reading it before the
  // idempotency check is deliberate: a spec that points at a source file this
  // package does not ship has to fail by saying so, not by cheerfully
  // reporting that there is nothing left to do.
  // readSource hands back a `path` of its own: the file it actually opened.
  // Spreading it over the entry would leave the destination pointing at the
  // patcher's own copy, and every later use of this.path — the idempotency
  // check, the write, the report — would follow it there instead of into the
  // package. So the two names are kept apart by hand rather than by spread.
  const sources = addedFiles.map((entry) => {
    const read = readSource(patcherRoot, entry.source)
    return read.error !== undefined
      ? { path: entry.path, ref: entry.source, error: read.error }
      : { path: entry.path, ref: entry.source, text: read.text }
  })
  for (const source of sources) {
    if (source.error !== undefined) die('patch "' + args.patchId + '": ' + source.error)
  }

  // Look at what is installed before reaching for pnpm. This is the common
  // case after a successful run, and answering it here keeps a second run from
  // extracting a whole package to discover there is nothing to do.
  const pending = []
  if (edits.length > 0) {
    const verdict = assessEdits(installedText, edits)
    if (verdict.kind === 'partial') {
      die(
        'only ' + verdict.applied + ' of ' + verdict.total +
        ' edits are in ' + installedFile + '. Re-running would rewrite the ones that are not; apply the rest by hand.',
      )
    }
    if (verdict.kind === 'applicable') {
      pending.push(target.path + '  (' + edits.length + ' edits)')
    } else if (verdict.kind !== 'already-applied') {
      die('the installed file is not what this spec targets: ' + whyNot(installedText, edits))
    }
  }
  for (const source of sources) {
    const onDisk = join(packageDir, source.path)
    const verdict = assessFile(existsSync(onDisk) ? readFileSync(onDisk, 'utf8') : undefined, source.text)
    if (verdict.kind === 'missing') {
      pending.push(source.path + '  (new file, ' + source.ref + ')')
    } else if (verdict.kind === 'differs') {
      pending.push(
        source.path + '  (replacing ' + verdict.installedBytes + ' bytes on disk with ' + verdict.sourceBytes + ' from ' + source.ref + ')',
      )
    }
  }
  if (pending.length === 0) {
    say('')
    say(target.pkg + '@' + installed + ' already carries this change. Nothing to do.')
    return 0
  }
  say('')
  say('to apply:')
  for (const line of pending) say('  ' + line)

  // pnpm extracts into a deterministic directory and refuses to reuse a
  // non-empty one, so a run that died before patch-commit leaves a directory
  // that makes every later run fail. Clearing it is the repair — and clearing
  // only the directory is not enough: pnpm also keeps a bookkeeping entry in
  // .pnpm_patches/state.json, and a commit that finds a state naming a
  // directory that is not there fails without saying why.
  const editRoot = join(profileDir, 'node_modules', '.pnpm_patches')
  const editDir = join(editRoot, target.pkg + '@' + target.version)
  rmSync(editDir, { recursive: true, force: true })
  forgetPatchState(editRoot, editDir)

  const extracted = await run('pnpm', ['patch', target.pkg + '@' + target.version], profileDir)
  if (extracted.code !== 0) {
    process.stderr.write(extracted.stderr)
    die('pnpm patch failed; nothing was written.')
  }
  const dir = extracted.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .reverse()
    .find((line) => existsSync(line))
  if (dir === undefined) {
    die('pnpm patch said it succeeded but printed no directory:\n' + extracted.stdout)
  }
  say('work:   ' + dir)

  const file = join(dir, target.path)
  if (!existsSync(file)) {
    rmSync(dir, { recursive: true, force: true })
    die(target.pkg + ' has no file at ' + target.path + '. Nothing was written.')
  }

  const before = readFileSync(file, 'utf8')
  // Re-check the extracted copy rather than trusting the installed one: pnpm
  // materialises the edit dir from the store, which is the pristine package.
  const refusal = edits.length > 0 ? whyNot(before, edits) : undefined
  if (refusal !== undefined) {
    rmSync(dir, { recursive: true, force: true })
    die(refusal)
  }

  // Everything this patch writes lands in the edit directory first. Nothing has
  // touched the installed package at this point, and nothing will unless all of
  // it clears the checks below, so a failure anywhere from here down is still a
  // run that wrote nothing.
  const written = []
  if (edits.length > 0) {
    const after = applyEdits(before, edits)
    writeFileSync(file, after)
    written.push({ path: target.path, before, after })
  }
  for (const source of sources) {
    const destination = join(dir, source.path)
    const previous = existsSync(destination) ? readFileSync(destination, 'utf8') : undefined
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, source.text)
    written.push({ path: source.path, before: previous, after: source.text })
  }

  for (const entry of written) {
    const syntax = await checkSyntaxAt(join(dir, entry.path))
    if (!syntax.ok) {
      process.stderr.write(syntax.stderr)
      rmSync(dir, { recursive: true, force: true })
      die(entry.path + ' does not parse. Nothing was written.')
    }
  }

  if (args.importSmoke) {
    const smoke = await importSmoke(dir, target.pkg, profileDir)
    if (smoke.status === 'failed') {
      process.stderr.write(smoke.detail + '\n')
      rmSync(dir, { recursive: true, force: true })
      die('the patched package does not load. Nothing was written.')
    }
    say('load:   ' + (smoke.status === 'ok' ? smoke.detail : 'skipped, ' + smoke.detail))
  }

  if (args.dryRun) {
    say('')
    for (const entry of written) {
      say('--- ' + target.pkg + '@' + installed + ' :: ' + entry.path + ' ---')
      say(entry.before === undefined ? describeNewFile(entry.after) : describeChange(entry.before, entry.after))
      say('')
    }
    say('--dry-run: nothing was written.')
    rmSync(dir, { recursive: true, force: true })
    return 0
  }

  const commit = await run('pnpm', ['patch-commit', dir], profileDir)
  if (commit.code !== 0) {
    process.stderr.write(commit.stderr)
    die('pnpm patch-commit failed. The edits are in ' + dir + ' and were not committed.')
  }

  // patch-commit never mentions a file the package did not already have, so
  // every new file this run wrote is appended to the patch by hand. Without
  // it the next install drops the file while keeping the import that needs
  // it, and the plugin stops loading.
  const key = target.pkg + '@' + target.version
  const added = written.filter((entry) => entry.before === undefined)
  if (added.length > 0) {
    const patchFile = join(profileDir, 'patches', key + '.patch')
    if (!existsSync(patchFile)) {
      die('pnpm did not write ' + patchFile + ', so the new file cannot be recorded.')
    }
    const hunks = added
      .map((entry) => newFileHunk(entry.path, entry.after))
      .join('\n')
    appendFileSync(patchFile, hunks)
    say('appended ' + added.map((entry) => entry.path).join(', ') + ' to ' + patchFile)
  }

  const workspacePath = join(profileDir, 'pnpm-workspace.yaml')
  const registered = existsSync(workspacePath) ? readFileSync(workspacePath, 'utf8') : ''
  if (!registered.includes(key)) {
    process.stderr.write(
      'pnpm did not register ' + key + ' under patchedDependencies in ' + workspacePath + '.\n' +
      'Add it by hand as:\n\n  patchedDependencies:\n    ' + key + ': patches/' + key + '.patch\n',
    )
    return 1
  }

  say('')
  say('patched ' + key + ' (' + written.map((entry) => entry.path).join(', ') + ').')

  // patch-commit only writes the patch file and registers it. The copy that
  // is actually installed stays untouched until something installs, so
  // without this step the fix exists on paper and the button did nothing.
  if (!args.install) {
    say('Run `pnpm install` in the profile directory to put it on disk.')
    return 0
  }

  say('installing so the patched copy is the one on disk...')
  const install = await run('pnpm', ['install'], profileDir)
  process.stdout.write(install.stdout)
  process.stderr.write(install.stderr)
  if (install.code !== 0) {
    process.stderr.write('\npnpm install failed. The patch is committed; a later install in ' + profileDir + ' will apply it.\n')
    return 1
  }

  say('Installed. Refresh the page: the client bundle revision is derived from the file on disk, so a reload picks the fix up without a DSH restart.')
  return 0
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2))
}
