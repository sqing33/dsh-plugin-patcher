import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  describeTarget,
  expandValue,
  isGeneratorRequest,
  loadSpec,
  referencedGenerators,
  type Generator,
} from '../src/spec/resolve.ts'
import type { Json } from '../src/spec/types.ts'

const noop: Generator = { id: 'noop', description: 'writes nothing interesting', generate: () => ({ ok: true }) }

function settingsSet(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    reason: 'why ' + id,
    target: { kind: 'settings', namespace: 'llm-pi-ai' },
    op: { kind: 'set', path: ['providers'], value: { openai: {} } },
    ...extra,
  }
}

function rowPatch(id: string, rowId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    reason: 'why ' + id,
    target: { kind: 'patch-row', rowId },
    op: { kind: 'merge-config', config: { a: 1 } },
    ...extra,
  }
}

function packagePatch(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    reason: 'why ' + id,
    target: { kind: 'package-file', pkg: 'dsh-plan-build-switch', version: '0.2.2', path: 'lib/client.js' },
    op: { kind: 'code', edits: [{ find: 'a', replace: 'b', count: 1 }] },
    ...extra,
  }
}

function messagesFor(spec: ReturnType<typeof loadSpec>, patchId: string): string[] {
  return spec.diagnostics.filter((d) => d.patchId === patchId).map((d) => d.message)
}

describe('loadSpec defaults', () => {
  it('turns an empty namespace into an empty spec instead of failing', () => {
    for (const raw of [{}, undefined, null]) {
      const spec = loadSpec(raw)
      assert.ok(spec.config, 'config should exist for ' + JSON.stringify(raw))
      assert.deepEqual(spec.config.patches, [])
      assert.equal(spec.config.reconcileNonce, 0)
      assert.deepEqual(spec.diagnostics, [])
    }
  })

  it('defaults enabled to true, so a patch is live the moment it is written', () => {
    const spec = loadSpec({ patches: [settingsSet('a')] })
    assert.equal(spec.config?.patches[0]?.enabled, true)
  })
})

describe('loadSpec structural failures', () => {
  it('returns no config when the shape is wrong, and says where', () => {
    const spec = loadSpec({ patches: 'not an array' })
    assert.equal(spec.config, undefined)
    assert.equal(spec.diagnostics.length, 1)
    assert.ok(spec.diagnostics[0]?.message)
  })

  it('never throws on garbage', () => {
    for (const raw of [42, 'text', [], { patches: [null] }, { patches: [{ id: 'Bad Id' }] }]) {
      assert.doesNotThrow(() => loadSpec(raw))
    }
  })
})

describe('loadSpec cross-field checks', () => {
  it('rejects an op that cannot address its target', () => {
    const spec = loadSpec({
      patches: [{
        id: 'wrong-op',
        reason: 'a code edit aimed at a settings namespace',
        target: { kind: 'settings', namespace: 'llm-pi-ai' },
        op: { kind: 'code', edits: [{ find: 'a', replace: 'b', count: 1 }] },
      }],
    })
    assert.ok(spec.rejected.has('wrong-op'))
    assert.match(messagesFor(spec, 'wrong-op')[0] ?? '', /cannot be patched with "code"/)
  })

  it('accepts every legal pairing and rejects the illegal ones', () => {
    const legal = [
      { target: { kind: 'settings', namespace: 'n' }, op: { kind: 'set', path: ['a'], value: 1 } },
      { target: { kind: 'settings', namespace: 'n' }, op: { kind: 'unset', path: ['a'] } },
      { target: { kind: 'settings', namespace: 'n' }, op: { kind: 'verify-only' } },
      { target: { kind: 'patch-row', rowId: 'r' }, op: { kind: 'merge-config', config: { a: 1 } } },
      { target: { kind: 'patch-row', rowId: 'r' }, op: { kind: 'set-enabled', enabled: true } },
      { target: { kind: 'package-file', pkg: 'p', version: '1', path: 'lib/a.js' }, op: { kind: 'code', edits: [{ find: 'a', replace: 'b', count: 1 }] } },
    ]
    for (const [index, entry] of legal.entries()) {
      const spec = loadSpec({ patches: [{ id: 'ok' + index, reason: 'r', ...entry }] })
      assert.equal(spec.rejected.size, 0, 'case ' + index + ': ' + JSON.stringify(spec.diagnostics))
    }
  })

  it('rejects a patch with an empty path, an empty merge or an empty edit list', () => {
    const cases = [
      { target: { kind: 'settings', namespace: 'n' }, op: { kind: 'set', path: [], value: 1 } },
      { target: { kind: 'settings', namespace: 'n' }, op: { kind: 'unset', path: [] } },
      { target: { kind: 'patch-row', rowId: 'r' }, op: { kind: 'merge-config', config: {} } },
      { target: { kind: 'package-file', pkg: 'p', version: '1', path: 'lib/a.js' }, op: { kind: 'code', edits: [] } },
    ]
    for (const [index, entry] of cases.entries()) {
      const spec = loadSpec({ patches: [{ id: 'empty' + index, reason: 'r', ...entry }] })
      assert.ok(spec.rejected.has('empty' + index), 'case ' + index)
    }
  })

  it('requires a package-file patch to pin its version', () => {
    const spec = loadSpec({
      patches: [{
        id: 'unpinned',
        reason: 'r',
        target: { kind: 'package-file', pkg: 'p', path: 'lib/a.js' },
        op: { kind: 'code', edits: [{ find: 'a', replace: 'b', count: 1 }] },
      }],
    })
    assert.equal(spec.config, undefined, 'an unpinned pnpm patch is refused at the schema layer')
  })
})

