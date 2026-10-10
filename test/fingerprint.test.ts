import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  expectedFingerprint,
  fingerprintOf,
  patchFingerprint,
  selectAt,
  touchedPaths,
  writeAt,
} from '../src/engine/fingerprint.ts'
import type { Op, Patch } from '../src/spec/types.ts'

function patchOf(op: Op): Patch {
  return {
    id: 'p1',
    enabled: true,
    reason: 'test',
    target: { kind: 'settings', namespace: 'llm-pi-ai' },
    op,
  }
}

const SET = patchOf({ kind: 'set', path: ['providers', 'a', 'reasoning'], value: 'high' })
const UNSET = patchOf({ kind: 'unset', path: ['providers', 'a', 'reasoning'] })
const MERGE = patchOf({ kind: 'merge-config', config: { retries: 2 } })
const ENABLE = patchOf({ kind: 'set-enabled', enabled: true })
const CODE = patchOf({ kind: 'code', edits: [{ find: 'old', replace: 'new', count: 1 }] })
const VERIFY = patchOf({ kind: 'verify-only' })

describe('fingerprintOf', () => {
  it('is a 16 character hex digest', () => {
    assert.match(fingerprintOf({ a: 1 }), /^[0-9a-f]{16}$/)
  })

  it('ignores object key order, at every depth', () => {
    assert.equal(
      fingerprintOf({ a: 1, b: { c: 2, d: [3, 4] } }),
      fingerprintOf({ b: { d: [3, 4], c: 2 }, a: 1 }),
    )
  })

  it('keeps array order significant, because [a,b] and [b,a] differ', () => {
    assert.notEqual(fingerprintOf([1, 2]), fingerprintOf([2, 1]))
    assert.notEqual(fingerprintOf({ x: [1, 2] }), fingerprintOf({ x: [2, 1] }))
  })

  it('does not confuse an array with an object that has the same keys', () => {
    assert.notEqual(fingerprintOf([1, 2]), fingerprintOf({ 0: 1, 1: 2 }))
  })

  it('keeps undefined distinct from null', () => {
    assert.notEqual(fingerprintOf(void 0), fingerprintOf(null))
    assert.notEqual(fingerprintOf({ a: void 0 }), fingerprintOf({ a: null }))
    assert.notEqual(fingerprintOf({ a: [void 0] }), fingerprintOf({ a: [null] }))
  })

  it('keeps an absent key distinct from a present undefined one', () => {
    assert.notEqual(fingerprintOf({}), fingerprintOf({ a: void 0 }))
  })

  it('does not confuse a number with its string form', () => {
    assert.notEqual(fingerprintOf(1), fingerprintOf('1'))
  })

  it('tolerates a cycle instead of throwing on it', () => {
    const node: Record<string, unknown> = { name: 'a' }
    node.self = node
    assert.match(fingerprintOf(node), /^[0-9a-f]{16}$/)
  })

  it('hashes two structurally identical cycles alike', () => {
    const one: Record<string, unknown> = { name: 'a' }
    one.self = one
    const two: Record<string, unknown> = { name: 'a' }
    two.self = two
    assert.equal(fingerprintOf(one), fingerprintOf(two))
  })

  it('keeps a self-cycle apart from a deeper one', () => {
    const shallow: Record<string, unknown> = {}
    shallow.self = shallow
    const deep: Record<string, unknown> = { child: {} }
    const inner = deep['child'] as Record<string, unknown>
    inner['back'] = inner
    assert.notEqual(fingerprintOf(shallow), fingerprintOf(deep))
  })

  it('treats a repeated reference as shared, not as a cycle', () => {
    const shared = { x: 1 }
    assert.equal(fingerprintOf([shared, shared]), fingerprintOf([{ x: 1 }, { x: 1 }]))
  })

  it('survives a cycle that hangs off an array', () => {
    const list: unknown[] = [1]
    list.push(list)
    assert.match(fingerprintOf(list), /^[0-9a-f]{16}$/)
  })
})

