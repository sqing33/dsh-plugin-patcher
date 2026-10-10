/**
 * The client's half of the patcher, with no React and no I/O.
 *
 * Everything the settings page does to a spec is one of three things: group the
 * patches by what they aim at, read one patch's status, or build the next
 * config to write. All three are pure functions over the state the host
 * published, so the page's rendering can be reasoned about from this file
 * alone and checked without a DOM, a fetch stub, or a test runner that knows
 * about components.
 *
 * The host is the only writer. These functions build the *next* value and hand
 * it back; nothing here touches the settings namespace, so a page that renders
 * from a stale state still shows a coherent view of what it was given.
 */

import type { PatcherStatus, PatchState } from '../adapters/types.ts'
import type { PatcherInventory, PatcherState } from '../host/state.ts'
// The one value import. The id pattern is the contract with the host's schema
// (spec/schema.ts rejects any id it does not match), and a second copy of the
// regex here would be free to drift from it. spec/types.ts imports nothing, so
// this stays a leaf dependency for a client bundle.
import { PATCH_ID_PATTERN, type Op, type Patch, type PatcherConfig, type Target } from '../spec/types.ts'

/**
 * The spec the host last resolved, or an empty one.
 *
 * A host that has not answered yet — the first render happens before the first
 * poll returns — still has to render a page, so the fallback is a real empty
 * config rather than undefined. It is built per call: one shared empty object
 * handed to two components is one component's array splice away from corrupting
 * the other's.
 *
 * The state argument is optional on purpose, and that is a bug this signature
 * was rewritten to prevent: a component computes the patch list above the
 * branch that waits for the host, so it calls this with nothing and the page
 * dies in the first frame. A missing state and a state with no spec are the
 * same thing to every caller here — there is nothing to show — so they take
 * the same answer.
 */
export function specOf(state: PatcherState | undefined): PatcherConfig {
  return state?.spec ?? { patches: [], reconcileNonce: 0, initialized: false }
}

/**
 * The patch list, defensively.
 *
 * A spec can reach the page through a namespace the operator hand-edited, and a
 * page that renders `undefined.length` is a crash with nothing the operator
 * can act on. An absent list is an empty spec.
 */
export function patchesOf(config: PatcherConfig): Patch[] {
  const patches: unknown = config.patches
  return Array.isArray(patches) ? (patches as Patch[]) : []
}

/** The host's conclusion about one patch, when it has published one. */
export function statusOf(statuses: readonly PatcherStatus[], patchId: string): PatcherStatus | undefined {
  return statuses.find((status) => status.patchId === patchId)
}

/**
 * The key that groups patches aiming at the same thing.
 *
 * A package-file key stops at the package, not at the file: one installed
 * bundle is one thing to reason about, and a spec rewriting two files inside it
 * is still one operator decision. A row's optional `name:` guard is not part
 * of the key either — the guard narrows which row may be edited, it does not
 * create a second row.
 */
export function targetKey(target: Target): string {
  switch (target.kind) {
    case 'settings':
      return 'settings:' + target.namespace
    case 'patch-row':
      return 'patch-row:' + target.rowId
    case 'package-file':
      return 'package-file:' + target.pkg
  }
}

/**
 * One short line naming a target, for a card heading.
 *
 * Shorter than the host's own targetLabel on purpose: the heading sits above
 * the patches and the detail, not beside them.
 */
export function describeTargetBrief(target: Target): string {
  switch (target.kind) {
    case 'settings':
      return target.namespace
    case 'patch-row':
      return target.rowId
    case 'package-file':
      return target.version ? `${target.pkg}@${target.version}` : target.pkg
  }
}

/** One target, the patches claiming it, and what the inventory can say. */
export interface TargetGroup {
  key: string
  /** The target of this group's first patch; identical across the group. */
  target: Target
  /** Card heading, from describeTargetBrief. */
  label: string
  /** The npm package behind the target, when the inventory knows one. */
  pkg: string | undefined
  /** Present for a patch-row target the profile patch file lists. */
  rowEnabled: boolean | undefined
  /** The installed version, for a bundle the inventory lists. */
  version: string | undefined
  /** The patches claiming this target, in spec order. */
  patches: Array<{ patch: Patch; status: PatcherStatus | undefined }>
  /** True when the inventory does not list this target at all. */
  unknown: boolean
}

