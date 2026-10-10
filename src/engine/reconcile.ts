import type { ApplyResult, PatcherStatus, PatchState, TargetSnapshot } from '../adapters/types.ts'
import { fingerprintOf } from './fingerprint.ts'
import type { JournalEntry, JournalPair } from './journal.ts'
import { describeTarget, type ResolvedSpec } from '../spec/resolve.ts'
import type { Json, Patch, Target } from '../spec/types.ts'

/**
 * The reconcile loop: read every target, compare it against what the spec
 * wants, and write only the difference.
 *
 * Two properties are load-bearing and both come from the shape of the problem
 * rather than from taste:
 *
 * - A reconcile is a **full recomputation**, never an incremental update. The
 *   set of patches, their targets and their desired values can all change in
 *   one settings write, and there is no cheaper correct way to answer "where
 *   does the world stand right now" than to walk every patch again. It also
 *   makes the loop idempotent: running it twice in a row is the same as running
 *   it once.
 * - Patches are processed **sequentially**, never in parallel. Two patches can
 *   address the same settings namespace, and every write is bracketed by two
 *   journal appends that are only meaningful in order.
 */

export interface EngineAdapter {
  readonly kind: Target['kind']
  read(port: never, patch: Patch): TargetSnapshot
  apply(port: never, patch: Patch, expected: TargetSnapshot): Promise<ApplyResult>
  rollback(port: never, patch: Patch, before: unknown): Promise<ApplyResult>
}

/** One target kind's adapter plus the live port it should be used through. */
export interface EngineBinding {
  adapter: EngineAdapter
  /** Opaque to the engine; the adapter is the only thing that may look inside. */
  port: unknown
}

/**
 * The journal surface the engine needs.
 *
 * Narrower than the Journal class on purpose: the engine must be able to
 * simulate a journal that refuses to write, which is the one failure it treats
 * as a stop sign rather than a warning.
 */
export interface EngineJournal {
  append(entry: Omit<JournalEntry, 'at'>): Promise<JournalEntry>
  latest(patchId: string): Promise<JournalPair | undefined>
}

export interface EngineAdapters {
  settings?: EngineBinding
  'patch-row'?: EngineBinding
  'package-file'?: EngineBinding
}

export interface ReconcileOptions {
  spec: ResolvedSpec
  adapters: EngineAdapters
  journal: EngineJournal
  /** Injected so tests get stable timestamps. */
  now?: () => string
  /** Called as each patch finishes, for a live-updating settings page. */
  onStatus?: (status: PatcherStatus) => void
}

interface PatchContext {
  spec: ResolvedSpec
  adapters: EngineAdapters
  journal: EngineJournal
  now: () => string
}

/** JSONL cannot hold undefined, and "nothing was there" must survive a round trip. */
function journalable(value: unknown): Json {
  return value === undefined ? null : (value as Json)
}

