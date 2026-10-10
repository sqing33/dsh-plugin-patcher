import assert from 'node:assert/strict'
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { Journal, type JournalEntry } from '../src/engine/journal.ts'

let dir = ''
let path = ''

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'patcher-journal-'))
  path = join(dir, 'nested', 'writes.jsonl')
})

after(async () => {
  if (dir !== '') await rm(dir, { recursive: true, force: true })
})

function line(patchId: string, phase: 'before' | 'after', value: unknown, at = '2024-01-01T00:00:00.000Z'): string {
  return JSON.stringify({ patchId, at, phase, value, reason: 'r' })
}

describe('Journal.append and read', () => {
  it('round-trips an entry, filling in its own timestamp', async () => {
    const file = join(dir, 'roundtrip.jsonl')
    const journal = new Journal(file)
    const stored = await journal.append({ patchId: 'a', phase: 'before', value: { x: 1 }, reason: 'why' })
    assert.match(stored.at, /^\d{4}-\d{2}-\d{2}T.*Z$/)
    assert.equal(stored.reason, 'why')
    const [read] = await journal.read()
    assert.deepEqual(read, stored)
  })

  it('writes one newline-terminated line per append, in order', async () => {
    const file = join(dir, 'lines.jsonl')
    const journal = new Journal(file)
    for (let index = 0; index < 3; index += 1) {
      await journal.append({ patchId: 'a', phase: 'before', value: index, reason: 'r' })
    }
    const raw = await readFile(file, 'utf8')
    assert.equal(raw.split('\n').length - 1, 3)
    const entries = await journal.read()
    assert.deepEqual(entries.map((entry) => entry.value), [0, 1, 2])
  })

  it('fsyncs the file before the append resolves', async () => {
    const file = join(dir, 'fsync.jsonl')
    const journal = new Journal(file)
    const probe = await open(join(dir, 'probe.txt'), 'a')
    const proto = Object.getPrototypeOf(probe) as { sync: (...args: unknown[]) => Promise<void> }
    await probe.close()
    const original = proto.sync
    let syncs = 0
    proto.sync = async function patched(this: unknown, ...args: unknown[]) {
      syncs += 1
      return original.apply(this, args)
    }
    try {
      await journal.append({ patchId: 'a', phase: 'before', value: 1, reason: 'r' })
      assert.equal(syncs, 1, 'append must fsync exactly once')
      // The line is on disk the moment append resolves, which is what makes
      // the sync meaningful rather than decorative.
      const entries = await journal.read()
      assert.equal(entries.length, 1)
    } finally {
      proto.sync = original
      await rm(file, { force: true })
    }
  })

  it('creates the parent directory on first use', async () => {
    const file = join(dir, 'deep', 'deeper', 'again', 'writes.jsonl')
    const journal = new Journal(file)
    await journal.append({ patchId: 'a', phase: 'before', value: 1, reason: 'r' })
    assert.equal((await journal.read()).length, 1)
  })

  it('returns [] for a journal that was never written', async () => {
    assert.deepEqual(await new Journal(join(dir, 'missing.jsonl')).read(), [])
  })

  it('preserves an undefined value as undefined rather than null', async () => {
    const file = join(dir, 'undefined.jsonl')
    const journal = new Journal(file)
    await journal.append({ patchId: 'a', phase: 'before', value: void 0, reason: 'r' })
    const [entry] = await journal.read()
    assert.equal(entry?.value, void 0)
    assert.notEqual(entry?.value, null)
  })

  it('drops an undefined object key, the way JSON does', async () => {
    const file = join(dir, 'dropped.jsonl')
    const journal = new Journal(file)
    await journal.append({ patchId: 'a', phase: 'before', value: { keep: 1, gone: void 0 }, reason: 'r' })
    assert.deepEqual((await journal.read())[0]?.value, { keep: 1 })
  })
})

