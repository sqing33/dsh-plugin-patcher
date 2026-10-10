/**
 * Tests for the built-in default spec.
 *
 * The seed is the one piece of this plugin that writes without being asked, so
 * every test here is really asking the same question from a different angle:
 * could this make a namespace worse than it found it?
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_EXAMPLE_FILES,
  defaultConfig,
  loadDefaultPatches,
  needsSeed,
  packageRootFrom,
  seedOps,
  shippedExampleReader,
} from '../src/host/defaults.ts'

function spec(...patches: Record<string, unknown>[]): string {
  return JSON.stringify({ patches, reconcileNonce: 0 })
}

/** A valid id, whatever the file it came from is called. */
function patchIdFor(name: string): string {
  return name.replace(/\\.json$/, '').replace(/[^a-z0-9-]/g, '-')
}

function codePatch(id: string): Record<string, unknown> {
  return {
    id,
    enabled: true,
    reason: 'the shipped ' + id + ' guard',
    target: { kind: 'package-file', pkg: 'demo', version: '1.0.0', path: 'index.js' },
    op: { kind: 'code', edits: [{ find: 'const a = 1', replace: 'const a = 2', count: 1 }] },
  }
}

test('packageRootFrom', async (t) => {
  await t.test('finds the nearest ancestor that has a package.json', () => {
    const dirs = ['/a/node_modules/dsh-plugin-patcher/lib', '/a/node_modules/dsh-plugin-patcher']
    const seen: string[] = []
    const root = packageRootFrom('file:///a/node_modules/dsh-plugin-patcher/lib/host/defaults.js', (path) => {
      seen.push(path)
      return path === '/a/node_modules/dsh-plugin-patcher/package.json'
    })
    // It must try the deepest first, or a nested dependency's package.json would
    // win over the one that actually ships this file. The module path itself is
    // probed as if it were a directory too, which is one wasted stat at load and
    // keeps the walk free of special cases.
    assert.equal(root, '/a/node_modules/dsh-plugin-patcher')
    assert.deepEqual(seen, [
      '/a/node_modules/dsh-plugin-patcher/lib/host/defaults.js/package.json',
      '/a/node_modules/dsh-plugin-patcher/lib/host/package.json',
      '/a/node_modules/dsh-plugin-patcher/lib/package.json',
      '/a/node_modules/dsh-plugin-patcher/package.json',
    ])
  })

  await t.test('reads a file:// URL rather than treating it as a path', () => {
    const root = packageRootFrom('file:///a/pkg%20with%20spaces/lib/client.js', (path) =>
      path === '/a/pkg with spaces/package.json',
    )
    assert.equal(root, '/a/pkg with spaces')
  })

  await t.test('survives a malformed percent escape', () => {
    assert.doesNotThrow(() => packageRootFrom('file:///a/%E0%A4%A/lib/x.js', () => false))
  })

  await t.test('gives up on a windows path, where the split below would not work', () => {
    assert.equal(packageRootFrom('C:\\pkg\\lib\\defaults.js', () => true), undefined)
    assert.equal(packageRootFrom('\\\\server\\share\\lib\\defaults.js', () => true), undefined)
  })

  await t.test('returns undefined when no ancestor has one, as in a single-file bundle', () => {
    assert.equal(packageRootFrom('file:///a/b/c/d.js', () => false), undefined)
  })

  await t.test('finds the real package root from this module', () => {
    const root = packageRootFrom(import.meta.url)
    assert.ok(root !== undefined)
    assert.ok(root.endsWith('dsh-plugin-patcher'))
  })
})

