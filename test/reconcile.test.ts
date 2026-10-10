import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import type { ApplyResult, TargetSnapshot } from '../src/adapters/types.ts'
import { fingerprintOf, selectAt, writeAt } from '../src/engine/fingerprint.ts'
import { Journal } from '../src/engine/journal.ts'
import {
  reconcile,
  type EngineAdapter,
  type EngineAdapters,
  type EngineJournal,
  type ReconcileOptions,
} from '../src/engine/reconcile.ts'
import { loadSpec, type ResolvedSpec } from '../src/spec/resolve.ts'
import type { Json, Patch, Target, Value } from '../src/spec/types.ts'

const NS = 'llm-pi-ai'

/** Frozen, so a status compared across two runs cannot drift on a timestamp. */
const now = (): string => '2024-01-01T00:00:00.000Z'

let dir = ''

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'patcher-reconcile-'))
})

after(async () => {
  if (dir !== '') await rm(dir, { recursive: true, force: true })
})

/** Raw namespace values, as a settings form would hand them to loadSpec. */
function settingsSet(
  id: string,
  value: Json,
  extra: Record<string, unknown> = {},
  path: string[] = ['providers', 'openai'],
): Record<string, unknown> {
  return {
    id,
    reason: 'why ' + id,
    target: { kind: 'settings', namespace: NS },
    op: { kind: 'set', path, value },
    ...extra,
  }
}

function patchRow(id: string, rowId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    reason: 'why ' + id,
    target: { kind: 'patch-row', rowId },
    op: { kind: 'merge-config', config: { retries: 2 } },
    ...extra,
  }
}

/** The port is the document the adapter owns: one mutable value, handed in. */
interface FakePort {
  value: unknown
}

interface FakeOptions {
  /** Which target kind this binding is registered under. */
  kind?: Target['kind']
  /** Shared log, so a test can prove the order the engine drove the adapter in. */
  log?: string[]
  /** read() throws this instead of answering. */
  readThrows?: unknown
  /**
   * read() throws this, but only on the call the engine makes to see what a
   * write actually produced. The first read, the one that decides whether to
   * write at all, still answers.
   */
  readThrowsOnReRead?: unknown
  /** read() answers with this instead of judging the document itself. */
  readAs?: (patch: Patch) => TargetSnapshot
  /** apply() throws this instead of writing. */
  applyThrows?: unknown
  /** rollback() throws this instead of restoring. */
  rollbackThrows?: unknown
  /** What a write actually stores, for a world that is not verbatim. */
  writeAs?: (value: Value) => unknown
}

interface FakeCalls {
  reads: string[]
  applies: string[]
  rollbacks: { patchId: string; before: unknown }[]
}

interface Fake {
  adapter: EngineAdapter
  calls: FakeCalls
  log: string[]
}

/**
 * A settings-shaped adapter over one in-memory document.
 *
 * Drift is judged with the engine's own fingerprint and the engine's own
 * selectAt/writeAt, so "drifted" here means the same thing it means in
 * production. Only a `set` is applied; no other op is exercised through apply,
 * and rollback restores the whole journalled document because that is the level
 * the journal captures.
 */
