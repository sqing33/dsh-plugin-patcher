import type { Json, Patch, Target } from '../spec/types.ts'

/**
 * Where one patch currently stands.
 *
 * `pending` is the only transient state and never survives a reconcile: a
 * reconcile is a full recomputation, so a patch is always in a terminal state
 * by the time it is published.
 */
export type PatchState =
  /** Target is present and already matches what the patch would write. */
  | 'in-sync'
  /** Target is present but does not match; the patch will be reapplied. */
  | 'drifted'
  /** Someone else changed the same thing; the patch refuses to overwrite. */
  | 'conflict'
  /** The target cannot be patched at all, e.g. a version mismatch. */
  | 'unsupported'
  /** The named target does not exist (row removed, package uninstalled). */
  | 'absent'
  /** The patch threw; `detail` carries the message and nothing is retried. */
  | 'failed'
  /** Never computed. Only visible before the first reconcile completes. */
  | 'pending'

export const TERMINAL_STATES: readonly PatchState[] = [
  'in-sync',
  'drifted',
  'conflict',
  'unsupported',
  'absent',
  'failed',
]

/** What an adapter observed about a target before anything is written. */
export interface TargetSnapshot {
  state: Exclude<PatchState, 'pending'>
  /**
   * The current value at the target, shaped however the adapter needs it.
   * `undefined` means the target exists but holds nothing there yet.
   */
  value: unknown
  /**
   * Facts a human needs in order to act, in the adapter's own terms: the
   * namespace that was missing, the version that did not match, how many
   * occurrences of an edit's `find` were seen.
   */
  detail: string
}

/** What an adapter did, or refused to do. */
export interface ApplyResult {
  state: PatchState
  detail: string
  /**
   * The complete pre-write value. The journal stores this so a rollback has
   * something to restore even if the target has drifted since.
   */
  before?: unknown
}

/**
 * One target kind's read/apply/rollback triple.
 *
 * Adapters take a narrow structural port rather than the whole cordis
 * `Context`, so each one is testable with a two-field fake and the engine
 * never has to know how a target is reached.
 */
export interface Adapter<TPort, TTarget extends Target = Target> {
  readonly kind: TTarget['kind']
  /** Observe the target. Must not write. */
  read(port: TPort, patch: Patch & { target: TTarget }): TargetSnapshot
  /** Write the target. `expected` is what `read` returned, for drift checks. */
  apply(port: TPort, patch: Patch & { target: TTarget }, expected: TargetSnapshot): Promise<ApplyResult>
  /** Restore a journaled `before` value. Best effort; reports what it did. */
  rollback(port: TPort, patch: Patch & { target: TTarget }, before: unknown): Promise<ApplyResult>
}

/** A patch paired with the adapter that knows how to reach its target. */
export interface ResolvedPatch<TPort = unknown> {
  patch: Patch
  adapter: Adapter<TPort, Target>
}

/** The serialisable status the settings page and the HTTP route both read. */
export interface PatcherStatus {
  patchId: string
  state: PatchState
  /** Target kind, repeated here so a status row needs no spec lookup. */
  kind: Target['kind']
  /** Human label for the target, e.g. a namespace or an installed package. */
  targetLabel: string
  reason: string
  detail: string
  enabled: boolean
  /** ISO timestamp of the last time this patch changed state. */
  updatedAt: string
  /** Present when state is 'drifted', 'unsupported' or 'absent'. */
  hint?: Json
}