/**
 * Ask the inventory about a group's target, and record what it said.
 *
 * Returns false when the inventory does not list the target. That answer is the
 * whole difference between a card the operator can act on and one that exists
 * only so a dangling spec entry can be found and deleted.
 *
 * pkg is what the inventory vouches for, never what the spec claims: for a row
 * that means the row's own name, and for a bundle the package the inventory
 * still has. An unknown group is precisely the case where the spec's name may
 * no longer refer to anything, so it reports no package at all.
 */
function readInventory(group: TargetGroup, inventory: PatcherInventory): boolean {
  const target = group.target
  if (target.kind === 'settings') {
    return inventory.settings.includes(target.namespace)
  }
  if (target.kind === 'patch-row') {
    const row = inventory.rows.find((entry) => entry.rowId === target.rowId)
    if (row === undefined) return false
    group.rowEnabled = row.enabled
    if (row.name !== undefined && row.name !== '') group.pkg = row.name
    return true
  }
  const bundle = inventory.bundles.find((entry) => entry.pkg === target.pkg)
  if (bundle === undefined) return false
  group.pkg = target.pkg
  group.version = bundle.version
  return true
}

/**
 * Group the spec by target, splitting what can be acted on from what cannot.
 *
 * A group is bound when the inventory lists its target, and unknown when it
 * does not; an unknown group keeps its patches and their statuses so the
 * operator can see a spec entry pointing at something that is gone and delete
 * it, instead of a card silently missing. Only targets some patch claims become
 * groups: an addressable target nobody aims at is not this page's business.
 *
 * Both lists are ordered by label so the operator finds a target the same way
 * every refresh. The comparison is by code unit rather than by locale, because a
 * card order that moves with the browser's locale is an order nobody can
 * describe or reproduce.
 */
export function groupTargets(state: PatcherState): { bound: TargetGroup[]; unknown: TargetGroup[] } {
  const byKey = new Map<string, TargetGroup>()
  for (const patch of patchesOf(specOf(state))) {
    const key = targetKey(patch.target)
    const group = byKey.get(key)
    if (group === undefined) {
      byKey.set(key, {
        key,
        target: patch.target,
        label: describeTargetBrief(patch.target),
        pkg: undefined,
        rowEnabled: undefined,
        version: undefined,
        patches: [{ patch, status: statusOf(state.statuses, patch.id) }],
        unknown: false,
      })
      continue
    }
    // The journal is keyed by patch id, so a spec carrying the same id twice
    // describes one patch. Listing it twice would give the operator two rows
    // that look alike and that delete to the same thing.
    if (group.patches.some((entry) => entry.patch.id === patch.id)) continue
    group.patches.push({ patch, status: statusOf(state.statuses, patch.id) })
  }

  const bound: TargetGroup[] = []
  const unknown: TargetGroup[] = []
  for (const group of byKey.values()) {
    if (readInventory(group, state.inventory)) bound.push(group)
    else unknown.push({ ...group, unknown: true })
  }

  const byLabel = (a: TargetGroup, b: TargetGroup): number => {
    if (a.label !== b.label) return a.label < b.label ? -1 : 1
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
  }
  bound.sort(byLabel)
  unknown.sort(byLabel)
  return { bound, unknown }
}

/** How a state is coloured on the page. */
export type Tone = 'ok' | 'warn' | 'bad'

/**
 * Map a state onto a tone.
 *
 * drifted is a warning, unsupported is not. Drifted means somebody changed the
 * target and the patcher can put it back, so the operator has something to wait
 * for. Unsupported means the spec asks for something this build cannot do, so
 * re-running changes nothing and colouring it as a warning would imply a retry
 * that helps. Everything that cannot be resolved on its own — conflict,
 * unsupported, absent, failed — is red, and only a state the host has not
 * computed yet is amber.
 */
export function toneOf(state: PatchState): Tone {
  if (state === 'in-sync') return 'ok'
  if (state === 'drifted' || state === 'pending') return 'warn'
  return 'bad'
}

/**
 * Insert a patch, or replace the one already holding its id.
 *
 * Replacement keeps the patch's position in the array, because a page that
 * reorders a spec under the operator's cursor turns every edit into a hunt.
 * Nothing is mutated: the config the page rendered from has to keep describing
 * what was on screen even if the write is still in flight.
 */
export function withPatch(config: PatcherConfig, patch: Patch): PatcherConfig {
  const patches = patchesOf(config)
  const index = patches.findIndex((entry) => entry.id === patch.id)
  const next = patches.slice()
  if (index === -1) next.push(patch)
  else next[index] = patch
  return { ...config, patches: next }
}