function fakeAdapter(options: FakeOptions = {}): Fake {
  const log = options.log ?? []
  const calls: FakeCalls = { reads: [], applies: [], rollbacks: [] }

  const read = (port: FakePort, patch: Patch): TargetSnapshot => {
    calls.reads.push(patch.id)
    log.push('read:' + patch.id)
    if (options.readThrows !== void 0) throw options.readThrows
    if (options.readThrowsOnReRead !== void 0 && calls.applies.includes(patch.id)) {
      throw options.readThrowsOnReRead
    }
    if (options.readAs !== void 0) return options.readAs(patch)
    if (patch.op.kind === 'verify-only') {
      return { state: 'in-sync', value: port.value, detail: 'verified, nothing written' }
    }
    if (patch.op.kind === 'set') {
      const current = selectAt(port.value, patch.op.path)
      return fingerprintOf(current) === fingerprintOf(patch.op.value)
        ? { state: 'in-sync', value: port.value, detail: 'the value already matches' }
        : { state: 'drifted', value: port.value, detail: 'the value no longer matches the patch' }
    }
    return { state: 'unsupported', value: port.value, detail: 'this fake cannot judge the op' }
  }

  const apply = async (port: FakePort, patch: Patch, expected: TargetSnapshot): Promise<ApplyResult> => {
    calls.applies.push(patch.id)
    log.push('apply:' + patch.id)
    if (options.applyThrows !== void 0) throw options.applyThrows
    if (patch.op.kind === 'set') {
      const stored = options.writeAs !== void 0 ? options.writeAs(patch.op.value) : patch.op.value
      port.value = writeAt(port.value, patch.op.path, stored)
    }
    return { state: 'in-sync', detail: 'wrote ' + JSON.stringify(patch.op.value), before: expected.value }
  }

  const rollback = async (port: FakePort, patch: Patch, before: unknown): Promise<ApplyResult> => {
    calls.rollbacks.push({ patchId: patch.id, before })
    log.push('rollback:' + patch.id)
    if (options.rollbackThrows !== void 0) throw options.rollbackThrows
    port.value = before
    return { state: 'in-sync', detail: 'restored the value the journal recorded' }
  }

  // The engine types the port as `never` on purpose: nothing but the adapter may
  // look inside it, so the engine cannot name its shape. A fake has to name its
  // own port, and this cast is where that name is given back.
  const adapter = { kind: options.kind ?? 'settings', read, apply, rollback } as unknown as EngineAdapter
  return { adapter, calls, log }
}

/** The real journal, with every append echoed into a shared log. */
function loggingJournal(inner: Journal, log: string[]): EngineJournal {
  return {
    append: async (entry) => {
      log.push(entry.phase + ':' + entry.patchId)
      return inner.append(entry)
    },
    latest: (patchId) => inner.latest(patchId),
  }
}

/**
 * The real journal wrapped in the one failure it must survive: a refusal.
 *
 * EngineJournal is narrower than the Journal class precisely so this is
 * expressible, and every other write still goes to disk. Delegating is what
 * lets a test assert both what was refused and what still landed.
 */
function refusingJournal(inner: Journal, phases: ReadonlySet<'before' | 'after'>): EngineJournal {
  return {
    append: async (entry) => {
      if (phases.has(entry.phase)) {
        throw new Error('journal refused the ' + entry.phase + ' entry for ' + entry.patchId)
      }
      return inner.append(entry)
    },
    latest: (patchId) => inner.latest(patchId),
  }
}

/** One binding over the fake, one journal, and the frozen clock. */
function reconcileWith(
  spec: ResolvedSpec,
  fake: Fake,
  store: FakePort,
  journal: EngineJournal,
  extra: Partial<ReconcileOptions> = {},
): Promise<Awaited<ReturnType<typeof reconcile>>> {
  const adapters: EngineAdapters = { [fake.adapter.kind]: { adapter: fake.adapter, port: store } }
  return reconcile({ spec, adapters, journal, now, ...extra })
}

