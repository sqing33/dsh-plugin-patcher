/**
 * Reading and writing a whole spec as text.
 *
 * A spec is a document, and a document has to be able to leave the page:
 * pasted from a file, handed to the code-patch CLI, checked into the profile's
 * own repository. This is that boundary.
 *
 * JSON, not YAML. The page is the wrong place to carry a YAML parser — the
 * bundle would grow by more than everything else in it — and JSON is a subset
 * of YAML, so a spec saved from here is still readable by
 * `scripts/apply-code-patch.mjs` and by anything else that parses the format.
 * The file on disk can be YAML; the wire between the textarea and the spec is
 * JSON.
 */

import type { Patch, PatcherConfig } from '../spec/types.ts'
import { patchesOf, validateDraft, type DraftPatch } from './spec-io.ts'
import type { PatcherState } from '../host/state.ts'

export interface ParsedSpec {
  config: PatcherConfig | undefined
  error: string | undefined
}

/**
 * Parse a spec, then hold it to the same rules the form holds a draft to.
 *
 * Checking here rather than letting the host refuse it is the whole point of
 * doing this at all: a paste of forty patches should come back with "patch 12
 * has no reason", not with a page that quietly did nothing.
 */
export function parseSpecText(text: string, state: PatcherState): ParsedSpec {
  const trimmed = text.trim()
  if (trimmed === '') return { config: undefined, error: 'there is nothing to import' }
  let raw: unknown
  try {
    raw = JSON.parse(trimmed)
  } catch (error) {
    return { config: undefined, error: 'not JSON: ' + (error instanceof Error ? error.message : String(error)) }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { config: undefined, error: 'a spec is an object with a patches array' }
  }
  const candidate = raw as { patches?: unknown; reconcileNonce?: unknown }
  if (!Array.isArray(candidate.patches)) {
    return { config: undefined, error: 'a spec needs a patches array, even an empty one' }
  }
  const patches = candidate.patches as Patch[]
  // The paste replaces the whole spec, so no id is exempt from the collision
  // check — `exceptId` is for an edit, where the id is in the spec precisely
  // because it is being edited.
  const ids = new Set<string>()
  for (const patch of patches) {
    const id = patch?.id
    if (typeof id === 'string' && ids.has(id)) {
      return { config: undefined, error: id + ': id is already used by another patch in the spec' }
    }
    if (typeof id === 'string') ids.add(id)
  }
  // `enabled` is normalised rather than passed through: the host's schema
  // defaults it to true, and writing back an absent key would leave the page
  // showing a patch that looks like it has no enabled state at all.
  const normalised = patches.map((patch) => ({ ...patch, enabled: patch?.enabled !== false }) as Patch)
  const holding: PatcherState = {
    ...state,
    spec: { patches: normalised, reconcileNonce: 0, initialized: false },
  }
  for (const patch of normalised) {
    const draft: DraftPatch = {
      id: patch.id,
      enabled: patch.enabled,
      reason: patch.reason,
      target: patch.target,
      op: patch.op,
    }
    const problem = validateDraft(draft, holding, patch.id)
    if (problem !== undefined) {
      return { config: undefined, error: (patch.id ?? 'a patch') + ': ' + problem }
    }
  }
  const nonce = candidate.reconcileNonce
  return {
    config: {
      patches: normalised,
      reconcileNonce: typeof nonce === 'number' && Number.isFinite(nonce) ? nonce : 0,
      // A paste is a complete spec, so it counts as the operator having
      // decided. Only text that says otherwise is left uninitialised, and
      // writeOps never sends this field, so a decision made here cannot be
      // undone by it — it only stops a fresh profile from seeding over a
      // spec that was deliberately carried here.
      initialized: candidate.initialized !== false,
    },
    error: undefined,
  }
}

/**
 * The spec as text, ready to be copied out or fed to the CLI.
 *
 * `initialized` is written even when it is false. The text is a whole spec
 * that may be pasted into a profile that has never seen this plugin, and
 * an unlabelled one would be indistinguishable from "nobody has chosen
 * yet" — the host would seed its defaults straight over the paste. Naming
 * the flag is what lets a spec travel without being mistaken for an empty
 * namespace.
 */
export function formatSpecText(config: PatcherConfig | undefined): string {
  if (config === undefined) return JSON.stringify({ patches: [], reconcileNonce: 0, initialized: false }, null, 2)
  return JSON.stringify(
    { patches: patchesOf(config), reconcileNonce: config.reconcileNonce, initialized: config.initialized !== false },
    null,
    2,
  )
}