describe('Journal.read against a damaged file', () => {
  it('skips a trailing partial line left by a crash mid-write', async () => {
    const file = join(dir, 'partial.jsonl')
    await writeFile(file, line('a', 'before', 1) + '\n' + line('b', 'before', 2) + '\n{"patchId":"c","pha')
    const entries = await new Journal(file).read()
    assert.deepEqual(entries.map((entry) => entry.patchId), ['a', 'b'])
  })

  it('skips a malformed complete line and keeps the rest', async () => {
    const file = join(dir, 'malformed.jsonl')
    await writeFile(file, [line('a', 'before', 1), 'not json at all', line('b', 'after', 2), '[]', '""'].join('\n') + '\n')
    const entries = await new Journal(file).read()
    assert.deepEqual(entries.map((entry) => entry.patchId), ['a', 'b'])
  })

  it('skips a line that parses but is not an entry', async () => {
    const file = join(dir, 'wrongshape.jsonl')
    await writeFile(file, [
      line('a', 'before', 1),
      JSON.stringify({ patchId: 'x', phase: 'maybe', at: 'now', reason: 'r' }),
      JSON.stringify({ phase: 'before', at: 'now', reason: 'r' }),
      JSON.stringify({ patchId: 'y', at: 'now', reason: 'r' }),
    ].join('\n') + '\n')
    assert.deepEqual((await new Journal(file).read()).map((entry) => entry.patchId), ['a'])
  })

  it('never throws, whatever is in the file', async () => {
    const file = join(dir, 'binary.jsonl')
    await writeFile(file, '\u0000\u0001\u0002 garbage \n')
    assert.deepEqual(await new Journal(file).read(), [])
  })
})

describe('Journal.latest', () => {
  it('returns undefined for a patch the journal never saw', async () => {
    assert.equal(await new Journal(join(dir, 'empty.jsonl')).latest('nope'), void 0)
  })

  it('pairs the newest before with the after that follows it', async () => {
    const file = join(dir, 'latest.jsonl')
    const journal = new Journal(file)
    await journal.append({ patchId: 'a', phase: 'before', value: 'first', reason: 'r' })
    await journal.append({ patchId: 'a', phase: 'after', value: 'applied-1', reason: 'r' })
    await journal.append({ patchId: 'a', phase: 'before', value: 'drifted-back', reason: 'r' })
    await journal.append({ patchId: 'a', phase: 'after', value: 'applied-2', reason: 'r' })
    assert.deepEqual(await journal.latest('a'), { before: 'drifted-back', after: 'applied-2' })
  })

  it('keeps patches apart', async () => {
    const file = join(dir, 'twopatches.jsonl')
    const journal = new Journal(file)
    await journal.append({ patchId: 'a', phase: 'before', value: 1, reason: 'r' })
    await journal.append({ patchId: 'a', phase: 'after', value: 2, reason: 'r' })
    await journal.append({ patchId: 'b', phase: 'before', value: 3, reason: 'r' })
    await journal.append({ patchId: 'b', phase: 'after', value: 4, reason: 'r' })
    assert.deepEqual(await journal.latest('a'), { before: 1, after: 2 })
    assert.deepEqual(await journal.latest('b'), { before: 3, after: 4 })
  })

  it('reports a crashed apply as a before with no after', async () => {
    const file = join(dir, 'crashed.jsonl')
    const journal = new Journal(file)
    await journal.append({ patchId: 'a', phase: 'before', value: { safe: true }, reason: 'r' })
    const pair = await journal.latest('a')
    assert.ok(pair !== void 0, 'a crashed apply is still known')
    assert.deepEqual(pair?.before, { safe: true })
    assert.equal(pair?.after, void 0)
    assert.ok('after' in (pair ?? {}), 'after is present and undefined, not merely missing')
  })
})