describe('touchedPaths', () => {
  it('reports the path of a set', () => {
    assert.deepEqual(touchedPaths(SET), ['providers', 'a', 'reasoning'])
  })

  it('reports the path of an unset', () => {
    assert.deepEqual(touchedPaths(UNSET), ['providers', 'a', 'reasoning'])
  })

  it('reports nothing for an op that owns the whole target', () => {
    for (const patch of [MERGE, ENABLE, CODE, VERIFY]) {
      assert.deepEqual(touchedPaths(patch), [], patch.op.kind + ' must address the whole target')
    }
  })

  it('hands back a copy, so a caller cannot rewrite the spec', () => {
    const path = touchedPaths(SET)
    path.push('mutated')
    assert.deepEqual(touchedPaths(SET), ['providers', 'a', 'reasoning'])
  })
})

describe('selectAt', () => {
  const current = { a: { b: { c: 'deep' } }, list: [{ id: 'first' }, { id: 'second' }] }

  it('reads nested object keys', () => {
    assert.equal(selectAt(current, ['a', 'b', 'c']), 'deep')
  })

  it('reads a numeric array index', () => {
    assert.deepEqual(selectAt(current, ['list', '1', 'id']), 'second')
  })

  it('reads undefined for a path that is not there', () => {
    assert.equal(selectAt(current, ['a', 'missing']), void 0)
    assert.equal(selectAt(current, ['nope', 'deeper']), void 0)
  })

  it('reads undefined past the end of an array', () => {
    assert.equal(selectAt(current, ['list', '2']), void 0)
  })

  it('refuses a non-canonical index rather than coercing it', () => {
    assert.equal(selectAt(current, ['list', '01']), void 0)
    assert.equal(selectAt(current, ['list', '-1']), void 0)
    assert.equal(selectAt(current, ['list', 'id']), void 0)
  })

  it('does not read through a scalar', () => {
    assert.equal(selectAt({ a: 'text' }, ['a', 'b']), void 0)
  })

  it('returns the root itself for an empty path', () => {
    assert.equal(selectAt(current, []), current)
  })
})

describe('writeAt', () => {
  it('writes a nested key and creates the missing intermediates', () => {
    const out = writeAt({ a: { b: 1 } }, ['a', 'c', 'd'], 'written')
    assert.deepEqual(out, { a: { b: 1, c: { d: 'written' } } })
  })

  it('grows a document that does not exist yet', () => {
    assert.deepEqual(writeAt(void 0, ['a', 'b'], 1), { a: { b: 1 } })
  })

  it('clones only the containers along the path', () => {
    const inner = { keep: true }
    const current = { a: { b: 1 }, sibling: inner }
    const out = writeAt(current, ['a', 'b'], 2) as Record<string, Record<string, unknown>>
    assert.equal(out['a']?.['b'], 2)
    assert.equal((current['a'] as Record<string, unknown>)['b'], 1, 'the input must not be mutated')
    assert.notEqual(out['a'], current['a'], 'the walked container is cloned')
    assert.equal(out['sibling'], inner, 'an untouched sibling keeps its reference')
  })

  it('writes into an array in place', () => {
    assert.deepEqual(writeAt({ list: ['a', 'b'] }, ['list', '1'], 'B'), { list: ['a', 'B'] })
    assert.deepEqual(writeAt(['a', 'b'], ['0'], 'A'), ['A', 'b'])
  })

  it('turns a numeric segment with no array into a plain key', () => {
    assert.deepEqual(writeAt({}, ['a', '3'], 'x'), { a: { '3': 'x' } })
  })

  it('throws on an empty path', () => {
    assert.throws(() => writeAt({ a: 1 }, [], 1), /non-empty path/)
  })

  it('throws when the root is not a container', () => {
    assert.throws(() => writeAt('scalar', ['a'], 1), TypeError)
    assert.throws(() => writeAt(7, ['a'], 1), TypeError)
  })

  it('throws when an intermediate is a scalar or null', () => {
    assert.throws(() => writeAt({ a: 'text' }, ['a', 'b'], 1), /non-object at \$\.a/)
    assert.throws(() => writeAt({ a: 1 }, ['a', 'b'], 2), /non-object at \$\.a/)
    assert.throws(() => writeAt({ a: null }, ['a', 'b'], 1), /non-object at \$\.a/)
  })

  it('throws on an out-of-range array index instead of growing the array', () => {
    assert.throws(() => writeAt({ list: ['a'] }, ['list', '1'], 'b'), /out of range at \$\.list\[1\]/)
    assert.throws(() => writeAt([], ['0'], 'b'), /out of range/)
  })

  it('throws when a non-index key is used on an array', () => {
    assert.throws(() => writeAt({ list: ['a'] }, ['list', 'id'], 'b'), /as an array index/)
  })

  it('names the offending path in the message', () => {
    assert.throws(() => writeAt({ a: { 'odd key': 'text' } }, ['a', 'odd key', 'b'], 1), /\['odd key'\]/)
  })
})