describe('reconcile: a patch is refused before the world is touched', () => {
  it('fails a patch the spec itself rejected, and never asks an adapter about it', async () => {
    const store: FakePort = { value: { enabled: true } }
    const fake = fakeAdapter({ kind: 'patch-row' })
    const journal = new Journal(join(dir, 'rejected.jsonl'))
    // A `set` cannot address a patch row. The adapter below is registered on
    // purpose: the rejection has to win over the adapter being available, or a
    // bad patch would still be read and written by a lenient engine.
    const spec = loadSpec({ patches: [patchRow('bad-row', 'row-1', { op: { kind: 'set', path: ['a'], value: 1 } })] })

    const [status] = await reconcileWith(spec, fake, store, journal)

    assert.equal(status.state, 'failed')
    assert.match(status.detail, /patches\[0\]\.op\.kind/)
    assert.match(status.detail, /cannot be patched with "set"/)
    assert.deepEqual(fake.calls.reads, [], 'a rejected patch is never even read')
    assert.deepEqual(await journal.read(), [])
  })

  it('puts both patches in conflict when two enabled patches claim the same patch row', async () => {
    const store: FakePort = { value: { enabled: true } }
    const fake = fakeAdapter({
      kind: 'patch-row',
      readAs: () => ({ state: 'in-sync', value: store.value, detail: 'the row is already as wanted' }),
    })
    const spec = loadSpec({ patches: [patchRow('first-claim', 'shared-row'), patchRow('second-claim', 'shared-row')] })

    const statuses = await reconcileWith(spec, fake, store, new Journal(join(dir, 'contested.jsonl')))

    assert.deepEqual(statuses.map((status) => status.state), ['conflict', 'conflict'])
    assert.match(statuses[0].detail, /shared-row/)
    assert.match(statuses[1].detail, /shared-row/)
    assert.deepEqual(fake.calls.reads, [], 'neither may be read: a row is one shared line')
  })

  it('says the build registers no adapter for a target kind instead of reporting success', async () => {
    const spec = loadSpec({ patches: [settingsSet('ladder', 'gpt-5')] })
    const fake = fakeAdapter()

    const statuses = await reconcile({ spec, adapters: {}, journal: new Journal(join(dir, 'no-adapter.jsonl')), now })

    assert.equal(statuses[0].state, 'unsupported')
    assert.match(statuses[0].detail, /no adapter for "settings"/)
    // An unsupported state is one the operator has to act on, so it carries a
    // hint, and the adapter's own words are the only ones available here.
    assert.equal(statuses[0].hint, statuses[0].detail)
    assert.deepEqual(fake.calls.reads, [])
  })

  it('stops a verify-only patch at the read, journalling nothing', async () => {
    const store: FakePort = { value: { providers: { openai: 'gpt-4' } } }
    // Even a drifted read must not turn into a write: verify-only is an
    // assertion, and the state it reports is exactly what the operator sees.
    const fake = fakeAdapter({
      readAs: () => ({ state: 'drifted', value: store.value, detail: 'the value does not match' }),
    })
    const journal = new Journal(join(dir, 'verify-only.jsonl'))
    const spec = loadSpec({
      patches: [
        {
          id: 'probe',
          reason: 'assert the ladder is set',
          target: { kind: 'settings', namespace: NS },
          op: { kind: 'verify-only' },
        },
      ],
    })

    const [status] = await reconcileWith(spec, fake, store, journal)

    assert.equal(status.state, 'drifted')
    assert.match(status.detail, /verify-only: nothing was written/)
    assert.deepEqual(fake.calls.applies, [], 'an assertion has no apply')
    assert.deepEqual(await journal.read(), [], 'an assertion has nothing to roll back')
  })
})