describe('Journal.pairOf', () => {
  const entry = (patchId: string, phase: 'before' | 'after', value: unknown): JournalEntry => ({
    patchId,
    at: '2024-01-01T00:00:00.000Z',
    phase,
    value,
    reason: 'r',
  })

  it('needs no disk at all', () => {
    assert.deepEqual(Journal.pairOf([entry('a', 'before', 1), entry('a', 'after', 2)], 'a'), {
      before: 1,
      after: 2,
    })
  })

  it('returns undefined when the patch is absent', () => {
    assert.equal(Journal.pairOf([entry('b', 'before', 1)], 'a'), void 0)
    assert.equal(Journal.pairOf([], 'a'), void 0)
  })

  it('never pairs an after that predates the last before', () => {
    const entries = [entry('a', 'before', 1), entry('a', 'after', 2), entry('a', 'before', 3)]
    assert.deepEqual(Journal.pairOf(entries, 'a'), { before: 3, after: void 0 })
  })

  it('takes the first after that follows the before', () => {
    const entries = [entry('a', 'before', 1), entry('a', 'after', 2), entry('a', 'after', 3)]
    assert.deepEqual(Journal.pairOf(entries, 'a'), { before: 1, after: 2 })
  })

  it('ignores other patches interleaved between the pair', () => {
    const entries = [
      entry('a', 'before', 1),
      entry('b', 'before', 9),
      entry('b', 'after', 10),
      entry('a', 'after', 2),
    ]
    assert.deepEqual(Journal.pairOf(entries, 'a'), { before: 1, after: 2 })
  })

  it('reports an orphan after rather than pretending the patch never ran', () => {
    assert.deepEqual(Journal.pairOf([entry('a', 'after', 2)], 'a'), { before: void 0, after: 2 })
  })

  it('preserves an undefined value through the pair', () => {
    assert.deepEqual(Journal.pairOf([entry('a', 'before', void 0), entry('a', 'after', 2)], 'a'), {
      before: void 0,
      after: 2,
    })
  })
})

describe('Journal value rejection', () => {
  const rejected = async (value: unknown): Promise<string> => {
    const journal = new Journal(join(dir, 'rejected.jsonl'))
    try {
      await journal.append({ patchId: 'a', phase: 'before', value, reason: 'r' })
    } catch (error) {
      assert.ok(error instanceof TypeError, 'rejection must be a TypeError')
      return (error as TypeError).message
    }
    throw new Error('append accepted a value it must reject')
  }

  it('rejects an undefined inside an array, naming the path', async () => {
    assert.equal(await rejected({ patches: [{ value: [1, void 0] }] }),
      'journal value contains an undefined at $.patches[0].value[1]')
  })

  it('rejects a function, naming the path', async () => {
    assert.equal(
      await rejected({ patches: [{ value: () => 1 }] }),
      'journal value contains a function at $.patches[0].value',
    )
  })

  it('rejects a symbol', async () => {
    assert.equal(await rejected({ a: { b: Symbol('s') } }), 'journal value contains a symbol at $.a.b')
  })

  it('rejects a bigint', async () => {
    assert.equal(await rejected({ a: 1n }), 'journal value contains a bigint at $.a')
  })

  it('rejects a Date', async () => {
    assert.equal(await rejected({ at: new Date(0) }), 'journal value contains a date at $.at')
  })

  it('rejects a Map', async () => {
    assert.equal(await rejected({ a: new Map([['k', 'v']]) }), 'journal value contains a map at $.a')
  })

  it('rejects a Set', async () => {
    assert.equal(await rejected({ a: new Set([1]) }), 'journal value contains a set at $.a')
  })

  it('rejects a cycle', async () => {
    const node: Record<string, unknown> = {}
    node.back = node
    // The path names the key that closes the loop, not the object it points at.
    assert.equal(await rejected({ a: node }), 'journal value contains a cycle at $.a.back')
  })

  it('rejects a cycle that runs through an array', async () => {
    const list: unknown[] = []
    list.push({ list })
    assert.equal(await rejected(list), 'journal value contains a cycle at $[0].list')
  })

  it('rejects a value that is itself a function', async () => {
    assert.equal(await rejected(() => 1), 'journal value contains a function at $')
  })

  it('quotes a key that is not a plain identifier', async () => {
    assert.equal(await rejected({ 'odd key': { deep: Symbol('s') } }),
      "journal value contains a symbol at $['odd key'].deep")
  })

  it('leaves no line behind when it refuses', async () => {
    const file = join(dir, 'nolines.jsonl')
    const journal = new Journal(file)
    await assert.rejects(
      journal.append({ patchId: 'a', phase: 'before', value: { bad: new Date(0) }, reason: 'r' }),
      TypeError,
    )
    assert.deepEqual(await journal.read(), [])
  })

  it('still accepts everything JSON can carry', async () => {
    const file = join(dir, 'valid.jsonl')
    const journal = new Journal(file)
    const value = { s: 'x', n: 1.5, b: false, nil: null, list: [1, 'two', null], deep: { 'odd key': [] } }
    await journal.append({ patchId: 'a', phase: 'before', value, reason: 'r' })
    assert.deepEqual((await journal.read())[0]?.value, value)
  })
})