describe('patchFingerprint', () => {
  const before = {
    providers: { a: { reasoning: 'high', models: [{ id: 'm1' }] } },
    unrelated: { keep: 'me' },
  }

  it('is unmoved when an untouched sibling changes', () => {
    const after = structuredClone(before)
    after.unrelated['keep'] = 'changed by someone else'
    after.providers['a']['models'][0] = { id: 'm2' }
    assert.equal(patchFingerprint(SET, before), patchFingerprint(SET, after))
  })

  it('moves when the value the op owns changes', () => {
    const drifted = structuredClone(before)
    drifted.providers['a']['reasoning'] = 'low'
    assert.notEqual(patchFingerprint(SET, before), patchFingerprint(SET, drifted))
  })

  it('hashes the whole target for a target-wide op, so a sibling does move it', () => {
    const other = structuredClone(before)
    other.unrelated['keep'] = 'changed by someone else'
    assert.notEqual(patchFingerprint(MERGE, before), patchFingerprint(MERGE, other))
  })

  it('folds in the op, so two claims about one place stay distinguishable', () => {
    const sameValue = patchOf({ kind: 'set', path: ['providers', 'a', 'reasoning'], value: 'high' })
    const otherPath = patchOf({ kind: 'set', path: ['providers', 'b', 'reasoning'], value: 'high' })
    const otherKind = patchOf({ kind: 'unset', path: ['providers', 'a', 'reasoning'] })
    assert.equal(patchFingerprint(SET, before), patchFingerprint(sameValue, before))
    assert.notEqual(patchFingerprint(SET, before), patchFingerprint(otherPath, before))
    assert.notEqual(patchFingerprint(SET, before), patchFingerprint(otherKind, before))
  })
})

describe('expectedFingerprint', () => {
  it('agrees with the current side when a set has been applied', () => {
    const current = { providers: { a: { reasoning: 'high' } } }
    assert.equal(patchFingerprint(SET, current), expectedFingerprint(SET, 'high'))
  })

  it('disagrees while the set is still pending', () => {
    const current = { providers: { a: { reasoning: 'low' } } }
    assert.notEqual(patchFingerprint(SET, current), expectedFingerprint(SET, 'high'))
  })

  it('agrees for an unset only once the key is really gone', () => {
    const applied = { providers: { a: { models: [] } } }
    const pending = { providers: { a: { reasoning: 'high', models: [] } } }
    const desired = { providers: { a: { models: [] } } }
    assert.equal(patchFingerprint(UNSET, applied), expectedFingerprint(UNSET, desired))
    assert.notEqual(patchFingerprint(UNSET, pending), expectedFingerprint(UNSET, desired))
  })

  it('agrees for a target-wide op when the whole value matches', () => {
    const value = { config: { retries: 2 } }
    assert.equal(patchFingerprint(MERGE, value), expectedFingerprint(MERGE, value))
    assert.notEqual(patchFingerprint(MERGE, value), expectedFingerprint(MERGE, { config: { retries: 3 } }))
  })

  it('reads the desired side through the same window for every whole-target op', () => {
    const value = { config: { retries: 2 } }
    for (const patch of [MERGE, ENABLE, CODE, VERIFY]) {
      assert.equal(patchFingerprint(patch, value), expectedFingerprint(patch, value), patch.op.kind)
    }
  })

  it('ignores key order on both sides, so a reformat is not drift', () => {
    const current = { providers: { a: { reasoning: 'high' } }, other: 1 }
    const reordered = { other: 1, providers: { a: { reasoning: 'high' } } }
    assert.equal(patchFingerprint(SET, current), patchFingerprint(SET, reordered))
  })

  it('keeps an applied set in sync even when the rest of the target changed', () => {
    const current = { providers: { a: { reasoning: 'high' } }, other: 1 }
    const moved = { providers: { a: { reasoning: 'high' } }, other: 2 }
    assert.equal(patchFingerprint(SET, current), expectedFingerprint(SET, 'high'))
    assert.equal(patchFingerprint(SET, moved), expectedFingerprint(SET, 'high'))
  })
})