test('loadDefaultPatches', async (t) => {
  await t.test('reads every hand-edit this profile actually carries', () => {
    const { patches, problems } = loadDefaultPatches()
    assert.deepEqual(problems, [])
    assert.deepEqual(patches.map((patch) => patch.id), [
      'plan-build-switch-command-arity',
      'think-translate-icons-and-seat',
      'reasoning-effort-force-effort-tiers',
    ])
    // Each one must name the package it is about; a default that lost its target
    // would report a state nobody can act on.
    for (const patch of patches) {
      assert.equal(patch.target.kind, 'package-file')
      assert.ok(patch.target.kind === 'package-file' && patch.target.pkg.length > 0)
      assert.equal(patch.op.kind, 'code')
    }
  })

  await t.test('reports a missing example rather than silently shipping fewer patches', () => {
    const { patches, problems } = loadDefaultPatches((name) =>
      name === 'think-translate-icons-and-seat.json' ? undefined : spec(codePatch(patchIdFor(name))),
    )
    assert.equal(patches.length, 2)
    assert.match(problems[0] ?? '', /think-translate-icons-and-seat\.json is missing/)
  })

  await t.test('drops an example the schema rejects, and says why', () => {
    const { patches, problems } = loadDefaultPatches((name) =>
      name === 'reasoning-effort-force-effort-tiers.json' ? spec({ id: 'no-reason' }) : spec(codePatch(patchIdFor(name))),
    )
    assert.equal(patches.length, 2)
    assert.match(problems[0] ?? '', /reasoning-effort-force-effort-tiers\.json did not load/)
  })

  await t.test('drops an example that is not JSON, and quotes the parser', () => {
    const { patches, problems } = loadDefaultPatches((name) =>
      name === 'plan-build-switch-command-arity.json' ? '{oops' : spec(codePatch(patchIdFor(name))),
    )
    assert.equal(patches.length, 2)
    assert.match(problems[0] ?? '', /is not valid JSON/)
  })

  await t.test('keeps the first of two examples that claim one patch id', () => {
    const { patches, problems } = loadDefaultPatches(() => spec(codePatch('plan-build-switch-command-arity')))
    assert.equal(patches.length, 1)
    assert.equal(patches[0]?.id, 'plan-build-switch-command-arity')
    // The later one is dropped rather than overwriting: a duplicate would make
    // the spec unloadable, and the seed only ever runs once, so a namespace
    // poisoned here could never be repaired from inside the page.
    assert.equal(patches.length, 1)
    assert.match(problems[0] ?? '', /repeats the patch id/)
  })

  await t.test('takes every patch an example carries, not just the first', () => {
    const { patches } = loadDefaultPatches((name) =>
      name === 'think-translate-icons-and-seat.json'
        ? spec(codePatch('one'), codePatch('two'))
        : spec(codePatch(patchIdFor(name))),
    )
    assert.equal(patches.length, 4)
  })

  await t.test('reads a real examples directory off disk', () => {
    // The reader is what the installed build uses, so it is exercised against
    // the same layout it will meet: a package root with examples/ inside it.
    const root = mkdtempSync(join(tmpdir(), 'patcher-defaults-'))
    const examples = join(root, 'examples')
    mkdirSync(examples)
    writeFileSync(join(root, 'package.json'), '{}')
    for (const name of DEFAULT_EXAMPLE_FILES) {
      writeFileSync(join(examples, name), spec(codePatch(patchIdFor(name))))
    }
    const { patches, problems } = loadDefaultPatches(shippedExampleReader('file://' + join(root, 'lib', 'x.js')))
    assert.deepEqual(problems, [])
    assert.deepEqual(patches.map((patch) => patch.id), DEFAULT_EXAMPLE_FILES.map(patchIdFor))
  })

  await t.test('a reader with no package root reads nothing, and complains about each one', () => {
    const { patches, problems } = loadDefaultPatches(shippedExampleReader('file:///nowhere/x.js', () => false))
    assert.equal(patches.length, 0)
    assert.equal(problems.length, DEFAULT_EXAMPLE_FILES.length)
  })
})

test('needsSeed', async (t) => {
  await t.test('seeds a namespace nobody has written to', () => {
    assert.equal(needsSeed({ patches: [], reconcileNonce: 0, initialized: false }), true)
  })

  await t.test('never seeds twice, even after the operator deletes every patch', () => {
    // Deleting the list and having it come back is the failure this flag exists
    // to prevent, so an emptied-but-seeded namespace has to stay empty.
    assert.equal(needsSeed({ patches: [], reconcileNonce: 0, initialized: true }), false)
  })

  await t.test('never overwrites a spec that failed to load', () => {
    // An undefined config is unparseable input, not an empty namespace. Writing
    // over it would destroy whatever the operator was in the middle of typing.
    assert.equal(needsSeed(undefined), false)
  })

  await t.test('seeds a spec that predates the flag', () => {
    assert.equal(needsSeed({ patches: [], reconcileNonce: 0 } as never), true)
  })
})

test('defaultConfig', async (t) => {
  await t.test('copies the list instead of aliasing the caller\'s', () => {
    const patches = [codePatch('a') as never]
    const config = defaultConfig(patches)
    patches.push(codePatch('b') as never)
    assert.equal(config.patches.length, 1)
  })

  await t.test('writes the flag in the same breath as the patches', () => {
    assert.deepEqual(defaultConfig([]), { patches: [], reconcileNonce: 0, initialized: true })
  })
})

test('seedOps', async (t) => {
  await t.test('sets the list and the flag in one batch', () => {
    // Two writes would leave a window where the list is in place but the flag is
    // not; a crash in that window would make the host re-seed forever.
    assert.deepEqual(seedOps([codePatch('a') as never]), [
      { op: 'set', path: ['patches'], value: [codePatch('a')] },
      { op: 'set', path: ['initialized'], value: true },
    ])
  })

  await t.test('an empty default is still a write, so the flag is set', () => {
    assert.deepEqual(seedOps([]), [
      { op: 'set', path: ['patches'], value: [] },
      { op: 'set', path: ['initialized'], value: true },
    ])
  })
})