describe('loadSpec identity', () => {
  it('rejects duplicate ids rather than letting the journal key collapse them', () => {
    const spec = loadSpec({ patches: [settingsSet('dup'), settingsSet('dup')] })
    assert.ok(spec.rejected.has('dup'))
    assert.match(messagesFor(spec, 'dup')[0] ?? '', /duplicate patch id/)
  })

  it('lets a broken patch fail alone while its siblings survive', () => {
    const spec = loadSpec({ patches: [settingsSet('good'), settingsSet('bad', { op: { kind: 'set-enabled', enabled: true } })] })
    assert.ok(spec.config)
    assert.equal(spec.rejected.has('good'), false)
    assert.ok(spec.rejected.has('bad'))
  })

  it('marks a patch row claimed twice as contested and tells both owners', () => {
    const spec = loadSpec({ patches: [rowPatch('one', 'shared'), rowPatch('two', 'shared')] })
    assert.ok(spec.contestedRows.has('shared'))
    assert.match(messagesFor(spec, 'one')[0] ?? '', /claimed by 2 patches/)
    assert.match(messagesFor(spec, 'two')[0] ?? '', /claimed by 2 patches/)
  })

  it('leaves distinct rows alone', () => {
    const spec = loadSpec({ patches: [rowPatch('one', 'a'), rowPatch('two', 'b')] })
    assert.equal(spec.contestedRows.size, 0)
  })
})

describe('generators', () => {
  it('recognises only a plain object with a non-empty string $gen', () => {
    assert.equal(isGeneratorRequest({ $gen: 'x' }), true)
    assert.equal(isGeneratorRequest({ $gen: 'x', args: {} }), true)
    assert.equal(isGeneratorRequest({ $gen: 1 }), false)
    assert.equal(isGeneratorRequest({ $gen: '' }), false)
    assert.equal(isGeneratorRequest({ args: {} }), false)
    assert.equal(isGeneratorRequest([{ $gen: 'x' }]), false)
    assert.equal(isGeneratorRequest(null), false)
  })

  it('reports a spec that names a generator nobody registered', () => {
    const spec = loadSpec({ patches: [settingsSet('a', { op: { kind: 'set', path: ['p'], value: { $gen: 'missing' } } })] })
    assert.match(spec.diagnostics.map((d) => d.message).join('\n'), /unknown generator "missing"/)
  })

  it('says nothing when every generator is registered', () => {
    const registry = new Map([['noop', noop]])
    const spec = loadSpec({ patches: [settingsSet('a', { op: { kind: 'set', path: ['p'], value: { $gen: 'noop' } } })] }, registry)
    assert.deepEqual(spec.diagnostics, [])
  })

  it('lists every generator a spec reaches, at any depth', () => {
    const spec = loadSpec({
      patches: [
        settingsSet('a', { op: { kind: 'set', path: ['p'], value: [{ $gen: 'one' }, { deep: { $gen: 'two' } }] } }),
        settingsSet('b', { op: { kind: 'set', path: ['q'], value: { $gen: 'one' } } }),
      ],
    })
    assert.deepEqual([...referencedGenerators(spec.config!)].sort(), ['one', 'two'])
  })
})

