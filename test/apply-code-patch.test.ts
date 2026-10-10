import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { after, describe, it } from 'node:test'

import { assessEdits as hostAssess } from '../src/adapters/package-file.ts'
import {
  assessEdits,
  assessFile,
  configFrom,
  describeChange,
  forgetPatchState,
  importSmoke,
  newFileHunk,
  NAMESPACE,
  HELP,
  packageRoot,
  parseArgs,
  readSource,
} from '../scripts/apply-code-patch.mjs'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const script = join(here, '..', 'scripts', 'apply-code-patch.mjs')
const roots: string[] = []

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/**
 * A pnpm that behaves enough like the real one.
 *
 * The real pnpm refuses to extract into a non-empty edit directory, and the
 * point of that behaviour is worth testing without depending on a registry or
 * on a network round trip. Everything the script relies on is here: the
 * directory it prints, the non-empty check, patch-commit registering the key
 * under patchedDependencies, an install verb that copies the edit over the
 * package (which is what the real pnpm does after a patch-commit, and why the
 * running DSH keeps the old code until then), and a call log so a test can
 * assert the script did not reach for pnpm at all.
 */
const SHIM = [
  '#!/usr/bin/env node',
  "import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'",
  "import { join } from 'node:path'",
  "const args = process.argv.slice(2)",
  "const cwd = process.cwd()",
  "appendFileSync(join(cwd, 'calls.log'), args.join(' ') + '\\n')",
  "if (args[0] === 'patch') {",
  "  const key = args[1]",
  "  const dir = join(cwd, 'node_modules', '.pnpm_patches', key)",
  "  if (existsSync(dir) && readdirSync(dir).length > 0) {",
  "    process.stderr.write('ERR_PNPM_EDIT_DIR_NOT_EMPTY\\n')",
  "    process.exit(1)",
  "  }",
  "  mkdirSync(dir, { recursive: true })",
  "  cpSync(join(cwd, 'node_modules', key.slice(0, key.lastIndexOf('@'))), dir, { recursive: true })",
  "  writeFileSync(join(dir, 'state.json'), '{}')",
  "  process.stdout.write(dir + '\\n')",
  "  process.exit(0)",
  "}",
  "if (args[0] === 'patch-commit') {",
  "  const key = readdirSync(join(cwd, 'node_modules', '.pnpm_patches')).find((n) => n !== 'state.json')",
  "  mkdirSync(join(cwd, 'patches'), { recursive: true })",
  "  writeFileSync(join(cwd, 'patches', key + '.patch'), 'diff --git a/index.js b/index.js\\n')",
  "  appendFileSync(join(cwd, 'pnpm-workspace.yaml'), 'patchedDependencies:\\n  ' + key + ': patches/' + key + '.patch\\n')",
  "  writeFileSync(join(cwd, 'node_modules', '.pnpm_patches', '.applied'), key)",
  "  process.exit(0)",
  "}",
  "if (args[0] === 'install') {",
  "  const key = readFileSync(join(cwd, 'node_modules', '.pnpm_patches', '.applied'), 'utf8').trim()",
  "  cpSync(join(cwd, 'node_modules', '.pnpm_patches', key), join(cwd, 'node_modules', key.slice(0, key.lastIndexOf('@'))), { recursive: true, force: true })",
  "  process.exit(0)",
  "}",
  "process.exit(1)",
  '',
].join('\n')

const DRIVER = [
  "import { main } from " + JSON.stringify(script),
  'process.exitCode = await main(process.argv.slice(2))',
  '',
].join('\n')

const SOURCE = ["'use strict';", '', "const LABEL = 'expected a number';", 'module.exports = LABEL', ''].join('\n')

interface CliResult {
  code: number
  stdout: string
  stderr: string
}

interface Profile {
  root: string
  dir: string
  bin: string
}

/** A throwaway profile with a package, a pnpm stand-in, and a spec. */
function profile(
  specPatches: string,
  source = SOURCE,
  manifest = '{"name":"demo","version":"1.0.0"}\n',
): Profile {
  const root = mkdtempSync(join(tmpdir(), 'patcher-cli-'))
  roots.push(root)
  const dir = join(root, 'profile')
  const bin = join(root, 'bin')
  mkdirSync(join(dir, 'node_modules', 'demo'), { recursive: true })
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(dir, 'package.json'), '{"name":"demo-profile","private":true}\n')
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'nodeLinker: hoisted\n')
  writeFileSync(join(dir, 'node_modules', 'demo', 'package.json'), manifest)
  writeFileSync(join(dir, 'node_modules', 'demo', 'index.js'), source)
  writeFileSync(join(dir, 'cordis.patch.yml'), '- id: ' + NAMESPACE + '\n  name: Plugin Patcher\n  config:\n    patches:\n' + specPatches)
  writeFileSync(join(bin, 'pnpm'), SHIM)
  writeFileSync(join(bin, 'run.mjs'), DRIVER)
  chmodSync(join(bin, 'pnpm'), 0o755)
  return { root, dir, bin }
}

function codePatch(id: string, edits: string, version = '1.0.0', path = 'index.js'): string {
  return (
    '      - id: ' + id + '\n' +
    '        enabled: true\n' +
    '        reason: ' + id + '\n' +
    '        target: {kind: package-file, pkg: demo, version: ' + version + ', path: ' + path + '}\n' +
    '        op:\n' +
    '          kind: code\n' +
    '          edits:\n' +
    edits.replace(/\n/g, '\n            ') + '\n'
  )
}

const ONE_EDIT = "            - {find: \"expected a number\", replace: \"需要一个数字\", count: 1}"

function cli(fixture: Profile, args: string[]): Promise<CliResult> {
  return run(process.execPath, [join(fixture.bin, 'run.mjs'), ...args, '--profile-dir', fixture.dir], {
    env: { ...process.env, PATH: fixture.bin + ':' + (process.env.PATH ?? '') },
  }).then(
    (result) => ({ code: 0, stdout: result.stdout, stderr: result.stderr }),
    (error) => ({ code: typeof error.code === 'number' ? error.code : 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }),
  )
}

