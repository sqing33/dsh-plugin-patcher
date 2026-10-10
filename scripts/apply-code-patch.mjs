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
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
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
  const out = { profile: process.env.DSH_PROFILE ?? 'web', dryRun: false, install: false }
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

/**
 * A diff narrow enough to read.
 *
 * Common prefix and common suffix, not a full algorithm: these edits replace a
 * short literal in place, so the changed region is short and this shows all of
 * it. When several edits land far apart the middle is elided rather than
 * silently concatenated, because a diff that hides a change is the one failure
 * mode a dry run exists to rule out.
 */
export function describeChange(before, after) {
  let start = 0
  const shortest = Math.min(before.length, after.length)
  while (start < shortest && before[start] === after[start]) start++
  let end = 0
  while (end < shortest - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++

  const context = 2
  const beforeLines = before.split('\n')
  const startLine = before.slice(0, start).split('\n').length - 1
  const out = []
  if (startLine > context) out.push('  ...')
  for (const line of beforeLines.slice(Math.max(0, startLine - context), startLine)) out.push('  ' + line)
  // When the two texts are the same the differing middle is empty on both
  // sides, and slicing it would print a phantom removed and added line.
  const changed = start < before.length - end || start < after.length - end
  if (changed) {
    for (const line of before.slice(start, before.length - end).split('\n')) out.push('- ' + line)
    for (const line of after.slice(start, after.length - end).split('\n')) out.push('+ ' + line)
  }
  const tailFrom = Math.min(beforeLines.length, beforeLines.length - end)
  for (const line of beforeLines.slice(tailFrom, tailFrom + context)) out.push('  ' + line)
  if (end > context) out.push('  ...')
  return out.join('\n')
}

function run(command, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => resolve({ code: -1, stdout, stderr: String(error) }))
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

function checkSyntax(text, path) {
  if (!/\.[cm]?js$/.test(path)) return Promise.resolve({ ok: true, stderr: '' })
  const dir = mkdtempSync(join(tmpdir(), 'patcher-syntax-'))
  const probe = join(dir, 'probe' + path.slice(path.lastIndexOf('.')))
  writeFileSync(probe, text)
  return run(process.execPath, ['--check', probe], dir).then((result) => {
    rmSync(dir, { recursive: true, force: true })
    return { ok: result.code === 0, stderr: result.stderr }
  })
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
  say('target: ' + target.pkg + '@' + installed + ' :: ' + target.path)

  // Look at what is installed before reaching for pnpm. This is the common
  // case after a successful run, and answering it here keeps a second run from
  // extracting a whole package to discover there is nothing to do.
  const installedFile = join(profileDir, 'node_modules', target.pkg, target.path)
  if (!existsSync(installedFile)) {
    die(target.pkg + ' has no file at ' + target.path + '. Nothing was written.')
  }
  const installedText = readFileSync(installedFile, 'utf8')
  const installedVerdict = assessEdits(installedText, patch.op.edits)
  if (installedVerdict.kind === 'already-applied') {
    say('')
    say(target.pkg + '@' + installed + ' already carries this change. Nothing to do.')
    return 0
  }
  if (installedVerdict.kind === 'partial') {
    die(
      'only ' + installedVerdict.applied + ' of ' + installedVerdict.total +
      ' edits are in ' + installedFile + '. Re-running would rewrite the ones that are not; apply the rest by hand.',
    )
  }
  if (installedVerdict.kind === 'no-match' || installedVerdict.kind === 'many-matches' || installedVerdict.kind === 'empty-find') {
    die('the installed file is not what this spec targets: ' + whyNot(installedText, patch.op.edits))
  }

  // pnpm extracts into a deterministic directory and refuses to reuse a
  // non-empty one, so a run that died before patch-commit leaves a directory
  // that makes every later run fail. Clearing it is the repair.
  const editRoot = join(profileDir, 'node_modules', '.pnpm_patches')
  rmSync(join(editRoot, target.pkg + '@' + target.version), { recursive: true, force: true })

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
  const refusal = whyNot(before, patch.op.edits)
  if (refusal !== undefined) {
    rmSync(dir, { recursive: true, force: true })
    die(refusal)
  }
  const after = applyEdits(before, patch.op.edits)

  const syntax = await checkSyntax(after, target.path)
  if (!syntax.ok) {
    process.stderr.write(syntax.stderr)
    rmSync(dir, { recursive: true, force: true })
    die('the patched file does not parse. Nothing was written.')
  }

  if (args.dryRun) {
    say('')
    say('--- ' + target.pkg + '@' + installed + ' :: ' + target.path + ' ---')
    say(describeChange(before, after))
    say('')
    say('--dry-run: nothing was written.')
    rmSync(dir, { recursive: true, force: true })
    return 0
  }

  writeFileSync(file, after)

  const commit = await run('pnpm', ['patch-commit', dir], profileDir)
  if (commit.code !== 0) {
    process.stderr.write(commit.stderr)
    die('pnpm patch-commit failed. The edits are in ' + dir + ' and were not committed.')
  }

  const workspacePath = join(profileDir, 'pnpm-workspace.yaml')
  const registered = existsSync(workspacePath) ? readFileSync(workspacePath, 'utf8') : ''
  const key = target.pkg + '@' + target.version
  if (!registered.includes(key)) {
    process.stderr.write(
      'pnpm did not register ' + key + ' under patchedDependencies in ' + workspacePath + '.\n' +
      'Add it by hand as:\n\n  patchedDependencies:\n    ' + key + ': patches/' + key + '.patch\n',
    )
    return 1
  }

  say('')
  say('patched ' + key + ' (' + target.path + ').')

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