function sameValue(left: unknown, right: unknown): boolean {
  return fingerprintOf(journalable(left)) === fingerprintOf(journalable(right))
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * What the settings page should say the operator can do about a state that
 * nobody will fix by waiting.
 */
function hintFor(state: PatchState, detail: string): Json | undefined {
  switch (state) {
    case 'drifted':
      return 'The target no longer matches this patch. The next reconcile rewrites it.'
    case 'unsupported':
      return detail
    case 'absent':
      return 'The named target is not present. Install or enable it, or delete this patch.'
    default:
      return undefined
  }
}

async function reconcilePatch(patch: Patch, ctx: PatchContext): Promise<PatcherStatus> {
  const { adapters, journal, now, spec } = ctx
  const base = {
    patchId: patch.id,
    kind: patch.target.kind,
    targetLabel: describeTarget(patch.target),
    reason: patch.reason,
    enabled: patch.enabled,
    updatedAt: now(),
  }
  const done = (state: PatchState, detail: string, hint?: Json): PatcherStatus => {
    const hintValue = hint ?? hintFor(state, detail)
    return hintValue === undefined ? { ...base, state, detail } : { ...base, state, detail, hint: hintValue }
  }

  // 1. The spec itself refused this patch. Siblings still reconcile.
  if (spec.rejected.has(patch.id)) {
    const first = spec.diagnostics.find((d) => d.patchId === patch.id)
    return done('failed', first ? `${first.path}: ${first.message}` : 'the spec rejected this patch')
  }

  // 2. Two patches wanting the same patch row is a conflict, not a race the
  //    later patch gets to win: a row is one line of one file.
  if (patch.target.kind === 'patch-row' && spec.contestedRows.has(patch.target.rowId)) {
    const claim = spec.diagnostics.find((d) => d.patchId === patch.id && d.path === 'target.rowId')
    return done('conflict', claim?.message ?? `patch row "${patch.target.rowId}" is claimed by more than one patch`)
  }

  // 3. A build without this adapter must say so rather than report success.
  const binding = adapters[patch.target.kind]
  if (!binding) {
    return done('unsupported', `this build registers no adapter for "${patch.target.kind}" targets`)
  }

  // 4. Observe. read() is synchronous by contract and must never write.
  let snapshot: TargetSnapshot
  try {
    snapshot = binding.adapter.read(binding.port as never, patch)
  } catch (error) {
    return done('failed', reason(error))
  }

  // 5. verify-only stops here, whatever it saw. It is an assertion, not an edit,
  //    so it must not journal anything either.
  if (patch.op.kind === 'verify-only') {
    return done(snapshot.state, `${snapshot.detail} (verify-only: nothing was written)`)
  }

  if (patch.enabled) {
    if (snapshot.state === 'in-sync') return done('in-sync', snapshot.detail)
    if (snapshot.state !== 'drifted') return done(snapshot.state, snapshot.detail)

    // Never write something the journal cannot later undo. If the before-entry
    // does not land, stop — a write we could not roll back is worse than drift.
    try {
      await journal.append({
        patchId: patch.id,
        phase: 'before',
        value: journalable(snapshot.value),
        reason: patch.reason,
      })
    } catch (error) {
      return done('failed', `refusing to write: the journal could not record the previous value (${reason(error)})`)
    }

    let applied: ApplyResult
    try {
      applied = await binding.adapter.apply(binding.port as never, patch, snapshot)
    } catch (error) {
      return done('failed', reason(error))
    }
    if (applied.state !== 'in-sync') {
      return done(applied.state, applied.detail)
    }

    // Re-read rather than trusting the adapter's own report: the journal's
    // "after" value is what a future rollback compares against, so it has to be
    // the world as it actually is.
    let observed: unknown
    try {
      observed = binding.adapter.read(binding.port as never, patch).value
    } catch (error) {
      // The write landed and the journal now holds a before with no after.
      // Writing the adapter's own "before" into the after slot would make the
      // write-ahead record claim a value the target does not hold, so leave the
      // pair open instead. A later rollback refuses an open pair, which is the
      // direction that keeps somebody's edit rather than the one that destroys
      // it on a guess.
      return done(
        'conflict',
        `the write succeeded but the value it produced could not be read back (${reason(error)}); `
          + 'the journal pair was left open on purpose, so a later rollback will refuse to run automatically',
      )
    }
    try {
      await journal.append({
        patchId: patch.id,
        phase: 'after',
        value: journalable(observed),
        reason: patch.reason,
      })
    } catch (error) {
      return done(
        'conflict',
        `applied, but the journal could not be closed (${reason(error)}); `
          + 'a rollback now has an incomplete pair and will refuse to run automatically',
      )
    }
    return done('in-sync', applied.detail)
  }

  // 6. Disabled: this is the rollback path.
  // A journal that cannot be read is a journal this engine knows nothing
  // about. Reading it as "never wrote" would report a patch clean while
  // whatever it wrote is still in place, so the read failure is the answer.
  let pair: JournalPair | undefined
  try {
    pair = await journal.latest(patch.id)
  } catch (error) {
    return done(
      'failed',
      `the journal could not be read (${reason(error)}), so there is no way to tell whether this patch wrote anything`,
    )
  }
  if (pair === void 0) {
    return done('in-sync', 'disabled; this patch never wrote anything, so there is nothing to roll back')
  }
  if (pair.before === undefined || pair.after === undefined) {
    // Either direction of a half-written pair means the journal cannot say what
    // this patch did. Reporting "nothing to roll back" would be a guess, and
    // guessing here leaves somebody else's edit in place while the page claims
    // the patch is disabled. Say so instead.
    return done(
      'conflict',
      'the journal holds an incomplete pair for this patch, so what it wrote is unknown; '
        + 'nothing was rolled back automatically',
    )
  }

  let current: TargetSnapshot
  try {
    current = binding.adapter.read(binding.port as never, patch)
  } catch (error) {
    return done('failed', reason(error))
  }
  if (sameValue(current.value, pair.before)) {
    // Already restored — most likely by an earlier rollback that ran again on a
    // later spec reload. Re-closing the pair here is what stops that from
    // becoming a loop that keeps unsetting a value the operator has since set.
    try {
      await journal.append({ patchId: patch.id, phase: 'before', value: journalable(current.value), reason: patch.reason })
      await journal.append({ patchId: patch.id, phase: 'after', value: journalable(current.value), reason: patch.reason })
    } catch {
      // A journal that will not close is worth reporting, but the world is
      // already in the state the operator asked for.
    }
    return done('in-sync', 'disabled; the target is already at its pre-patch value')
  }

  let rolled: ApplyResult
  try {
    rolled = await binding.adapter.rollback(binding.port as never, patch, pair.before)
  } catch (error) {
    return done('failed', reason(error))
  }
  return done(rolled.state, rolled.detail)
}

/**
 * Recompute every patch and return the new status set.
 *
 * Returns an empty list when the spec failed the schema layer: there is
 * nothing meaningful to report per-patch, and inventing statuses would make a
 * broken spec look like a healthy one. The caller is expected to render
 * `spec.diagnostics` instead.
 */
export async function reconcile(options: ReconcileOptions): Promise<PatcherStatus[]> {
  const { spec, adapters, journal, now = () => new Date().toISOString(), onStatus } = options
  if (!spec.config) return []

  const ctx: PatchContext = { spec, adapters, journal, now }
  const statuses: PatcherStatus[] = []
  for (const patch of spec.config.patches) {
    // Sequential on purpose: see the note at the top of this file.
    // eslint-disable-next-line no-await-in-loop
    const status = await reconcilePatch(patch, ctx)
    statuses.push(status)
    onStatus?.(status)
  }
  return statuses
}