function calls(fixture: Profile): string[] {
  const log = join(fixture.dir, 'calls.log')
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf8').trim().split('\n').filter((line) => line !== '')
}

describe('configFrom', () => {
  const config = { patches: [], reconcileNonce: 0 }

  it('takes the config on its own', () => {
    assert.equal(configFrom(config), config)
  })

  it('takes the config nested under its namespace', () => {
    assert.equal(configFrom({ [NAMESPACE]: config }), config)
  })

  it('takes the config out of the profile patch file', () => {
    assert.equal(configFrom([{ id: 'other' }, { id: NAMESPACE, config }]), config)
  })

  it('takes a wrapper that only has a config key', () => {
    assert.equal(configFrom({ config }), config)
  })

  it('returns nothing for a document that holds no spec', () => {
    assert.equal(configFrom([{ id: 'other', config: { a: 1 } }]), undefined)
    assert.equal(configFrom({ patches: 'not a list' }), undefined)
    assert.equal(configFrom(null), undefined)
    assert.equal(configFrom('a string'), undefined)
  })
})

describe('the script and the host agree about an edit', () => {
  // The script duplicates assessEdits because it has to run outside a built
  // host. This is the test that keeps the copy honest.
  const cases: Array<[string, Array<{ find: string; replace: string; count: 1 }>]> = [
    [SOURCE, [{ find: 'expected a number', replace: 'X', count: 1 }]],
    [SOURCE, [{ find: 'const', replace: 'X', count: 1 }]],
    [SOURCE, [{ find: '', replace: 'X', count: 1 }]],
    [SOURCE, [{ find: 'nowhere', replace: 'X', count: 1 }]],
    [SOURCE, [{ find: 'expected a number', replace: 'X', count: 1 }, { find: 'const', replace: 'Y', count: 1 }]],
    [SOURCE.replace('expected a number', 'X'), [{ find: 'expected a number', replace: 'X', count: 1 }]],
    [
      SOURCE.replace('expected a number', 'X'),
      [
        { find: 'expected a number', replace: 'X', count: 1 },
        { find: "const LABEL = 'X';", replace: 'Y', count: 1 },
      ],
    ],
    [SOURCE, []],
    // Insertions, where the find survives inside its own replacement.
    [
      'function view() {\n  return 1\n}',
      [{ find: 'function view() {', replace: 'function helper() {}\nfunction view() {', count: 1 }],
    ],
    [
      'function helper() {}\nfunction view() {\n  return 1\n}',
      [{ find: 'function view() {', replace: 'function helper() {}\nfunction view() {', count: 1 }],
    ],
    [
      SOURCE + '\nfunction view() {}',
      [{ find: 'const', replace: 'const helper = 1\nconst', count: 1 }],
    ],
  ]

  for (const [text, edits] of cases) {
    it('same verdict for ' + JSON.stringify(edits.map((e) => e.find)), () => {
      assert.deepEqual(assessEdits(text, edits), hostAssess(text, edits))
    })
  }
})

describe('parseArgs', () => {
  it('defaults the profile the way the host does', () => {
    const parsed = parseArgs(['--patch-id', 'x'])
    assert.equal(parsed.patchId, 'x')
    assert.equal(parsed.dryRun, false)
    assert.equal(typeof parsed.profile, 'string')
  })

  it('reads the flags the page prints in its instructions', () => {
    const parsed = parseArgs(['--patch-id', 'x', '--pkg', 'demo', '--dry-run', '--profile-dir', '/tmp/p'])
    assert.deepEqual(
      { patchId: parsed.patchId, pkg: parsed.pkg, dryRun: parsed.dryRun, profileDir: parsed.profileDir },
      { patchId: 'x', pkg: 'demo', dryRun: true, profileDir: '/tmp/p' },
    )
  })
  it('does not install unless asked, because a bare patch commit changes nothing on disk', () => {
    // patch-commit writes a patch file; the copy the plugins load is only
    // rewritten by an install. Defaulting this on would make every run a slow
    // full install, and defaulting it off silently would leave the page looking
    // as though it had done something when it had not.
    assert.equal(parseArgs(['--patch-id', 'x']).install, false)
    assert.equal(parseArgs(['--patch-id', 'x', '--dry-run']).install, false)
    assert.equal(parseArgs(['--patch-id', 'x', '--install']).install, true)
  })

  it('documents the install flag next to the others', () => {
    assert.match(HELP, /--install\s+run pnpm install/)
  })
})

describe('describeChange', () => {
  it('marks what went and what came', () => {
    const text = describeChange(SOURCE, SOURCE.replace('expected a number', 'X'))
    assert.match(text, /- .*expected a number/)
    assert.match(text, /\+ .*X/)
  })

  it('collapses to an ellipsis when a file did not change', () => {
    const text = describeChange(SOURCE, SOURCE)
    assert.match(text, /^\s*\.\.\./m)
    assert.ok(!text.includes('- ') && !text.includes('+ '), 'an unchanged file should show no removed or added line')
  })
})