describe('expandValue', () => {
  const registry = new Map<string, Generator>([
    ['shout', { id: 'shout', description: 'uppercases', generate: (a) => String(a.text ?? '').toUpperCase() }],
    ['boom', { id: 'boom', description: 'always throws', generate: () => { throw new Error('nope') } }],
  ])

  it('passes plain JSON through untouched', () => {
    const value = { a: [1, 'two', null, { b: true }] }
    assert.deepEqual(expandValue(value, registry).value, value)
  })

  it('expands a request', () => {
    assert.deepEqual(expandValue({ $gen: 'shout', args: { text: 'hi' } }, registry).value, 'HI')
  })

  it('expands recursively through arrays and objects', () => {
    const out = expandValue({ list: [{ $gen: 'shout', args: { text: 'a' } }, { $gen: 'shout', args: { text: 'b' } }] }, registry)
    assert.deepEqual(out.value, { list: ['A', 'B'] })
  })

  it('names the path of an unknown generator', () => {
    const out = expandValue({ list: ['ok', { $gen: 'nope' }] }, registry)
    assert.equal(out.value, undefined)
    assert.equal(out.error, '$.list[1]: unknown generator "nope"')
  })

  it('reports a generator that throws, with the path', () => {
    const out = expandValue({ $gen: 'boom' }, registry)
    assert.match(out.error ?? '', /^\$: generator "boom" failed: nope$/)
  })

  it('refuses values JSON cannot carry', () => {
    for (const bad of [undefined, () => {}, Symbol('s'), 1n]) {
      assert.match(expandValue(bad, registry).error ?? '', /is not a value a patch can write/)
    }
  })

  it('treats an object with a $gen of the wrong shape as ordinary data', () => {
    const value = { $gen: 7, args: { a: 1 } }
    assert.deepEqual(expandValue(value, registry).value, value)
  })
})

describe('describeTarget', () => {
  it('names each target kind the way the settings page will', () => {
    assert.equal(describeTarget({ kind: 'settings', namespace: 'llm-pi-ai' }), 'llm-pi-ai')
    assert.equal(describeTarget({ kind: 'patch-row', rowId: 'subagent-roles' }), 'subagent-roles')
    assert.equal(
      describeTarget({ kind: 'package-file', pkg: 'dsh-plan-build-switch', version: '0.2.2', path: 'lib/client.js' }),
      'dsh-plan-build-switch@0.2.2',
    )
  })
})

describe('generated values stay JSON', () => {
  it('accepts a generator that returns a nested structure', () => {
    const out = expandValue({ $gen: 'tree' }, new Map([['tree', { id: 'tree', description: 'd', generate: (): Json => ({ x: [1, { y: 2 }] }) }]]))
    assert.deepEqual(out.value, { x: [1, { y: 2 }] })
  })
})


describe('a field the schema declares must actually be there', () => {
  // Schemastery lets an absent key through as undefined, so a required field
  // is only required because something said so. Each case below is a field a
  // reader would reasonably call mandatory, dropped on the floor by a schema
  // that forgot the word.
  const dropped: [string, Record<string, unknown>][] = [
    ['reason', { id: 'a', target: { kind: 'settings', namespace: 'n' }, op: { kind: 'verify-only' } }],
    ['id', { reason: 'r', target: { kind: 'settings', namespace: 'n' }, op: { kind: 'verify-only' } }],
    ['target', { id: 'a', reason: 'r', op: { kind: 'verify-only' } }],
    ['op', { id: 'a', reason: 'r', target: { kind: 'settings', namespace: 'n' } }],
    ['namespace', { id: 'a', reason: 'r', target: { kind: 'settings' }, op: { kind: 'verify-only' } }],
    ['rowId', { id: 'a', reason: 'r', target: { kind: 'patch-row' }, op: { kind: 'verify-only' } }],
    ['pkg', { id: 'a', reason: 'r', target: { kind: 'package-file', version: '1', path: 'lib/a.js' }, op: { kind: 'verify-only' } }],
    ['path', { id: 'a', reason: 'r', target: { kind: 'package-file', pkg: 'p', version: '1' }, op: { kind: 'verify-only' } }],
  ]

  for (const [field, patch] of dropped) {
    it(`refuses a patch with no ${field}`, () => {
      const spec = loadSpec({ patches: [patch] })
      assert.equal(spec.config, undefined, `a patch missing ${field} loaded as valid`)
      assert.equal(spec.diagnostics.length, 1)
    })
  }

  it('refuses an empty reason, which is just a missing reason with extra steps', () => {
    const spec = loadSpec({ patches: [settingsSet('a', { reason: '' })] })
    assert.equal(spec.config, undefined)
  })

  it('refuses a code edit with no count, since count is how "exactly one" is stated', () => {
    const spec = loadSpec({
      patches: [{
        id: 'a',
        reason: 'r',
        target: { kind: 'package-file', pkg: 'p', version: '1', path: 'lib/a.js' },
        op: { kind: 'code', edits: [{ find: 'a', replace: 'b' }] },
      }],
    })
    assert.equal(spec.config, undefined)
  })

  it('keeps name: optional on a patch-row target, because a guard you must fill in is not a guard', () => {
    const spec = loadSpec({ patches: [rowPatch('a', 'subagent-roles')] })
    assert.equal(spec.config?.patches[0]?.target.kind, 'patch-row')
    assert.equal(spec.rejected.size, 0)
  })
})

