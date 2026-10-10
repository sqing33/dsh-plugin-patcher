/**
 * L1 "settings" adapter: rewrite one namespace of another plugin's settings.
 *
 * DSH 0.1.7's `SettingsForms` has no reader at all, so a namespace is located
 * by scanning `describe()` for the entry whose `ns` matches and the
 * descriptor's `value` is the projected before-state that both the journal and
 * the fingerprint need. Four host behaviours shape everything below:
 *
 *   1. `describe()` hides a namespace whose Config declares no `.volatile()`
 *      field, so a missing entry is ambiguous: "not loaded yet" or "not
 *      patchable". It is reported as `absent`, never guessed at.
 *   2. `mutate()` rejects a non-volatile path with a plain `Error`. That is
 *      permanent — the target is not ours to write — so it is `unsupported`,
 *      not `failed`, and nothing is retried.
 *   3. `mutate()` throws `SettingsConflictError` on a stale
 *      expectedRevision. Someone else won the race, so retrying would
 *      clobber their edit: `conflict`, no retry.
 *   4. `describe()` emits `settings/document-updated` whenever a stored value
 *      changes, so a write re-enters any listener. No revision is therefore
 *      ever held across a write; apply() and rollback() each take their own
 *      fresh describe().
 */

import type { SettingsDescriptor, SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { fingerprintOf, selectAt } from '../engine/fingerprint.ts'
import { expandValue, isGeneratorRequest, type GeneratorRegistry } from '../spec/resolve.ts'
import type { Adapter, ApplyResult, TargetSnapshot } from './types.ts'
import type { Op, Patch, SettingsTarget, Value } from '../spec/types.ts'

/**
 * The slice of `ctx.settings` this adapter needs.
 *
 * Deliberately structural and narrow: the tests drive it with a hand-rolled
 * fake, and the engine hands over `ctx.settings` unchanged because
 * `SettingsForms` already satisfies this shape.
 */
export interface SettingsPort {
  describe(): SettingsDescriptor[]
  mutate(ns: string, ops: readonly SettingsPathOp[], revision?: number): Promise<void>
  /**
   * Generators a `$gen` value may be materialised with. Optional, so a host
   * that has not wired the patcher in, and the fakes in the tests, both
   * satisfy the port unchanged.
   */
  generators?: GeneratorRegistry
}

type SettingsPatch = Patch & { target: SettingsTarget }
/** The op kinds that address a settings namespace; the rest belong elsewhere. */
type WritableOp = Extract<Op, { kind: 'set' | 'unset' }>

/** `SettingsConflictError.code`. The only stable part of that error across copies. */
const SETTINGS_CONFLICT = 'SETTINGS_CONFLICT'
/** `Plugin entry "X" has no volatile fields` */
const NO_VOLATILE_FIELDS = 'has no volatile fields'
/** `Config field "a.b" is not volatile` */
const FIELD_NOT_VOLATILE = 'is not volatile'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isWritableOp(op: Op): op is WritableOp {
  return op.kind === 'set' || op.kind === 'unset'
}

/**
 * "Is this the value the patch wanted?", judged by the engine's own notion of
 * value equality.
 *
 * `describe()` rebuilds its projection on every call, so identity never
 * matches, and it hands back live host objects as often as plain JSON: a Date
 * or a Map in a projection must not read as permanently drifted just because a
 * value comparison walks references. fingerprintOf() already sorts keys, keeps
 * array order, separates "absent" from "null" and normalises those objects, so
 * the adapter's in-sync decision cannot drift away from the engine's.
 */
function sameValue(left: unknown, right: unknown): boolean {
  return fingerprintOf(left) === fingerprintOf(right)
}

/** One-line rendering of a value for a status detail, capped so a UI row survives. */
function brief(value: unknown): string {
  if (value === void 0) return 'nothing'
  const text = (() => {
    try {
      return JSON.stringify(value) ?? String(value)
    } catch {
      return String(value)
    }
  })()
  return text.length > 80 ? text.slice(0, 77) + '...' : text
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (isRecord(error) && typeof error['message'] === 'string') return error['message'] as string
  return String(error)
}

/**
 * Map a `mutate()` failure onto a patch state.
 *
 * The conflict check is duck-typed on `code` rather than `instanceof`: the
 * host ships its own copy of @deepseek-ai/dsh-settings, so its
 * `SettingsConflictError` is a *different class object* from any this plugin
 * could import, and `instanceof` would always be false. `code` is a readonly
 * discriminant on the error, the string is host-reserved, and the guard accepts
 * any object shape — no throw, no import, no dual-package hazard.
 */
function stateOfError(error: unknown, namespace: string): ApplyResult {
  const message = messageOf(error)
  if (isRecord(error) && error['code'] === SETTINGS_CONFLICT) {
    const expected = error['expected']
    const actual = error['actual']
    const revisions =
      typeof expected === 'number' && typeof actual === 'number'
        ? ` (expected revision ${expected}, now ${actual})`
        : ''
    return {
      state: 'conflict',
      detail: `"${namespace}" changed underneath this patch${revisions}; ${message}`,
    }
  }
  if (message.includes(NO_VOLATILE_FIELDS) || message.includes(FIELD_NOT_VOLATILE)) {
    return { state: 'unsupported', detail: `"${namespace}" is not patchable: ${message}` }
  }
  return { state: 'failed', detail: message }
}

/**
 * The exact ops one op kind becomes.
 *
 * A single op maps to a single host op: a `set` writes the materialised value
 * at the path and an `unset` removes it. Nothing is batched, because a batch
 * whose second op is rejected would leave the first half applied.
 *
 * The path is copied: the host keeps the array it is handed, and a caller that
 * later mutates the spec must not be able to reach back into a written op.
 */
function opsFor(op: WritableOp): SettingsPathOp[] {
  if (op.kind === 'set') return [{ op: 'set', path: [...op.path], value: op.value }]
  return [{ op: 'unset', path: [...op.path] }]
}

function pathLabel(path: readonly string[]): string {
  return path.length === 0 ? 'the namespace root' : path.join('.')
}

/**
 * Materialise a `set` op's value, with the live value at its path in hand.
 *
 * Everything else passes through untouched, so the common case costs one
 * plain-object test. The returned op is a copy: the host keeps the op it is
 * handed, and the spec's own object must not be reachable from a written op.
 */
function resolveOp(
  op: WritableOp,
  whole: unknown,
  port: SettingsPort,
): { op: WritableOp; error?: string } {
  if (op.kind !== 'set' || !isGeneratorRequest(op.value)) return { op }
  const step = expandValue(
    op.value,
    port.generators ?? new Map(),
    'the value for ' + pathLabel(op.path),
    { current: selectAt(whole, op.path) },
  )
  if (step.error !== void 0) return { op, error: step.error }
  return { op: { kind: 'set', path: [...op.path], value: step.value as Value } }
}

function rejectedOpKind(kind: string): ApplyResult {
  return {
    state: 'failed',
    detail:
      `op kind "${kind}" does not address a settings namespace; only set, unset and `
      + 'verify-only do (merge-config, set-enabled and code belong to the patch-row, '
      + 'plugin-manager and package-file adapters)',
  }
}

/**
 * Find the live descriptor for one namespace.
 *
 * Exported because "is this namespace even addressable?" is the first question
 * every settings action asks, and the engine needs the same answer for its own
 * pre-flight. Returns undefined for a namespace that is absent *or* hidden by
 * describe(); the caller decides which.
 */
export function settingsDescriptorOf(
  port: SettingsPort,
  namespace: string,
): SettingsDescriptor | undefined {
  return port.describe().find((descriptor) => descriptor.ns === namespace)
}

/**
 * Observe a namespace. Never writes, never throws.
 *
 * The whole body sits inside the try because describe() and the projection it
 * returns are both outside this plugin's control, and a read that threw would
 * take the entire reconcile down with it instead of failing one patch.
 */
function readSettings(port: SettingsPort, patch: SettingsPatch): TargetSnapshot {
  const namespace = patch.target.namespace
  try {
    const descriptor = settingsDescriptorOf(port, namespace)
    if (descriptor === void 0) {
      return {
        state: 'absent',
        value: void 0,
        detail:
          `no settings namespace "${namespace}" is registered; describe() also hides a namespace `
          + 'whose Config declares no volatile field, so it may not be patchable at all',
      }
    }
    // The whole projection, not just the patched path: the journal stores it as
    // the rollback source and the engine fingerprints it for drift.
    const value = descriptor.value
    const op = patch.op
    if (op.kind === 'verify-only') {
      return { state: 'in-sync', value, detail: `verified "${namespace}", nothing written` }
    }
    if (!isWritableOp(op)) return { ...rejectedOpKind(op.kind), value }
    const label = pathLabel(op.path)
    if (op.kind === 'set') {
      const resolved = resolveOp(op, value, port)
      if (resolved.error !== void 0) return { state: 'failed', value, detail: resolved.error }
      const current = selectAt(value, op.path)
      return sameValue(current, resolved.op.value)
        ? { state: 'in-sync', value, detail: `${label} in "${namespace}" already matches` }
        : {
          state: 'drifted',
          value,
          detail: `"${namespace}" holds ${brief(current)} at ${label}, the patch wants ${brief(resolved.op.value)}`,
        }
    }
    const current = selectAt(value, op.path)
    return current === void 0
      ? { state: 'in-sync', value, detail: `${label} is already unset in "${namespace}"` }
      : {
        state: 'drifted',
        value,
        detail: `${label} is set to ${brief(current)} in "${namespace}"; the patch would remove it`,
      }
  } catch (error) {
    return { state: 'failed', value: void 0, detail: messageOf(error) }
  }
}

/**
 * Write one namespace.
 *
 * The expectedRevision comes from a describe() taken *here*, not from read():
 * describe() re-enters us on its own writes, so a revision observed before a
 * previous patch's write is stale by construction, and a stale revision is
 * reported as a conflict instead of silently overwriting.
 */
async function applySettings(
  port: SettingsPort,
  patch: SettingsPatch,
  expected: TargetSnapshot,
): Promise<ApplyResult> {
  const namespace = patch.target.namespace
  const op = patch.op
  if (op.kind === 'verify-only') return { state: 'in-sync', detail: 'verified, nothing written' }
  if (!isWritableOp(op)) return rejectedOpKind(op.kind)

  let descriptor: SettingsDescriptor | undefined
  try {
    descriptor = settingsDescriptorOf(port, namespace)
  } catch (error) {
    return { state: 'failed', detail: messageOf(error), before: expected.value }
  }
  if (descriptor === void 0) {
    return {
      state: 'absent',
      detail: `no settings namespace "${namespace}" is registered`,
      before: expected.value,
    }
  }
  try {
    // Resolved again here, against the describe() taken just now, so a
    // generator reads what is actually stored at write time rather than the
    // projection read() compared against.
    const resolved = resolveOp(op, descriptor.value, port)
    if (resolved.error !== void 0) {
      return { state: 'failed', detail: `refusing to write: ${resolved.error}`, before: expected.value }
    }
    await port.mutate(namespace, opsFor(resolved.op), descriptor.revision)
  } catch (error) {
    return { ...stateOfError(error, namespace), before: expected.value }
  }
  return {
    state: 'in-sync',
    detail:
      op.kind === 'set'
        ? `wrote ${pathLabel(op.path)} in "${namespace}"`
        : `removed ${pathLabel(op.path)} from "${namespace}"`,
    before: expected.value,
  }
}

/**
 * Undo one applied patch from its journaled before-value.
 *
 * A `set` is undone by unsetting its path; an `unset` is undone by setting
 * the path back to what the journal recorded. The journal holds the whole
 * projection, so the restored value is selected back out of it at the path —
 * which also means an `unset` that was a no-op has nothing to restore and is
 * reported without a pointless write.
 */
async function rollbackSettings(
  port: SettingsPort,
  patch: SettingsPatch,
  before: unknown,
): Promise<ApplyResult> {
  const namespace = patch.target.namespace
  const op = patch.op
  if (!isWritableOp(op)) {
    return {
      state: 'failed',
      detail: `only set and unset patches have a settings rollback; "${op.kind}" does not`,
    }
  }
  let descriptor: SettingsDescriptor | undefined
  try {
    descriptor = settingsDescriptorOf(port, namespace)
  } catch (error) {
    return { state: 'failed', detail: messageOf(error) }
  }
  if (descriptor === void 0) {
    return {
      state: 'absent',
      detail: `no settings namespace "${namespace}" is registered, so nothing was rolled back`,
    }
  }
  const restored = op.kind === 'unset' ? selectAt(before, op.path) : void 0
  if (op.kind === 'unset' && restored === void 0) {
    return {
      state: 'in-sync',
      detail: `${pathLabel(op.path)} was already unset in "${namespace}" when this patch was journaled`,
      before: descriptor.value,
    }
  }
  const undo: WritableOp =
    op.kind === 'set'
      ? { kind: 'unset', path: op.path }
      : { kind: 'set', path: op.path, value: restored as Value }
  try {
    await port.mutate(namespace, opsFor(undo), descriptor.revision)
  } catch (error) {
    return { ...stateOfError(error, namespace), before: descriptor.value }
  }
  return {
    state: 'in-sync',
    detail:
      op.kind === 'set'
        ? `rolled back ${pathLabel(op.path)} in "${namespace}" by unsetting it`
        : `rolled back ${pathLabel(op.path)} in "${namespace}" by restoring the journaled value`,
    before: descriptor.value,
  }
}

export const settingsAdapter: Adapter<SettingsPort, SettingsTarget> = {
  kind: 'settings',
  read: readSettings,
  apply: applySettings,
  rollback: rollbackSettings,
}