describe('reconcile: an enabled patch', () => {
  it('leaves a target that already matches untouched, writing nothing at all', async () => {
    const store: FakePort = { value: { providers: { openai: 'gpt-5' } } }
    const fake = fakeAdapter()
    const journal = new Journal(join(dir, 'in-sync.jsonl'))

    const [status] = await reconcileWith(loadSpec({ patches: [settingsSet('ladder', 'gpt-5')] }), fake, store, journal)

    assert.equal(status.state, 'in-sync')
    assert.deepEqual(fake.calls.applies, [])
    assert.deepEqual(fake.calls.rollbacks, [])
    assert.deepEqual(await journal.read(), [], 'an unchanged target is not a write worth journalling')
  })

  for (const state of ['absent', 'unsupported', 'failed'] as const) {
    it(`passes a read that reports ${state} straight through, writing nothing`, async () => {
      const store: FakePort = { value: { providers: { openai: 'gpt-4' } } }
      const fake = fakeAdapter({
        readAs: () => ({ state, value: store.value, detail: 'the target reads as ' + state }),
      })
      const journal = new Journal(join(dir, 'passthrough-' + state + '.jsonl'))

      const [status] = await reconcileWith(loadSpec({ patches: [settingsSet('ladder', 'gpt-5')] }), fake, store, journal)

      assert.equal(status.state, state)
      assert.equal(status.detail, 'the target reads as ' + state)
      assert.deepEqual(fake.calls.applies, [], 'a target the adapter cannot vouch for is not written')
      assert.deepEqual(await journal.read(), [])
    })
  }

  it('brackets the one write it makes with the value before and the value after', async () => {
    const store: FakePort = { value: { providers: { openai: 'gpt-4' } } }
    const fake = fakeAdapter()
    const journal = new Journal(join(dir, 'drifted.jsonl'))

    const [status] = await reconcileWith(loadSpec({ patches: [settingsSet('ladder', 'gpt-5')] }), fake, store, journal)

    assert.equal(status.state, 'in-sync')
    assert.deepEqual(store.value, { providers: { openai: 'gpt-5' } })
    const entries = await journal.read()
    assert.deepEqual(entries.map((entry) => entry.phase), ['before', 'after'])
    // The journal holds the whole document, not just the patched path: the pair
    // is the only thing a rollback has to restore from.
    assert.deepEqual(entries[0].value, { providers: { openai: 'gpt-4' } })
    assert.deepEqual(entries[1].value, { providers: { openai: 'gpt-5' } })
    assert.equal(entries[0].reason, 'why ladder', 'the patch reason is what an operator reads later')
  })

  it('journals what a fresh read finds, not what the write claimed to have written', async () => {
    const store: FakePort = { value: { providers: { openai: 'gpt-4' } } }
    // The world normalises what it stores, so the value a rollback would later
    // compare against is the stored one. An engine that believed apply's own
    // report would journal "gpt-5" and eventually restore the wrong thing.
    const fake = fakeAdapter({ writeAs: (value) => String(value).toUpperCase() })
    const journal = new Journal(join(dir, 'reread.jsonl'))

    const [status] = await reconcileWith(loadSpec({ patches: [settingsSet('ladder', 'gpt-5')] }), fake, store, journal)

    assert.equal(status.state, 'in-sync')
    assert.match(status.detail, /gpt-5/, 'the adapter reports the value it was asked to write')
    const [before, after] = await journal.read()
    assert.deepEqual(before?.value, { providers: { openai: 'gpt-4' } })
    assert.deepEqual(after?.value, { providers: { openai: 'GPT-5' } }, 'the after value is a real observation')
  })

  it('refuses to write anything the journal could not record', async () => {
    const store: FakePort = { value: { providers: { openai: 'gpt-4' } } }
    const fake = fakeAdapter()
    const journal = new Journal(join(dir, 'refuse-before.jsonl'))

    const [status] = await reconcileWith(
      loadSpec({ patches: [settingsSet('ladder', 'gpt-5')] }),
      fake,
      store,
      refusingJournal(journal, new Set(['before'])),
    )

    assert.equal(status.state, 'failed')
    assert.match(status.detail, /refusing to write: the journal could not record the previous value/)
    assert.deepEqual(fake.calls.applies, [], 'apply must be unreachable once the journal says no')
    assert.deepEqual(store.value, { providers: { openai: 'gpt-4' } }, 'the world is left exactly as it was')
    assert.deepEqual(await journal.read(), [])
  })

  it('reports a write that threw without pretending the patch is in sync', async () => {
    const store: FakePort = { value: { providers: { openai: 'gpt-4' } } }
    const fake = fakeAdapter({ applyThrows: new Error('settings file is read-only') })
    const journal = new Journal(join(dir, 'apply-throws.jsonl'))

    const [status] = await reconcileWith(loadSpec({ patches: [settingsSet('ladder', 'gpt-5')] }), fake, store, journal)

    assert.equal(status.state, 'failed')
    assert.equal(status.detail, 'settings file is read-only')
    // The before-entry survives, which is the whole point of writing it first:
    // a later reconcile sees a half pair and refuses to roll back on a guess.
    assert.deepEqual((await journal.read()).map((entry) => entry.phase), ['before'])
  })

  it('reports a conflict when the write landed but the journal could not be closed', async () => {
    const store: FakePort = { value: { providers: { openai: 'gpt-4' } } }
    const fake = fakeAdapter()
    const journal = new Journal(join(dir, 'refuse-after.jsonl'))

    const [status] = await reconcileWith(
      loadSpec({ patches: [settingsSet('ladder', 'gpt-5')] }),
      fake,
      store,
      refusingJournal(journal, new Set(['after'])),
    )

    assert.equal(status.state, 'conflict')
    assert.match(status.detail, /rollback/)
    assert.deepEqual(store.value, { providers: { openai: 'gpt-5' } }, 'the write really did land')
    assert.deepEqual((await journal.read()).map((entry) => entry.phase), ['before'])
  })
})