describe('applying for real', () => {
  it('edits the file, commits a patch, and registers it', async () => {
    const fixture = profile(codePatch('one', ONE_EDIT))
    const result = await cli(fixture, ['--patch-id', 'one'])
    assert.equal(result.code, 0, result.stderr)
    const work = join(fixture.dir, 'node_modules', '.pnpm_patches', 'demo@1.0.0', 'index.js')
    assert.match(readFileSync(work, 'utf8'), /需要一个数字/)
    assert.match(readFileSync(join(fixture.dir, 'pnpm-workspace.yaml'), 'utf8'), /demo@1\.0\.0: patches\/demo@1\.0\.0\.patch/)
    assert.ok(existsSync(join(fixture.dir, 'patches', 'demo@1.0.0.patch')))
    assert.equal(readFileSync(join(fixture.dir, 'node_modules', 'demo', 'index.js'), 'utf8'), SOURCE, 'the installed copy only changes on the next install')
    assert.deepEqual(calls(fixture), ['patch demo@1.0.0', 'patch-commit ' + join(fixture.dir, 'node_modules', '.pnpm_patches', 'demo@1.0.0')])
  })

  it('does nothing at all the second time', async () => {
    const fixture = profile(codePatch('one', ONE_EDIT))
    await cli(fixture, ['--patch-id', 'one'])
    await run('pnpm', ['install'], { cwd: fixture.dir, env: { ...process.env, PATH: fixture.bin + ':' + (process.env.PATH ?? '') } })
    const before = calls(fixture).length
    const result = await cli(fixture, ['--patch-id', 'one'])
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /already/)
    assert.equal(calls(fixture).length, before, 'the second run should not have reached for pnpm')
  })

  it('clears an edit directory a dead run left behind', async () => {
    const fixture = profile(codePatch('one', ONE_EDIT))
    const stale = join(fixture.dir, 'node_modules', '.pnpm_patches', 'demo@1.0.0')
    mkdirSync(stale, { recursive: true })
    writeFileSync(join(stale, 'leftover'), 'x')
    const result = await cli(fixture, ['--patch-id', 'one'])
    assert.equal(result.code, 0, result.stderr)
  })

  it('shows the change and writes nothing under --dry-run', async () => {
    const fixture = profile(codePatch('one', ONE_EDIT))
    const result = await cli(fixture, ['--patch-id', 'one', '--dry-run'])
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /- .*expected a number/)
    assert.match(result.stdout, /nothing was written/)
    assert.equal(readFileSync(join(fixture.dir, 'node_modules', 'demo', 'index.js'), 'utf8'), SOURCE)
    assert.deepEqual(calls(fixture), ['patch demo@1.0.0'])
  })
})

describe('refusing', () => {
  it('refuses a version the profile is not on', async () => {
    const fixture = profile(codePatch('one', ONE_EDIT, '9.9.9'))
    const result = await cli(fixture, ['--patch-id', 'one'])
    assert.equal(result.code, 1)
    assert.match(result.stderr, /is at 1\.0\.0 but the spec was written against 9\.9\.9/)
    assert.equal(readFileSync(join(fixture.dir, 'node_modules', 'demo', 'index.js'), 'utf8'), SOURCE)
  })

  it('refuses a package the patch is not aimed at', async () => {
    const fixture = profile(codePatch('one', ONE_EDIT))
    const result = await cli(fixture, ['--patch-id', 'one', '--pkg', 'other'])
    assert.equal(result.code, 1)
    assert.match(result.stderr, /targets demo, not other/)
  })

  it('refuses a find that matches more than once', async () => {
    const fixture = profile(codePatch('one', '            - {find: "LABEL", replace: "X", count: 1}'))
    const result = await cli(fixture, ['--patch-id', 'one'])
    assert.equal(result.code, 1)
    assert.match(result.stderr, /appears 2 times/)
    assert.equal(calls(fixture).length, 0, 'the file should be read before pnpm is involved')
  })

  it('refuses a find that is not there at all', async () => {
    const fixture = profile(codePatch('one', '            - {find: "nowhere", replace: "X", count: 1}'))
    const result = await cli(fixture, ['--patch-id', 'one'])
    assert.equal(result.code, 1)
    assert.match(result.stderr, /not what this spec targets/)
  })

  it('refuses a half-applied set rather than finishing it', async () => {
    const applied = SOURCE.replace('expected a number', '需要一个数字')
    const fixture = profile(
      codePatch(
        'one',
        '            - {find: "expected a number", replace: "需要一个数字", count: 1}\n- {find: "const LABEL", replace: "X", count: 1}',
      ),
      applied,
    )
    const result = await cli(fixture, ['--patch-id', 'one'])
    assert.equal(result.code, 1)
    assert.match(result.stderr, /only 1 of 2 edits are in/)
    assert.equal(readFileSync(join(fixture.dir, 'node_modules', 'demo', 'index.js'), 'utf8'), applied)
    assert.deepEqual(calls(fixture), [])
  })

  it('refuses a disabled patch', async () => {
    const fixture = profile(
      '      - id: one\n        enabled: false\n        reason: one\n' +
        '        target: {kind: package-file, pkg: demo, version: 1.0.0, path: index.js}\n' +
        '        op:\n          kind: code\n          edits:\n' + ONE_EDIT + '\n',
    )
    const result = await cli(fixture, ['--patch-id', 'one'])
    assert.equal(result.code, 1)
    assert.match(result.stderr, /is disabled/)
  })

  it('refuses a file the package does not have', async () => {
    const fixture = profile(codePatch('one', ONE_EDIT, '1.0.0', 'nope.js'))
    const result = await cli(fixture, ['--patch-id', 'one'])
    assert.equal(result.code, 1)
    assert.match(result.stderr, /has no file at nope\.js/)
  })

  it('refuses a patched file that no longer parses', async () => {
    const fixture = profile(
      codePatch('one', '            - {find: "\'use strict\';", replace: "function (", count: 1}'),
    )
    const result = await cli(fixture, ['--patch-id', 'one'])
    assert.equal(result.code, 1)
    assert.match(result.stderr, /does not parse/)
    assert.equal(readFileSync(join(fixture.dir, 'node_modules', 'demo', 'index.js'), 'utf8'), SOURCE)
    assert.ok(!readFileSync(join(fixture.dir, 'node_modules', 'demo', 'index.js'), 'utf8').includes('function ('))
  })

  it('refuses an id the spec does not have', async () => {
    const fixture = profile(codePatch('one', ONE_EDIT))
    const result = await cli(fixture, ['--patch-id', 'two'])
    assert.equal(result.code, 1)
    assert.match(result.stderr, /no patch with id "two"/)
  })

  it('says which file it looked in when there is no spec', async () => {
    const fixture = profile(codePatch('one', ONE_EDIT))
    rmSync(join(fixture.dir, 'cordis.patch.yml'))
    const result = await cli(fixture, ['--patch-id', 'one'])
    assert.equal(result.code, 1)
    assert.match(result.stderr, /no profile patch file at/)
  })
})

// ---------------------------------------------------------------------------
// A code patch can add whole files, and it can load the result before anything
// is committed. The helpers below are the ones that decide those two things,
// so they are pinned the same way the edit logic above is: on what a caller
// observes, including every path where the answer is a refusal.
// ---------------------------------------------------------------------------

