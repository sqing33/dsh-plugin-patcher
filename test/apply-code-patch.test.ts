import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { after, describe, it } from 'node:test'

import { assessEdits as hostAssess } from '../src/adapters/package-file.ts'
import {
  assessEdits,
  configFrom,
  describeChange,
  NAMESPACE,
  parseArgs,
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
function profile(specPatches: string, source = SOURCE): Profile {
  const root = mkdtempSync(join(tmpdir(), 'patcher-cli-'))
  roots.push(root)
  const dir = join(root, 'profile')
  const bin = join(root, 'bin')
  mkdirSync(join(dir, 'node_modules', 'demo'), { recursive: true })
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(dir, 'package.json'), '{"name":"demo-profile","private":true}\n')
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'nodeLinker: hoisted\n')
  writeFileSync(join(dir, 'node_modules', 'demo', 'package.json'), '{"name":"demo","version":"1.0.0"}\n')
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