describe('reconcile: a disabled patch', () => {
  const before = { providers: { openai: 'gpt-4' } }
  const after = { providers: { openai: 'gpt-5' } }

  /** A complete, real pair on disk, written by the real journal. */
  const seedPair = async (file: string): Promise<Journal> => {
    const journal = new Journal(join(dir, file))
    await journal.append({ patchId: 'ladder', phase: 'before', value: before, reason: 'why ladder' })
    await journal.append({ patchId: 'ladder', phase: 'after', value: after, reason: 'why ladder' })
    return journal
  }

  const disabled = loadSpec({ patches: [settingsSet('ladder', 'gpt-5', { enabled: false })] })

  it('reports a patch that never wrote as in-sync, with nothing to undo', async () => {
    const store: FakePort = { value: { providers: { openai: 'gpt-4' } } }
    const fake = fakeAdapter()
    const journal = new Journal(join(dir, 'disabled-empty.jsonl'))

    const [status] = await reconcileWith(disabled, fake, store, journal)

    assert.equal(status.state, 'in-sync')
    assert.match(status.detail, /never wrote anything/)
    assert.deepEqual(fake.calls.applies, [])
    assert.deepEqual(fake.calls.rollbacks, [])
    assert.deepEqual(await journal.read(), [], 'a disabled patch with no history adds no history')
  })

  it('refuses to roll back a patch whose journal holds only a before', async () => {
    const store: FakePort = { value: after }
    const fake = fakeAdapter()
    const journal = new Journal(join(dir, 'half-before.jsonl'))
    await journal.append({ patchId: 'ladder', phase: 'before', value: before, reason: 'why ladder' })

    const [status] = await reconcileWith(disabled, fake, store, journal)

    assert.equal(status.state, 'conflict')
    assert.match(status.detail, /incomplete pair/)
    assert.deepEqual(fake.calls.rollbacks, [], 'a journal that cannot say what happened is not a licence to guess')
    assert.deepEqual(store.value, after, 'and nothing is rolled back on a guess either')
  })

  it('refuses to roll back a patch whose journal holds only an after', async () => {
    const store: FakePort = { value: after }
    const fake = fakeAdapter()
    const journal = new Journal(join(dir, 'half-after.jsonl'))
    await journal.append({ patchId: 'ladder', phase: 'after', value: after, reason: 'why ladder' })

    const [status] = await reconcileWith(disabled, fake, store, journal)

    assert.equal(status.state, 'conflict')
    assert.match(status.detail, /incomplete pair/)
    assert.deepEqual(fake.calls.rollbacks, [])
    assert.deepEqual(store.value, after)
  })

  it('closes a stale pair out instead of unsetting a value the operator has since set', async () => {
    const store: FakePort = { value: before }
    const fake = fakeAdapter()
    const journal = await seedPair('already-restored.jsonl')

    const [status] = await reconcileWith(disabled, fake, store, journal)

    assert.equal(status.state, 'in-sync')
    assert.match(status.detail, /already at its pre-patch value/)
    assert.deepEqual(fake.calls.rollbacks, [], 'a write that is already undone is not undone twice')
    const entries = await journal.read()
    assert.deepEqual(
      entries.map((entry) => entry.phase),
      ['before', 'after', 'before', 'after'],
      'the pair is re-closed, so the next reconcile stops seeing a stale half',
    )
    assert.deepEqual(await journal.latest('ladder'), { before, after: before })
  })

  it('restores the value the journal recorded, and nothing else', async () => {
    const store: FakePort = { value: after }
    const fake = fakeAdapter()
    const journal = await seedPair('rollback.jsonl')

    const [status] = await reconcileWith(disabled, fake, store, journal)

    assert.equal(status.state, 'in-sync')
    assert.match(status.detail, /restored the value the journal recorded/)
    assert.deepEqual(fake.calls.rollbacks, [{ patchId: 'ladder', before }])
    assert.deepEqual(store.value, before)
  })

  it('reports a rollback that threw, and leaves the target as it found it', async () => {
    const store: FakePort = { value: after }
    const fake = fakeAdapter({ rollbackThrows: new Error('the row is locked') })
    const journal = await seedPair('rollback-throws.jsonl')

    const [status] = await reconcileWith(disabled, fake, store, journal)

    assert.equal(status.state, 'failed')
    assert.equal(status.detail, 'the row is locked')
    assert.deepEqual(fake.calls.rollbacks, [{ patchId: 'ladder', before }])
    assert.deepEqual(store.value, after)
  })
})