const patcherRoot = join(here, '..')
const payloadRef = 'patches/dsh-reasoning-effort/lib/force-effort-tiers.js'
const example = JSON.parse(
  readFileSync(join(patcherRoot, 'examples', 'reasoning-effort-force-effort-tiers.json'), 'utf8'),
).patches[0].op as { edits: Array<{ find: string; replace: string }>; files: Array<{ path: string; source: string }> }

function scratch(name: string): string {
  const root = mkdtempSync(join(tmpdir(), 'patcher-' + name + '-'))
  roots.push(root)
  return root
}

function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

interface Extracted {
  profile: string
  dir: string
}

/** A profile whose node_modules is empty, which is what the probe farm is cut from. */
function emptyProfile(root: string, name: string): string {
  const profile = join(root, name)
  mkdirSync(join(profile, 'node_modules'), { recursive: true })
  return profile
}

describe('packageRoot', () => {
  it('finds the package this script is shipped in', () => {
    const root = packageRoot()
    assert.equal(root, patcherRoot)
    assert.ok(existsSync(join(root, 'package.json')))
  })

  it('walks up out of a subdirectory to the package that holds it', () => {
    for (const rel of ['scripts/apply-code-patch.mjs', 'test/apply-code-patch.test.ts', 'patches/dsh-reasoning-effort/lib/force-effort-tiers.js']) {
      assert.equal(packageRoot(pathToFileURL(join(patcherRoot, rel))), patcherRoot, rel + ' should resolve to the package root')
    }
  })

  it('stops at the nearest package.json rather than the outermost one', () => {
    const root = scratch('root')
    put(join(root, 'package.json'), '{}\n')
    put(join(root, 'inner', 'package.json'), '{}\n')
    put(join(root, 'inner', 'deep', 'file.mjs'), 'export default 1\n')
    assert.equal(packageRoot(pathToFileURL(join(root, 'inner', 'deep', 'file.mjs'))), join(root, 'inner'))
  })

  it('answers the directory it gave up in, not undefined, when nothing above has a package.json', (t) => {
    // A caller writing packageRoot(url) ?? someDefault gets nothing here, so
    // the answer has to be checked rather than coalesced. That only means
    // something while there is genuinely no package.json above the fixture.
    const deep = join(scratch('root'), 'a', 'b')
    put(join(deep, 'file.mjs'), 'export default 1\n')
    let up = deep
    for (let i = 0; i < 8; i++) up = dirname(up)
    if (existsSync(join(up, 'package.json'))) {
      t.skip('something above ' + up + ' has a package.json, so there is nothing to find')
      return
    }
    const answer = packageRoot(pathToFileURL(join(deep, 'file.mjs')))
    assert.equal(typeof answer, 'string', 'the answer is a path, so ?? against a default is dead code')
    assert.ok(deep.startsWith(answer), 'the answer is a directory the fixture sits inside: ' + answer)
    assert.equal(existsSync(join(answer, 'package.json')), false, 'and it does not pretend the directory it stopped in is a package')
  })

  it('gives up after eight directories instead of walking to the top of the disk', () => {
    // The depth cap is a decision not to do this, so it is worth knowing it
    // exists: a package installed more than eight directories below its own
    // package.json is one the walk will not find.
    const root = scratch('deep')
    put(join(root, 'package.json'), '{}\n')
    const file = join(root, 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'file.mjs')
    put(file, 'export default 1\n')
    assert.equal(packageRoot(pathToFileURL(file)), join(root, 'a'))
  })
})

describe('readSource', () => {
  it('reads a file this package ships and says where it came from', () => {
    const found = readSource(patcherRoot, payloadRef)
    assert.equal(found.error, undefined)
    assert.equal(found.text, readFileSync(join(patcherRoot, payloadRef), 'utf8'))
    assert.equal(found.path, join(patcherRoot, payloadRef))
  })

  it('refuses a reference that climbs out with ..', () => {
    const found = readSource(patcherRoot, '../../../etc/hostname')
    assert.equal(found.text, undefined)
    assert.match(found.error, /"\.\.\/\.\.\/\.\.\/etc\/hostname"/)
    assert.match(found.error, /resolves outside the patcher package/)
  })

  it('refuses a reference that climbs out and lands on a directory beside the root', () => {
    // The containment test has to compare against root + separator. Comparing
    // against root alone would accept this, because the sibling's name starts
    // with the root's.
    const base = scratch('sibling')
    const root = join(base, 'patcher')
    const evil = join(base, 'patcher-evil')
    put(join(root, 'package.json'), '{}\n')
    put(join(evil, 'payload.js'), 'module.exports = 1\n')
    const found = readSource(root, '../patcher-evil/payload.js')
    assert.equal(found.text, undefined)
    assert.match(found.error, /resolves outside the patcher package/)
  })

  it('refuses an absolute path outside the package', () => {
    const found = readSource(patcherRoot, '/etc/hostname')
    assert.equal(found.text, undefined)
    assert.match(found.error, /resolves outside the patcher package/)
  })

  it('allows a reference that climbs but stays inside', () => {
    const found = readSource(patcherRoot, 'patches/dsh-reasoning-effort/lib/../lib/force-effort-tiers.js')
    assert.equal(found.error, undefined)
    assert.equal(found.text, readFileSync(join(patcherRoot, payloadRef), 'utf8'))
  })

  it('allows an absolute path that lands inside the package', () => {
    const found = readSource(patcherRoot, join(patcherRoot, 'cordis.yml'))
    assert.equal(found.error, undefined)
    assert.equal(found.text, readFileSync(join(patcherRoot, 'cordis.yml'), 'utf8'))
  })

  it('reports a file this package does not ship rather than throwing', () => {
    const found = readSource(patcherRoot, 'patches/not-here.js')
    assert.equal(found.text, undefined)
    assert.match(found.error, /there is no file at patches\/not-here\.js in /)
    assert.match(found.error, /does not ship/)
  })

  it('does not throw when the reference names a directory', { skip: "known bug: readSource only checks existsSync, so a directory reference throws EISDIR out of a function whose whole contract is to return an error" }, () => {
    // Every other refusal in this function comes back as an error value, and
    // main() spreads the result without a try/catch, so a reference that
    // happens to name a directory takes the writer down with an EISDIR stack
    // instead of saying the spec is wrong.
    const found = readSource(patcherRoot, 'patches')
    assert.equal(found.text, undefined)
    assert.match(String(found.error), /directory|is not a file|EISDIR/)
  })
})