/** Drop a patch by id; an id that is not there leaves the list as it was. */
export function withoutPatch(config: PatcherConfig, patchId: string): PatcherConfig {
  return { ...config, patches: patchesOf(config).filter((patch) => patch.id !== patchId) }
}

/**
 * Flip one patch's enabled flag.
 *
 * Only the patch being changed is copied, so an unchanged patch keeps its
 * identity across the write and a component holding it does not re-render.
 */
export function withEnabled(config: PatcherConfig, patchId: string, enabled: boolean): PatcherConfig {
  return {
    ...config,
    patches: patchesOf(config).map((patch) => (patch.id === patchId ? { ...patch, enabled } : patch)),
  }
}

/**
 * Ask the host to re-apply everything.
 *
 * The host watches the spec and does nothing but recompute from scratch, so
 * the nonce is the whole control channel: a value that does not change is a
 * write the host never sees. That also means a nonce which is not a number
 * would turn every page edit into a silent no-op — NaN + 1 is still NaN — so a
 * malformed one restarts the count rather than propagating.
 */
export function bumpedNonce(config: PatcherConfig): PatcherConfig {
  const raw: unknown = config.reconcileNonce
  const current = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0
  return { ...config, reconcileNonce: current + 1 }
}

/**
 * The two ops that write a spec.
 *
 * The spec namespace is volatile as a whole (see the note in spec/schema.ts),
 * so writing the array in one op *is* the document write: a diff would leave
 * the host folding a partial object into a spec it is reconciling at the same
 * time. The nonce comes second and always, because the host only re-applies
 * when the value it watches changes.
 *
 * The flag is set here, and always to true, because reaching this function at
 * all is the decision: something on the page wrote the spec on purpose. Left
 * out, the host would keep reading an uninitialised namespace and seed its
 * four defaults into a list the operator had just emptied.
 */
export function writeOps(next: PatcherConfig): Array<{ op: 'set'; path: string[]; value: unknown }> {
  return [
    { op: 'set', path: ['patches'], value: patchesOf(next) },
    { op: 'set', path: ['reconcileNonce'], value: next.reconcileNonce },
    { op: 'set', path: ['initialized'], value: true },
  ]
}

/**
 * The built-in defaults this spec does not carry yet.
 *
 * The page offers these but never writes them on its own: seeding is the
 * host's job and happens once, and an operator who has cleared the list on
 * purpose must not find it back after pressing an unrelated button. Asking
 * first is the whole difference between a default and an ambush.
 *
 * Matching is by id, because that is how the spec identifies a patch
 * everywhere else — and a default that quietly replaced a patch the
 * operator had edited under the same id would lose their edit.
 */
export function missingDefaults(defaults: readonly Patch[], existing: readonly Patch[]): Patch[] {
  const present = new Set(existing.map((patch) => patch.id))
  return defaults.filter((patch) => !present.has(patch.id))
}

/**
 * The first free id of a fixed series.
 *
 * Short, readable and stable across edits, which matters more here than
 * uniqueness by some opaque scheme: the id is what the journal is keyed by, so
 * an id that changes when a patch is re-saved loses that patch's rollback
 * history. Every id produced here matches PATCH_ID_PATTERN, so it survives the
 * host's schema on the way back in.
 */
export function newPatchId(existing: readonly Patch[]): string {
  const taken = new Set(existing.map((patch) => patch.id))
  for (let index = 1; ; index += 1) {
    const id = `patch-${index}`
    if (!taken.has(id)) return id
  }
}

/** A patch being composed, before it is written into the spec. */
export interface DraftPatch {
  id: string
  enabled: boolean
  reason: string
  target: Target
  op: Op
}

/**
 * Which operations each target can carry.
 *
 * This mirrors the table loadSpec enforces in src/spec/resolve.ts. The host's
 * copy is module-private, and reaching for it would drag the schema layer into
 * the page bundle, so the duplication is deliberate and bounded: three lines,
 * held to the host's table by a test that asks loadSpec about every pairing.
 */
const TARGET_OPS: Record<Target['kind'], readonly Op['kind'][]> = {
  settings: ['set', 'unset', 'verify-only'],
  'patch-row': ['merge-config', 'set-enabled', 'verify-only'],
  'package-file': ['code'],
}