describe('reconcile: the run as a whole', () => {
  it('drives patches one at a time, so two patches on one namespace cannot interleave', async () => {
    const log: string[] = []
    const store: FakePort = { value: { providers: { openai: 'gpt-4' } } }
    const fake = fakeAdapter({ log })
    const journal = new Journal(join(dir, 'serial.jsonl'))
    // Disjoint paths on purpose: the point of this test is the order, and two
    // patches writing the same path are refused by the spec before they get one.
    const spec = loadSpec({
      patches: [
        settingsSet('first', 'gpt-a', {}, ['providers', 'openai']),
        settingsSet('second', 'gpt-b', {}, ['providers', 'anthropic']),
      ],
    })

    await reconcileWith(spec, fake, store, loggingJournal(journal, log))

    // A parallel implementation would read both before writing either, and the
    // journal would hold before/before/after/after instead of two pairs.
    assert.deepEqual(log, [
      'read:first',
      'before:first',
      'apply:first',
      'read:first',
      'after:first',
      'read:second',
      'before:second',
      'apply:second',
      'read:second',
      'after:second',
    ])
    assert.deepEqual(
      (await journal.read()).map((entry) => entry.phase + ':' + entry.patchId),
      ['before:first', 'after:first', 'before:second', 'after:second'],
    )
  })

  it('recomputes the same statuses when nothing changed, so a second pass is a no-op', async () => {
    const store: FakePort = { value: { providers: { openai: 'gpt-4' } } }
    const fake = fakeAdapter()
    const journal = new Journal(join(dir, 'recompute.jsonl'))
    const spec = loadSpec({ patches: [settingsSet('ladder', 'gpt-5')] })

    // The pass that actually repairs something says so in its detail, and the
    // pass after it says "already matches": the two are honestly different
    // reports. The fixed point is therefore asserted from the second pass on,
    // which is the "nothing changed" case the property is about.
    await reconcileWith(spec, fake, store, journal)
    const second = await reconcileWith(spec, fake, store, journal)
    const third = await reconcileWith(spec, fake, store, journal)

    assert.deepEqual(third, second, 'a full recompute is a fixed point once the world is settled')
    assert.deepEqual(
      second.map((status) => status.state),
      ['in-sync'],
      'and that fixed point is the patch being in sync, not drifting again',
    )
    assert.equal(fake.calls.applies.length, 1, 'only the first pass had anything to write')
    assert.deepEqual((await journal.read()).map((entry) => entry.phase), ['before', 'after'])
  })

  it('reports no statuses at all for a spec that failed to load, rather than inventing healthy ones', async () => {
    const spec = loadSpec({ patches: 'not an array' })
    assert.equal(spec.config, undefined)
    const fake = fakeAdapter()
    const store: FakePort = { value: {} }

    const statuses = await reconcileWith(spec, fake, store, new Journal(join(dir, 'broken-spec.jsonl')))

    assert.equal(statuses.length, 0)
    assert.deepEqual(statuses, [])
    assert.deepEqual(fake.calls.reads, [])
    assert.ok(spec.diagnostics.length > 0, 'the caller renders these instead of a list of green rows')
  })

  it('fails only the patch whose target could not be read', async () => {
    const brokenStore: FakePort = { value: { providers: { openai: 'gpt-4' } } }
    const broken = fakeAdapter({ readThrows: new Error('describe() blew up') })
    const rowStore: FakePort = { value: { enabled: true } }
    const healthy = fakeAdapter({
      kind: 'patch-row',
      readAs: () => ({ state: 'in-sync', value: rowStore.value, detail: 'the row is already enabled' }),
    })
    const spec = loadSpec({ patches: [settingsSet('ladder', 'gpt-5'), patchRow('row', 'row-1')] })

    const statuses = await reconcile({
      spec,
      adapters: {
        settings: { adapter: broken.adapter, port: brokenStore },
        'patch-row': { adapter: healthy.adapter, port: rowStore },
      },
      journal: new Journal(join(dir, 'read-throws.jsonl')),
      now,
    })

    assert.deepEqual(
      statuses.map((status) => [status.patchId, status.state]),
      [['ladder', 'failed'], ['row', 'in-sync']],
    )
    assert.equal(statuses[0].detail, 'describe() blew up')
    assert.equal(healthy.calls.reads.length, 1, 'the healthy sibling still reconciled')
  })

  it('hands each finished patch to onStatus as it goes, not in one batch at the end', async () => {
    const log: string[] = []
    const store: FakePort = { value: { providers: { openai: 'gpt-4' } } }
    const fake = fakeAdapter({
      log,
      readAs: () => ({ state: 'in-sync', value: store.value, detail: 'already matches' }),
    })
    const seen: string[] = []
    const spec = loadSpec({
      patches: [
        settingsSet('one', 'gpt-a', {}, ['providers', 'openai']),
        settingsSet('two', 'gpt-b', {}, ['providers', 'anthropic']),
      ],
    })

    const statuses = await reconcileWith(spec, fake, store, new Journal(join(dir, 'on-status.jsonl')), {
      onStatus: (status) => {
        seen.push(status.patchId)
        log.push('status:' + status.patchId)
      },
    })

    assert.deepEqual(log, ['read:one', 'status:one', 'read:two', 'status:two'])
    assert.deepEqual(seen, ['one', 'two'])
    assert.deepEqual(
      statuses.map((status) => status.patchId),
      seen,
      'the reported statuses and the reported callbacks are the same objects',
    )
  })
})