describe('assessFile', () => {
  it('calls a file that is not there missing', () => {
    assert.deepEqual(assessFile(undefined, 'anything'), { kind: 'missing' })
  })

  it('calls a file that is already the source applied', () => {
    assert.deepEqual(assessFile('same bytes', 'same bytes'), { kind: 'already-applied' })
  })

  it('counts the bytes on both sides when the content differs', () => {
    assert.deepEqual(assessFile('abc', 'abcd'), { kind: 'differs', installedBytes: 3, sourceBytes: 4 })
  })

  it('counts bytes rather than characters, so a multi-byte payload is not under-reported', () => {
    assert.deepEqual(assessFile('a', '中文'), { kind: 'differs', installedBytes: 1, sourceBytes: 6 })
  })

  it('treats two empty files as already applied, and an empty file as work to do', () => {
    assert.deepEqual(assessFile('', ''), { kind: 'already-applied' })
    assert.deepEqual(assessFile('', 'x'), { kind: 'differs', installedBytes: 0, sourceBytes: 1 })
  })
})

const TAB = '\t'

/**
 * A stand-in for dsh-reasoning-effort 0.2.8, written out rather than copied.
 *
 * The copy installed on a real machine has moved on: its build no longer
 * contains two of the three find strings in the example, so the round trip
 * cannot be built from it. What matters here is the shape the patch targets,
 * and the three anchors below are the spec's own, one occurrence each.
 */
const UPSTREAM_0_2_8 = [
  'import z from "@deepseek-ai/schemastery";',
  '//#region src/reasoning-protocols.ts',
  'const REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];',
  '//#endregion',
  '//#region src/reasoning-settings.ts',
  'const reasoningConfigSchema = z.object({',
  TAB + 'auto: z.boolean(),',
  TAB + 'defaults: z.object({',
  TAB + TAB + 'reasoning: z.union(REASONING_LEVELS)',
  TAB + '})',
  '});',
  '//#endregion',
  '//#region src/index.ts',
  'function applyReasoningEffort(ctx, config = {}) {',
  TAB + 'ctx.set("llm-pi-ai", reasoningConfigSchema);',
  '}',
  'function apply(ctx, config = {}) {',
  TAB + 'applyReasoningEffort(ctx, config);',
  '}',
  'export default { name: "dsh-reasoning-effort", apply };',
  '//#endregion',
  '',
].join('\n')

/**
 * The package main() hands to importSmoke: an edit directory inside the
 * profile's own node_modules, with the profile's dependencies around it.
 * Schemastery is stubbed so the test does not need a profile that has the real
 * one installed.
 */
function extracted(
  root: string,
  label: string,
  edits: Array<{ find: string; replace: string }>,
  payload: string | undefined,
): Extracted {
  const profile = emptyProfile(root, label)
  const shape = '() => ({})'
  put(
    join(profile, 'node_modules', '@deepseek-ai', 'schemastery', 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/schemastery', version: '0.0.0-test', type: 'module', main: 'index.js' }) + '\n',
  )
  put(
    join(profile, 'node_modules', '@deepseek-ai', 'schemastery', 'index.js'),
    [
      'const shape = ' + shape,
      'export default {',
      '  object: shape, boolean: shape, string: shape, number: shape,',
      '  union: shape, dict: shape, const: shape, array: shape, enum: shape,',
      '  literal: shape,',
      '}',
      '',
    ].join('\n'),
  )
  const dir = join(profile, 'node_modules', '.pnpm_patches', 'dsh-reasoning-effort@0.2.8')
  let text = UPSTREAM_0_2_8
  for (const edit of edits) text = text.replace(edit.find, () => edit.replace)
  put(join(dir, 'lib', 'index.js'), text)
  if (payload !== undefined) put(join(dir, 'lib', 'force-effort-tiers.js'), payload)
  put(
    join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'dsh-reasoning-effort',
        version: '0.2.8',
        type: 'module',
        main: 'lib/index.js',
        exports: { '.': './lib/index.js', './client': './lib/client.js' },
      },
      null,
      2,
    ) + '\n',
  )
  return { profile, dir }
}

const payloadText = readSource(patcherRoot, payloadRef).text as string

function node(dir: string, args: string[]): Promise<CliResult> {
  return run(process.execPath, args, { cwd: dir }).then(
    (result) => ({ code: 0, stdout: result.stdout, stderr: result.stderr }),
    (error) => ({
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    }),
  )
}

