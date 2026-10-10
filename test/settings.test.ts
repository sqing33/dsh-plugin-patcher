import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { SettingsDescriptor, SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { settingsAdapter, settingsDescriptorOf, type SettingsPort } from '../src/adapters/settings.ts'
import type { Op, Patch, SettingsTarget } from '../src/spec/types.ts'

const NS = 'llm-pi-ai'
const OTHER = 'llm-other'

interface StoredNamespace {
  value: unknown
  revision: number
}

interface MutateCall {
  ns: string
  ops: SettingsPathOp[]
  revision?: number
}

interface FakePort extends SettingsPort {
  store: Record<string, StoredNamespace>
  calls: MutateCall[]
}

/** Stand-in for SettingsDescriptor; only the fields this adapter reads matter. */
function descriptor(ns: string, value: unknown, revision: number): SettingsDescriptor {
  return { ns, autoGenerate: true, schema: {}, value, revision, applies: 'live' }
}

/**
 * Hand-rolled port: a mutable namespace store plus a recorded mutate log.
 *
 * Revision numbers are read from the store at describe() time, so a test can
 * bump one between read() and apply() to prove the adapter re-reads.
 */
function createPort(
  store: Record<string, StoredNamespace> = {},
  mutateError?: unknown,
): FakePort {
  const calls: MutateCall[] = []
  return {
    store,
    calls,
    describe: () =>
      Object.entries(store).map(([ns, entry]) => descriptor(ns, entry.value, entry.revision)),
    mutate: async (ns, ops, revision) => {
      calls.push({ ns, ops: ops.map((op) => ({ ...op })), revision })
      if (mutateError !== void 0) throw mutateError
    },
  }
}

function patchFor(
  op: Op,
  namespace = NS,
): Patch & { target: SettingsTarget } {
  return {
    id: 'p1',
    enabled: true,
    reason: 'force the ladder',
    target: { kind: 'settings', namespace },
    op,
  }
}

/** Mirrors the host's error shape: a subclass carrying a readonly code. */
class FakeSettingsConflictError extends Error {
  readonly code = 'SETTINGS_CONFLICT'
  readonly expected: number
  readonly actual: number

  constructor(expected: number, actual: number) {
    super(`settings revision conflict: expected ${expected}, found ${actual}`)
    this.expected = expected
    this.actual = actual
  }
}

const { read, apply, rollback } = settingsAdapter

describe('settingsDescriptorOf', () => {
  it('finds a namespace by its exact id', () => {
    const port = createPort({ [NS]: { value: { a: 1 }, revision: 3 } })
    assert.equal(settingsDescriptorOf(port, NS)?.revision, 3)
  })

  it('returns undefined for a namespace that is not registered', () => {
    assert.equal(settingsDescriptorOf(createPort(), NS), void 0)
  })

  it('does not match by prefix, so a similarly named entry cannot hijack the lookup', () => {
    const port = createPort({ [`${NS}-extra`]: { value: {}, revision: 1 } })
    assert.equal(settingsDescriptorOf(port, NS), void 0)
  })
})

describe('settings read', () => {
  it('reports an unregistered namespace as absent and names it', () => {
    const snapshot = read(createPort(), patchFor({ kind: 'set', path: ['a'], value: 1 }))
    assert.equal(snapshot.state, 'absent')
    assert.equal(snapshot.value, void 0)
    assert.ok(snapshot.detail.includes(NS))
  })

  it('reports a set whose path already holds the value as in-sync', () => {
    const port = createPort({ [NS]: { value: { models: { m1: { max: 'MAX' } } }, revision: 2 } })
    const snapshot = read(port, patchFor({ kind: 'set', path: ['models', 'm1', 'max'], value: 'MAX' }))
    assert.equal(snapshot.state, 'in-sync')
  })

  it('compares by value, not identity or key order', () => {
    const port = createPort({ [NS]: { value: { cfg: { b: 2, a: 1 } }, revision: 1 } })
    const patch = patchFor({ kind: 'set', path: ['cfg'], value: { a: 1, b: 2 } })
    assert.equal(read(port, patch).state, 'in-sync')
  })

  it('compares arrays element-wise, not by reference', () => {
    const port = createPort({ [NS]: { value: { m: [{ id: 'm1' }] }, revision: 1 } })
    assert.equal(read(port, patchFor({ kind: 'set', path: ['m'], value: [{ id: 'm1' }] })).state, 'in-sync')
  })

  it('reports a differing value as drifted and snapshots the whole namespace', () => {
    const port = createPort({ [NS]: { value: { models: { m1: {} } }, revision: 5 } })
    const snapshot = read(port, patchFor({ kind: 'set', path: ['models', 'm1', 'max'], value: 'MAX' }))
    assert.equal(snapshot.state, 'drifted')
    assert.deepEqual(snapshot.value, { models: { m1: {} } })
    assert.ok(snapshot.detail.includes('models.m1.max'))
  })

  it('treats 1 and "1" as different values', () => {
    const port = createPort({ [NS]: { value: { a: 1 }, revision: 1 } })
    assert.equal(read(port, patchFor({ kind: 'set', path: ['a'], value: '1' })).state, 'drifted')
  })

  it('reports an unset whose path is already absent as in-sync', () => {
    const port = createPort({ [NS]: { value: { a: 1 }, revision: 1 } })
    const snapshot = read(port, patchFor({ kind: 'unset', path: ['b', 'c'] }))
    assert.equal(snapshot.state, 'in-sync')
    assert.deepEqual(snapshot.value, { a: 1 })
  })

  it('reports an unset whose path still holds a value as drifted', () => {
    const port = createPort({ [NS]: { value: { a: 1 }, revision: 1 } })
    assert.equal(read(port, patchFor({ kind: 'unset', path: ['a'] })).state, 'drifted')
  })

  it('is in-sync for verify-only and reports the current value', () => {
    const port = createPort({ [NS]: { value: { a: 1 }, revision: 1 } })
    const snapshot = read(port, patchFor({ kind: 'verify-only' }))
    assert.equal(snapshot.state, 'in-sync')
    assert.deepEqual(snapshot.value, { a: 1 })
  })

  it('fails when a generator request reaches it unexpanded', () => {
    const port = createPort({ [NS]: { value: {}, revision: 1 } })
    const snapshot = read(port, patchFor({ kind: 'set', path: ['a'], value: { $gen: 'ladder' } }))
    assert.equal(snapshot.state, 'failed')
    assert.ok(snapshot.detail.includes('ladder'))
  })

  it('rejects an op kind that does not address a settings namespace', () => {
    const port = createPort({ [NS]: { value: {}, revision: 1 } })
    const snapshot = read(port, patchFor({ kind: 'merge-config', config: { a: 1 } }))
    assert.equal(snapshot.state, 'failed')
    assert.ok(snapshot.detail.includes('merge-config'))
  })
})

describe('settings apply', () => {
  it('writes one set op at the patch path with a freshly described revision', async () => {
    const port = createPort({ [NS]: { value: { a: 1 }, revision: 7 } })
    const patch = patchFor({ kind: 'set', path: ['models', 'm1'], value: { max: 'MAX' } })
    const expected = read(port, patch)
    assert.equal(expected.state, 'drifted')
    // The write re-enters listeners, so a revision read before it is stale.
    port.store[NS]!.revision = 9
    const result = await apply(port, patch, expected)
    assert.equal(result.state, 'in-sync')
    assert.deepEqual(result.before, { a: 1 })
    assert.deepEqual(port.calls, [
      {
        ns: NS,
        ops: [{ op: 'set', path: ['models', 'm1'], value: { max: 'MAX' } }],
        revision: 9,
      },
    ])
  })

  it('copies the path so a later mutation of the spec cannot reach a written op', async () => {
    const port = createPort({ [NS]: { value: {}, revision: 1 } })
    const path = ['a', 'b']
    const patch = patchFor({ kind: 'unset', path })
    await apply(port, patch, read(port, patch))
    path.push('c')
    assert.deepEqual(port.calls[0]?.ops, [{ op: 'unset', path: ['a', 'b'] }])
  })

  it('writes one unset op and nothing else', async () => {
    const port = createPort({ [NS]: { value: { a: 1 }, revision: 4 } })
    const patch = patchFor({ kind: 'unset', path: ['a'] })
    const result = await apply(port, patch, read(port, patch))
    assert.equal(result.state, 'in-sync')
    assert.deepEqual(port.calls[0]?.ops, [{ op: 'unset', path: ['a'] }])
    assert.equal(port.calls[0]?.revision, 4)
  })

  it('writes nothing at all for verify-only', async () => {
    const port = createPort({ [NS]: { value: { a: 1 }, revision: 1 } })
    const patch = patchFor({ kind: 'verify-only' })
    const result = await apply(port, patch, read(port, patch))
    assert.equal(result.state, 'in-sync')
    assert.equal(result.detail, 'verified, nothing written')
    assert.equal(port.calls.length, 0)
  })

  it('maps a stale revision to conflict and does not retry', async () => {
    const port = createPort({ [NS]: { value: {}, revision: 1 } }, new FakeSettingsConflictError(1, 2))
    const patch = patchFor({ kind: 'set', path: ['a'], value: 1 })
    const expected = read(port, patch)
    const result = await apply(port, patch, expected)
    assert.equal(result.state, 'conflict')
    assert.equal(result.before, expected.value)
    assert.ok(result.detail.includes('expected revision 1, now 2'))
    assert.equal(port.calls.length, 1)
  })

  it('detects a conflict by code alone, from an object that is not an Error', async () => {
    const thrown = { code: 'SETTINGS_CONFLICT', message: 'stale', expected: 3, actual: 4 }
    const port = createPort({ [NS]: { value: {}, revision: 1 } }, thrown)
    const patch = patchFor({ kind: 'set', path: ['a'], value: 1 })
    const result = await apply(port, patch, read(port, patch))
    assert.equal(result.state, 'conflict')
    assert.ok(result.detail.includes('now 4'))
  })

  it('does not mistake a message that merely looks like a conflict for one', async () => {
    const thrown = new Error('settings revision conflict: expected 1, found 2')
    const port = createPort({ [NS]: { value: {}, revision: 1 } }, thrown)
    const patch = patchFor({ kind: 'set', path: ['a'], value: 1 })
    assert.equal((await apply(port, patch, read(port, patch))).state, 'failed')
  })

  it('maps "has no volatile fields" to unsupported', async () => {
    const thrown = new Error(`Plugin entry "${NS}" has no volatile fields`)
    const port = createPort({ [NS]: { value: {}, revision: 1 } }, thrown)
    const patch = patchFor({ kind: 'set', path: ['a'], value: 1 })
    const result = await apply(port, patch, read(port, patch))
    assert.equal(result.state, 'unsupported')
    assert.ok(result.detail.includes('has no volatile fields'))
  })

  it('maps "is not volatile" to unsupported', async () => {
    const thrown = new Error('Config field "models.m1.max" is not volatile')
    const port = createPort({ [NS]: { value: {}, revision: 1 } }, thrown)
    const patch = patchFor({ kind: 'set', path: ['models', 'm1', 'max'], value: 'MAX' })
    assert.equal((await apply(port, patch, read(port, patch))).state, 'unsupported')
  })

  it('maps anything else to failed and keeps the host message', async () => {
    const port = createPort({ [NS]: { value: {}, revision: 1 } }, new Error('disk on fire'))
    const patch = patchFor({ kind: 'set', path: ['a'], value: 1 })
    const result = await apply(port, patch, read(port, patch))
    assert.equal(result.state, 'failed')
    assert.equal(result.detail, 'disk on fire')
  })

  it('never rethrows a describe() failure', async () => {
    const port = createPort()
    port.describe = () => {
      throw new Error('settings form is not ready')
    }
    const patch = patchFor({ kind: 'set', path: ['a'], value: 1 })
    assert.equal((await apply(port, patch, read(port, patch))).state, 'failed')
    assert.equal(read(port, patch).state, 'failed')
  })

  it('reports an absent namespace without writing', async () => {
    const port = createPort({ [OTHER]: { value: {}, revision: 1 } })
    const patch = patchFor({ kind: 'set', path: ['a'], value: 1 })
    const result = await apply(port, patch, read(port, patch))
    assert.equal(result.state, 'absent')
    assert.equal(port.calls.length, 0)
  })

  it('refuses to write an unexpanded generator request', async () => {
    const port = createPort({ [NS]: { value: {}, revision: 1 } })
    const patch = patchFor({ kind: 'set', path: ['a'], value: { $gen: 'ladder' } })
    const result = await apply(port, patch, read(port, patch))
    assert.equal(result.state, 'failed')
    assert.equal(port.calls.length, 0)
  })

  it('rejects an op kind that does not address a settings namespace', async () => {
    const port = createPort({ [NS]: { value: {}, revision: 1 } })
    const patch = patchFor({ kind: 'set-enabled', enabled: false })
    const result = await apply(port, patch, read(port, patch))
    assert.equal(result.state, 'failed')
    assert.ok(result.detail.includes('set-enabled'))
    assert.equal(port.calls.length, 0)
  })
})

describe('settings rollback', () => {
  it('rolls a set back by unsetting its path', async () => {
    const port = createPort({ [NS]: { value: { a: 1 }, revision: 2 } })
    const patch = patchFor({ kind: 'set', path: ['a', 'b'], value: 1 })
    const result = await rollback(port, patch, { a: {} })
    assert.equal(result.state, 'in-sync')
    assert.deepEqual(port.calls[0]?.ops, [{ op: 'unset', path: ['a', 'b'] }])
    assert.equal(result.before !== void 0, true)
  })

  it('rolls an unset back by restoring the journaled value', async () => {
    const port = createPort({ [NS]: { value: { a: {} }, revision: 2 } })
    const patch = patchFor({ kind: 'unset', path: ['a', 'b'] })
    const result = await rollback(port, patch, { a: { b: { max: 'MAX' }, c: 1 } })
    assert.equal(result.state, 'in-sync')
    assert.deepEqual(port.calls[0]?.ops, [{ op: 'set', path: ['a', 'b'], value: { max: 'MAX' } }])
    assert.ok(result.detail.includes('restoring'))
  })

  it('writes nothing when the journaled unset had nothing to remove', async () => {
    const port = createPort({ [NS]: { value: { a: 1 }, revision: 2 } })
    const patch = patchFor({ kind: 'unset', path: ['b'] })
    const result = await rollback(port, patch, { a: 1 })
    assert.equal(result.state, 'in-sync')
    assert.equal(port.calls.length, 0)
  })

  it('reports an absent namespace instead of writing', async () => {
    const port = createPort()
    const result = await rollback(port, patchFor({ kind: 'set', path: ['a'], value: 1 }), {})
    assert.equal(result.state, 'absent')
    assert.equal(port.calls.length, 0)
  })

  it('maps a rollback conflict and never throws', async () => {
    const port = createPort({ [NS]: { value: {}, revision: 1 } }, new FakeSettingsConflictError(1, 2))
    const result = await rollback(port, patchFor({ kind: 'set', path: ['a'], value: 1 }), {})
    assert.equal(result.state, 'conflict')
  })

  it('maps a rollback to a non-volatile path as unsupported', async () => {
    const thrown = new Error('Config field "a" is not volatile')
    const port = createPort({ [NS]: { value: {}, revision: 1 } }, thrown)
    const result = await rollback(port, patchFor({ kind: 'set', path: ['a'], value: 1 }), {})
    assert.equal(result.state, 'unsupported')
  })

  it('refuses to roll back an op kind it never wrote', async () => {
    const port = createPort({ [NS]: { value: {}, revision: 1 } })
    const result = await rollback(port, patchFor({ kind: 'code', edits: [] }), {})
    assert.equal(result.state, 'failed')
    assert.equal(port.calls.length, 0)
  })
})