describe('reconcile: when the journal cannot be trusted', () => {
  it('leaves the pair open rather than recording a value the target does not hold', async () => {
    // The write lands, then the value it produced cannot be read back. Writing
    // the adapter's own "before" into the after slot would make the
    // write-ahead record lie, so the pair stays open and says why.
    const store: FakePort = { value: { providers: { openai: 'gpt-4' } } }
    const fake = fakeAdapter({ readThrowsOnReRead: new Error('the settings file vanished') })
    const journal = new Journal(join(dir, 'unclosable-pair.jsonl'))

    const [status] = await reconcileWith(loadSpec({ patches: [settingsSet('p', 'gpt-5')] }), fake, store, journal)

    assert.equal(status.state, 'conflict')
    assert.match(status.detail, /could not be read back/)
    assert.deepEqual(store.value, { providers: { openai: 'gpt-5' } }, 'the write did land')
    const entries = await journal.read()
    assert.deepEqual(entries.map((entry) => entry.phase), ['before'], 'no after entry was invented')
    assert.equal(await journal.latest('p')?.then((pair) => pair?.after), undefined)
  })

  it('refuses to read an unreadable journal as a patch that never wrote', async () => {
    // A disabled patch whose journal read fails. Answering in-sync would leave
    // whatever the patch wrote sitting in the target while the page claims
    // there was nothing to undo.
    const store: FakePort = { value: { providers: { openai: 'gpt-4' } } }
    const fake = fakeAdapter()
    const real = new Journal(join(dir, 'unreadable.jsonl'))
    const blind: EngineJournal = {
      append: (entry) => real.append(entry),
      latest: () => Promise.reject(new Error('EACCES: permission denied')),
    }

    const [status] = await reconcileWith(
      loadSpec({ patches: [settingsSet('ladder', 'gpt-5', { enabled: false })] }),
      fake,
      store,
      blind,
    )

    assert.equal(status.state, 'failed')
    assert.match(status.detail, /could not be read/)
    assert.match(status.detail, /whether this patch wrote anything/)
    assert.deepEqual(fake.calls.rollbacks, [], 'nothing was rolled back on a guess')
  })
})