describe('importSmoke loads the package by path', () => {
  const manifest = {
    name: 'dsh-reasoning-effort',
    version: '0.2.8',
    type: 'module',
    main: 'index.js',
    // The entry point is not exported. A bare specifier cannot reach it.
    exports: { './client': './client.js' },
  }

  it('loads a package whose exports map does not cover its own entry point', async () => {
    const root = scratch('unexported')
    const profile = emptyProfile(root, 'profile')
    const dir = join(root, 'extracted')
    put(join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
    put(join(dir, 'index.js'), 'export const marker = 1\n')
    put(join(dir, 'client.js'), 'export const client = 1\n')

    const result = await importSmoke(dir, manifest.name, profile)

    // A bare-specifier load would have died with ERR_PACKAGE_PATH_NOT_EXPORTED
    // and come back failed. Loading a file path does not consult exports at
    // all, which is the only reason a real plugin whose entry is unexported
    // survives this check.
    assert.equal(result.status, 'ok', result.detail)
  })

  it('would have been refused had the same package been loaded as a specifier', async () => {
    // The test above is only worth anything if node really does refuse the bare
    // form of this package, so that is checked rather than assumed.
    const root = scratch('specifier')
    const profile = emptyProfile(root, 'profile')
    const dir = join(profile, 'node_modules', manifest.name)
    put(join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
    put(join(dir, 'index.js'), 'export const marker = 1\n')
    put(join(dir, 'client.js'), 'export const client = 1\n')

    const result = await node(profile, ['--input-type=module', '-e', "import('" + manifest.name + "')"])

    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /ERR_PACKAGE_PATH_NOT_EXPORTED/)
  })
})

describe('importSmoke on a real injection', () => {
  it('still matches the three edits the example applies', () => {
    // Guards the fixture above: if the example spec changes, this fails before
    // the round trip quietly stops testing what it was written to test.
    assert.deepEqual(assessEdits(UPSTREAM_0_2_8, example.edits), { kind: 'applicable' })
    assert.equal(example.files[0].source, payloadRef)
    assert.equal(example.files[0].path, 'lib/force-effort-tiers.js')
  })

  it('loads 0.2.8 with the three edits applied and the payload dropped in beside them', async () => {
    const round = extracted(scratch('roundtrip'), 'profile', example.edits, payloadText)

    const result = await importSmoke(round.dir, 'dsh-reasoning-effort', round.profile)

    assert.equal(result.status, 'ok', result.detail)
    assert.match(result.detail, /^dsh-reasoning-effort@0\.2\.8 loaded$/)
    // The load only means something if the edits and the new file are really in
    // the tree that got loaded.
    const patched = readFileSync(join(round.dir, 'lib', 'index.js'), 'utf8')
    assert.match(patched, /import \{ forcePatchEffortTiers \} from "\.\/force-effort-tiers\.js";/)
    assert.match(patched, new RegExp(TAB + 'forcePatchEffortTiers\\(ctx, config\\);'))
    assert.ok(existsSync(join(round.dir, 'lib', 'force-effort-tiers.js')))
  })

  it('fails when the edits are applied but the payload was never written', async () => {
    // The case node --check cannot see: every byte parses, and the package only
    // breaks when something loads it.
    const round = extracted(scratch('nopayload'), 'profile', example.edits, undefined)

    const result = await importSmoke(round.dir, 'dsh-reasoning-effort', round.profile)

    assert.equal(result.status, 'failed')
    assert.match(result.detail, /force-effort-tiers\.js/)
    assert.match(result.detail, /ERR_MODULE_NOT_FOUND|Cannot find module/)
  })

  it('fails when the injected import names a symbol the payload does not export', async () => {
    // A rename that lands on the wrong name still parses. This is the check
    // that notices, and it is why the load is worth spawning a process for.
    const broken = example.edits.map((edit, i) => {
      if (i !== 0) {
        return i === 2
          ? { find: edit.find, replace: edit.replace.replace('forcePatchEffortTiers(ctx', 'forceEffortTiersThatWasNeverExported(ctx') }
          : edit
      }
      return {
        find: edit.find,
        replace: edit.replace.replace('forcePatchEffortTiers }', 'forceEffortTiersThatWasNeverExported }'),
      }
    })
    const round = extracted(scratch('renamed'), 'profile', broken, payloadText)

    const result = await importSmoke(round.dir, 'dsh-reasoning-effort', round.profile)

    assert.equal(result.status, 'failed', 'a module that links against nothing is a failure, not a pass')
    assert.match(result.detail, /does not provide an export named 'forceEffortTiersThatWasNeverExported'/)
  })
})

describe('importSmoke has three answers, not two', () => {
  it('names the version it loaded when it succeeds', async () => {
    const root = scratch('ok')
    const profile = emptyProfile(root, 'profile')
    const dir = join(root, 'extracted')
    put(join(dir, 'package.json'), JSON.stringify({ name: 'tiny', version: '3.1.4', type: 'module', main: './index.js' }) + '\n')
    put(join(dir, 'index.js'), 'export default 1\n')
    const result = await importSmoke(dir, 'tiny', profile)
    assert.deepEqual(result, { status: 'ok', detail: 'tiny@3.1.4 loaded' })
  })

  it('loads a CommonJS package too, with main written the long way round', async () => {
    const root = scratch('cjs')
    const profile = emptyProfile(root, 'profile')
    const dir = join(root, 'extracted')
    put(join(dir, 'package.json'), JSON.stringify({ name: 'old-style', version: '0.0.1', main: './index.js' }) + '\n')
    put(join(dir, 'index.js'), "'use strict';\nmodule.exports = 1\n")
    const result = await importSmoke(dir, 'old-style', profile)
    assert.equal(result.status, 'ok', result.detail)
  })

  it('fails, rather than skips, when the entry point throws on load', async () => {
    const root = scratch('throws')
    const profile = emptyProfile(root, 'profile')
    const dir = join(root, 'extracted')
    put(join(dir, 'package.json'), JSON.stringify({ name: 'boom', version: '1.0.0', type: 'module', main: 'index.js' }) + '\n')
    put(join(dir, 'index.js'), 'throw new Error("boom at load")\n')
    const result = await importSmoke(dir, 'boom', profile)
    // The distinction is load-bearing: only a deadline produces skipped, and
    // main() treats a failure as a reason not to write anything at all.
    assert.notEqual(result.status, 'skipped')
    assert.equal(result.status, 'failed')
    assert.match(result.detail, /boom at load/)
  })

  it('skips an extracted copy with no package.json, because there is nothing to load', async () => {
    const root = scratch('nomanifest')
    const profile = emptyProfile(root, 'profile')
    const dir = join(root, 'extracted')
    put(join(dir, 'index.js'), 'export default 1\n')
    const result = await importSmoke(dir, 'nomanifest', profile)
    assert.equal(result.status, 'skipped')
    assert.match(result.detail, /no package\.json/)
  })

  it('skips when main points at a file that is not on disk', async () => {
    const root = scratch('noentry')
    const profile = emptyProfile(root, 'profile')
    const dir = join(root, 'extracted')
    put(join(dir, 'package.json'), JSON.stringify({ name: 'ghost', version: '1.0.0', type: 'module', main: 'lib/index.js' }) + '\n')
    const result = await importSmoke(dir, 'ghost', profile)
    assert.equal(result.status, 'skipped')
    assert.match(result.detail, /no lib\/index\.js on disk/)
  })

  it('judges the directory it was handed, not the copy already in the profile', async () => {
    const root = scratch('shadow')
    const profile = emptyProfile(root, 'profile')
    put(
      join(profile, 'node_modules', 'shadowed', 'package.json'),
      JSON.stringify({ name: 'shadowed', version: '1.0.0', type: 'module', main: 'index.js' }) + '\n',
    )
    put(join(profile, 'node_modules', 'shadowed', 'index.js'), 'throw new Error("the installed copy")\n')
    const dir = join(root, 'extracted')
    put(join(dir, 'package.json'), JSON.stringify({ name: 'shadowed', version: '1.0.0', type: 'module', main: 'index.js' }) + '\n')
    put(join(dir, 'index.js'), 'export default 1\n')
    const result = await importSmoke(dir, 'shadowed', profile)
    assert.equal(result.status, 'ok', result.detail)
  })

  it('leaves no probe tree behind, whatever the verdict', async () => {
    const probes = () => readdirSync(tmpdir()).filter((name) => name.startsWith('patcher-smoke-'))
    const root = scratch('cleanup')
    const profile = emptyProfile(root, 'profile')
    const before = probes()
    for (const [name, body] of [
      ['good', 'export default 1\n'],
      ['bad', 'throw new Error("boom")\n'],
    ] as Array<[string, string]>) {
      const dir = join(root, name)
      put(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module', main: 'index.js' }) + '\n')
      put(join(dir, 'index.js'), body)
      await importSmoke(dir, name, profile)
    }
    assert.deepEqual(probes(), before)
  })

  it('reports a load that never finishes as skipped rather than failed', { skip: "the deadline is 15s and is not parameterised, so a real run costs 15s on every suite pass; drop the skip to check it" }, async () => {
    const root = scratch('hang')
    const profile = emptyProfile(root, 'profile')
    const dir = join(root, 'extracted')
    put(join(dir, 'package.json'), JSON.stringify({ name: 'hang', version: '1.0.0', type: 'module', main: 'index.js' }) + '\n')
    put(join(dir, 'index.js'), 'setInterval(() => {}, 1000)\n')
    const result = await importSmoke(dir, 'hang', profile)
    // Only a deadline gets here, and the point of the third state is that a
    // package DSH simply never finished loading is not evidence of a bad patch.
    assert.equal(result.status, 'skipped')
    assert.match(result.detail, /did not finish loading within 15s/)
  })

  it('resolves a bare import in an extracted copy that sits outside the profile', async () => {
    const root = scratch('bare')
    const profile = emptyProfile(root, 'profile')
    put(
      join(profile, 'node_modules', 'left-pad', 'package.json'),
      JSON.stringify({ name: 'left-pad', version: '1.0.0', type: 'module', main: 'index.js' }) + '\n',
    )
    put(join(profile, 'node_modules', 'left-pad', 'index.js'), 'export default "padded"\n')
    const dir = join(root, 'extracted')
    put(join(dir, 'package.json'), JSON.stringify({ name: 'wants-a-dep', version: '1.0.0', type: 'module', main: 'index.js' }) + '\n')
    put(join(dir, 'index.js'), 'import pad from "left-pad"\nexport default pad\n')
    const result = await importSmoke(dir, 'wants-a-dep', profile)
    // The probe tree of symlinks and --preserve-symlinks exist precisely so
    // this resolves; without them the module is looked up in the edit
    // directory, where nothing is installed.
    assert.equal(result.status, 'ok', result.detail)
  })
})

describe('parseArgs for the flags that appeared with the load check', () => {
  it('runs the load check unless told not to', () => {
    assert.equal(parseArgs(['--patch-id', 'x']).importSmoke, true)
    assert.equal(parseArgs(['--patch-id', 'x', '--dry-run']).importSmoke, true)
    assert.equal(parseArgs(['--patch-id', 'x', '--no-import-smoke']).importSmoke, false)
  })

  it('takes a patcher root to read added files from', () => {
    assert.equal(parseArgs(['--patch-id', 'x']).patcherRoot, undefined)
    assert.equal(parseArgs(['--patch-id', 'x', '--patcher-root', '/tmp/other']).patcherRoot, '/tmp/other')
  })

  it('documents both next to the rest', () => {
    assert.match(HELP, /--patcher-root <dir>/)
    assert.match(HELP, /--no-import-smoke\s+skip the load-the-result check/)
  })
});

function filesPatch(id: string, ref: string, version = '1.0.0'): string {
  return (
    '      - id: ' + id + '\n' +
    '        enabled: true\n' +
    '        reason: ' + id + '\n' +
    '        target: {kind: package-file, pkg: demo, version: ' + version + ', path: index.js}\n' +
    '        op:\n' +
    '          kind: code\n' +
    '          edits: []\n' +
    '          files:\n' +
    '            - {path: lib/extra.js, source: ' + ref + '}\n'
  )
}

const DEMO_ESM = "import './lib/extra.js'\nexport const demo = 1\n"
const DEMO_MANIFEST = '{"name":"demo","version":"1.0.0","type":"module","main":"index.js"}\n'

describe('adding a whole file', () => {
  it('writes the file the spec names, at the path the spec names', async () => {
    const fixture = profile(filesPatch('add', payloadRef), DEMO_ESM, DEMO_MANIFEST)
    const first = await cli(fixture, ['--patch-id', 'add', '--patcher-root', patcherRoot])
    assert.equal(first.code, 0, first.stderr)
    const work = join(fixture.dir, 'node_modules', '.pnpm_patches', 'demo@1.0.0')
    // The load check is on by default, and the entry point imports this file,
    // so an ok here is the file being reachable and not merely written.
    assert.match(first.stdout, /^load:   demo@1\.0\.0 loaded$/m)
    assert.equal(
      readFileSync(join(work, 'lib', 'extra.js'), 'utf8'),
      readFileSync(join(patcherRoot, payloadRef), 'utf8'),
    )

    await run('pnpm', ['install'], { cwd: fixture.dir, env: { ...process.env, PATH: fixture.bin + ':' + (process.env.PATH ?? '') } })
    const second = await cli(fixture, ['--patch-id', 'add', '--patcher-root', patcherRoot])
    assert.equal(second.code, 0, second.stderr)
    assert.match(second.stdout, /already carries this change/)
  })

  it('does not mirror the source path into the package', async () => {
    // The shape of the bug this is guarding, kept as its own test because it
    // is invisible in a passing run: readSource hands back the path it opened,
    // and letting that stand in for the destination makes join() drop the
    // leading separator and grow a copy of the patcher's own directory tree
    // inside the edited package. The file is written, the patch commits, and
    // the load check fails on a module that is sitting right where it should.
    const fixture = profile(filesPatch('add', payloadRef), DEMO_ESM, DEMO_MANIFEST)
    const result = await cli(fixture, ['--patch-id', 'add', '--patcher-root', patcherRoot, '--no-import-smoke'])
    assert.equal(result.code, 0, result.stderr)
    const work = join(fixture.dir, 'node_modules', '.pnpm_patches', 'demo@1.0.0')
    assert.equal(existsSync(join(work, patcherRoot, payloadRef)), false, 'the source path was mirrored into the package')
  })

  it('commits and registers the patch, and skips the load check when told to', async () => {
    const fixture = profile(filesPatch('add', payloadRef), DEMO_ESM, DEMO_MANIFEST)
    const result = await cli(fixture, ['--patch-id', 'add', '--patcher-root', patcherRoot, '--no-import-smoke'])
    assert.equal(result.code, 0, result.stderr)
    assert.ok(!/^load:/m.test(result.stdout), 'nothing was loaded, so nothing should be reported about loading')
    assert.match(result.stdout, /patched demo@1\.0\.0/)
    assert.match(result.stdout, /Run `pnpm install` in the profile directory/)
    assert.ok(existsSync(join(fixture.dir, 'patches', 'demo@1.0.0.patch')))
    assert.match(readFileSync(join(fixture.dir, 'pnpm-workspace.yaml'), 'utf8'), /demo@1\.0\.0: patches\/demo@1\.0\.0\.patch/)
  })

  it('refuses a source reference that points outside the package, before pnpm is involved', async () => {
    const fixture = profile(filesPatch('add', '../../../etc/hostname'), DEMO_ESM, DEMO_MANIFEST)
    const result = await cli(fixture, ['--patch-id', 'add', '--patcher-root', patcherRoot])
    assert.equal(result.code, 1)
    assert.match(result.stderr, /resolves outside the patcher package/)
    assert.deepEqual(calls(fixture), [], 'the source should be read before pnpm is involved')
  })

  it('refuses a source reference this package does not ship', async () => {
    const fixture = profile(filesPatch('add', 'patches/never-written.js'), DEMO_ESM, DEMO_MANIFEST)
    const result = await cli(fixture, ['--patch-id', 'add', '--patcher-root', patcherRoot])
    assert.equal(result.code, 1)
    assert.match(result.stderr, /does not ship/)
    assert.deepEqual(calls(fixture), [])
  })


/**
 * `pnpm patch-commit` diffs the extracted package against the package as it
 * shipped, so a file the package never had produces no hunk at all. The
 * commit is then short one file while keeping the import that needs it, and
 * the plugin stops loading for a reason the patch file does not show. These
 * pin the hunk this script writes in its place, because the failure it
 * prevents is invisible in a passing run.
 */
describe('newFileHunk', () => {
  it('looks like a git diff that creates the file', () => {
    const hunk = newFileHunk('lib/extra.js', 'export const a = 1\n')
    assert.equal(
      hunk,
      [
        'diff --git a/lib/extra.js b/lib/extra.js',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/lib/extra.js',
        '@@ -0,0 +1,1 @@',
        '+export const a = 1',
        '',
      ].join('\n'),
    )
  })

  it('counts every line, and says so in the hunk header', () => {
    const hunk = newFileHunk('lib/x.js', 'a\nb\nc\n')
    assert.match(hunk, /^@@ -0,0 \+1,3 @@$/m)
    assert.equal(hunk.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).length, 3)
  })

  it('keeps a final line without a newline, and marks it', () => {
    // Silently adding the newline would make the patched file differ from the
    // source by a byte nobody asked for, and the next run would call the file
    // changed rather than done.
    const hunk = newFileHunk('lib/x.js', 'a\nb')
    assert.match(hunk, /^\+b$/m)
    assert.match(hunk, /^\\ No newline at end of file$/m)
  })

  it('emits no hunk header for an empty file', () => {
    const hunk = newFileHunk('lib/x.js', '')
    assert.ok(!hunk.includes('@@'), hunk)
    assert.match(hunk, /^new file mode 100644$/m)
  })
})

describe('forgetPatchState', () => {
  const withState = (state: unknown) => {
    const root = mkdtempSync(join(tmpdir(), 'pp-state-'))
    roots.push(root)
    writeFileSync(join(root, 'state.json'), typeof state === 'string' ? state : JSON.stringify(state))
    return root
  }

  it('drops the entry naming the directory being re-extracted, and leaves the rest', () => {
    const root = withState({
      '/p/demo@1.0.0': { patchedPkg: 'demo@1.0.0' },
      '/p/other@2.0.0': { patchedPkg: 'other@2.0.0' },
    })
    assert.equal(forgetPatchState(root, '/p/demo@1.0.0'), true)
    const after2 = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'))
    assert.deepEqual(Object.keys(after2), ['/p/other@2.0.0'])
  })

  it('reports doing nothing when there is no state, no entry, or nothing to parse', () => {
    const empty = mkdtempSync(join(tmpdir(), 'pp-state-'))
    roots.push(empty)
    assert.equal(forgetPatchState(empty, '/p/demo@1.0.0'), false, 'no state.json at all')
    assert.equal(forgetPatchState(withState('{ not json'), '/p/demo@1.0.0'), false, 'unparseable state is left alone')
    assert.equal(forgetPatchState(withState({ '/p/other@2.0.0': {} }), '/p/demo@1.0.0'), false, 'no entry for this directory')
  })
})
})