describe('loadSpec: one storage, one writer', () => {
  const NS = 'llm-pi-ai'

  function settings(id: string, path: string[]): Record<string, unknown> {
    return {
      id,
      reason: 'r ' + id,
      target: { kind: 'settings', namespace: NS },
      op: { kind: 'set', path, value: 1 },
    }
  }

  function merge(id: string, rowId: string): Record<string, unknown> {
    return {
      id,
      reason: 'r ' + id,
      target: { kind: 'patch-row', rowId },
      op: { kind: 'merge-config', config: { retries: 2 } },
    }
  }

  it('refuses two settings patches on the same path', () => {
    const spec = loadSpec({ patches: [settings('one', ['providers', 'openai']), settings('two', ['providers', 'openai'])] })
    assert.equal(spec.contestedSlots.size, 1)
    for (const id of ['one', 'two']) {
      const message = spec.diagnostics.find((d) => d.patchId === id)
      assert.ok(message !== undefined, id + ' must be told why')
      assert.match(message.message, /overlapping paths/)
    }
  })

  it('refuses a path that sits inside another one', () => {
    const spec = loadSpec({ patches: [settings('one', ['providers']), settings('two', ['providers', 'openai'])] })
    assert.equal(spec.contestedSlots.size, 1)
  })

  it('allows two patches on different paths of one namespace', () => {
    const spec = loadSpec({
      patches: [settings('one', ['providers']), settings('two', ['limits'])],
    })
    assert.equal(spec.contestedSlots.size, 0)
    assert.equal(spec.diagnostics.length, 0)
  })

  it('refuses a settings patch and a row merge on the same row', () => {
    // The whole point: dsh-settings resolves a namespace through the config
    // editor, so a namespace and a row with that id are one config: key.
    const spec = loadSpec({ patches: [settings('one', ['providers']), merge('two', NS)] })
    assert.equal(spec.contestedSlots.size, 1)
    assert.deepEqual([...spec.contestedSlots].map((s) => s.includes(NS)), [true])
  })

  it('allows a settings patch and a row merge on different rows', () => {
    const spec = loadSpec({ patches: [settings('one', ['providers']), merge('two', 'some-other-row')] })
    assert.equal(spec.contestedSlots.size, 0)
  })

  it('leaves set-enabled alone: it writes disabled:, not config:', () => {
    const spec = loadSpec({
      patches: [
        settings('one', ['providers']),
        {
          id: 'two',
          reason: 'r two',
          target: { kind: 'patch-row', rowId: NS },
          op: { kind: 'set-enabled', enabled: false },
        },
      ],
    })
    assert.equal(spec.contestedSlots.size, 0)
    assert.equal(spec.contestedRows.size, 0)
  })

  it('leaves a verify-only alone, because it writes nothing', () => {
    const spec = loadSpec({
      patches: [
        settings('one', ['providers']),
        {
          id: 'two',
          reason: 'r two',
          target: { kind: 'settings', namespace: NS },
          op: { kind: 'verify-only' },
        },
      ],
    })
    assert.equal(spec.contestedSlots.size, 0)
  })
})