/** The target kinds, in the order the form offers them. */
export const TARGET_KINDS: readonly Target['kind'][] = ['settings', 'patch-row', 'package-file']

/**
 * The legal ops for a target kind, as a fresh list.
 *
 * The page renders its op choices straight from this, so the returned array is
 * a copy: a component that reorders or truncates the choices for display would
 * otherwise corrupt the table for the next render. A kind the page read out of
 * a hand-edited spec has no pairing, and offers no op rather than throwing
 * while the operator is typing.
 */
export function opKindsFor(kind: Target['kind']): Op['kind'][] {
  const allowed = TARGET_OPS[kind]
  return allowed === undefined ? [] : [...allowed]
}

/**
 * One reason a draft cannot be saved, or undefined when it can.
 *
 * The checks run in the order a person fills the form in, so the message shown
 * is the first one they can act on rather than whichever one happened to be
 * cheapest. Each message names the field it is about.
 *
 * `exceptId` is the patch being edited. Without it, saving an edit unchanged
 * would be impossible: the id is in the spec precisely *because* this is its
 * edit, and the check cannot tell that from a genuine collision. Only the caller
 * knows which of the two it is in, so the caller has to say.
 */
export function validateDraft(
  draft: DraftPatch,
  state: PatcherState,
  exceptId?: string,
): string | undefined {
  const id: unknown = draft.id
  if (typeof id !== 'string' || !PATCH_ID_PATTERN.test(id)) {
    return 'id must match /^[a-z0-9][a-z0-9-]*$/ (lowercase letters, digits, dashes)'
  }
  if (patchesOf(specOf(state)).some((patch) => patch.id === id && patch.id !== exceptId)) {
    return 'id is already used by another patch in the spec'
  }
  const reason: unknown = draft.reason
  if (typeof reason !== 'string' || reason.trim() === '') {
    return 'reason is required: it is shown verbatim in the report'
  }
  const allowed = opKindsFor(draft.target.kind)
  if (!allowed.includes(draft.op.kind)) {
    const expected = allowed.map((kind) => `"${kind}"`).join(', ')
    return `op.kind "${draft.op.kind}" cannot address a "${draft.target.kind}" target; expected ${expected || 'no operation'}`
  }

  switch (draft.op.kind) {
    case 'set':
    case 'unset':
      if (draft.op.path.length === 0) return 'op.path must have at least one segment'
      break
    case 'merge-config':
      if (Object.keys(draft.op.config).length === 0) {
        return 'op.config is empty: a merge with nothing would rewrite the row for no reason'
      }
      break
    case 'code': {
      // A code patch says what to do in two lists: edits to the target file,
      // and files to add beside it. Adding a file is how injected code stays a
      // file an editor can open and a linter can read, so a patch carrying only
      // `files` is the interesting case, not a half-typed one. The rule here
      // is the host's rule in src/spec/resolve.ts — both lists empty is the
      // only thing that does nothing — and reading `files` defensively is what
      // lets a draft from a hand-edited spec, or from before this field
      // existed, reach the same conclusion the host would.
      const edits = Array.isArray(draft.op.edits) ? draft.op.edits : []
      const files = Array.isArray(draft.op.files) ? draft.op.files : []
      if (edits.length === 0 && files.length === 0) {
        return 'op.edits and op.files are both empty: a code patch would change nothing'
      }
      const seen = new Set<string>()
      for (const file of files) {
        if (typeof file?.path !== 'string' || file.path === '') {
          return 'op.files[].path is required: it is the file to create inside the target package'
        }
        if (typeof file.source !== 'string' || file.source === '') {
          return `op.files entry "${file.path}" has no source: the content of injected code lives in a file under patches/, not in the spec`
        }
        if (seen.has(file.path)) {
          return `op.files lists "${file.path}" twice: only one of them could win, and which one would be the order of the array`
        }
        seen.add(file.path)
        if (file.path === (draft.target.kind === 'package-file' ? draft.target.path : '')) {
          return `op.files would overwrite the target file itself ("${file.path}"); an edit and a file competing for one path has no defined winner`
        }
      }
      break
    }
    case 'set-enabled':
    case 'verify-only':
      break
  }

  if (draft.target.kind === 'package-file' && !draft.target.version) {
    // A pnpm patch that no longer matches the installed version fails hard and
    // writes not a single byte, which from the operator's side is
    // indistinguishable from the patcher having done nothing.
    return 'target.version must pin the exact installed version'
  }
  return undefined
}
