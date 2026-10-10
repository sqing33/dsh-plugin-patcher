/**
 * Drift fingerprints.
 *
 * The engine has to answer one question on every reconcile: "is the thing this
 * patch owns still the thing the patch wanted?" A naive comparison of the whole
 * target answers it wrongly in both directions — a user's unrelated key makes
 * an in-sync patch look drifted, and a patch that wrote the wrong value looks
 * in-sync because everything around it matches. So drift is judged on a hash of
 * the sub-tree the op actually addresses, folded together with a hash of the op
 * itself: the window is exactly as wide as the claim, and widening the window
 * changes the op hash too.
 *
 * Pure module: no I/O and no host imports, so the unit tests run under bare
 * node with nothing installed.
 */

import { createHash } from 'node:crypto'
import type { Json, Patch } from '../spec/types.ts'

/** Marker for a value that refers back to one of its own ancestors. */
const CYCLE = '@cycle'

/** Short enough to read inside a status detail, long enough to be a fingerprint. */
const FINGERPRINT_LENGTH = 16

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Accept only a canonical, non-negative array index.
 *
 * '01', '-1' and '1.5' are rejected on purpose: none of them is an index, and
 * coercing them would let a patch address a slot the spec never named.
 */
function indexOf(segment: string): number | undefined {
  if (!/^(0|[1-9][0-9]*)$/.test(segment)) return void 0
  const index = Number(segment)
  return Number.isSafeInteger(index) ? index : void 0
}

function describe(value: unknown, stack: readonly object[]): string {
  if (value === void 0) return 'u'
  if (value === null) return 'n'
  switch (typeof value) {
    case 'string':
      return 's' + JSON.stringify(value)
    case 'number':
      return 'd' + String(value)
    case 'boolean':
      return value ? 'b1' : 'b0'
    case 'bigint':
      return 'g' + String(value)
    case 'symbol':
      return 'y' + String(value)
    case 'function':
      return 'f' + String((value as { name?: string }).name ?? '')
    default:
      break
  }
  const object = value as object
  // Ancestors only, not everything already seen: a value reachable twice
  // through two different keys is a shared reference, not a cycle, and has to
  // keep hashing as itself. The depth in the marker keeps two distinct cycles
  // from colliding.
  if (stack.includes(object)) return CYCLE + stack.length
  if (Array.isArray(object)) {
    const inner = stack.concat([object])
    return 'a[' + object.map((item) => describe(item, inner)).join(',') + ']'
  }
  if (object instanceof Date) return 't' + object.getTime()
  if (object instanceof Map) {
    const inner = stack.concat([object])
    const rows: string[] = []
    for (const [key, item] of object) rows.push(describe(key, inner) + '=>' + describe(item, inner))
    return 'm{' + rows.sort().join(',') + '}'
  }
  if (object instanceof Set) {
    const inner = stack.concat([object])
    const rows: string[] = []
    for (const item of object) rows.push(describe(item, inner))
    return 'e{' + rows.sort().join(',') + '}'
  }
  const inner = stack.concat([object])
  const record = object as Record<string, unknown>
  const fields: string[] = []
  for (const key of Object.keys(record).sort()) {
    fields.push(describe(key, inner) + ':' + describe(record[key], inner))
  }
  return 'o{' + fields.join(',') + '}'
}

/**
 * Hash any value into a short, stable digest.
 *
 * Object keys are sorted, so two documents that differ only in key order hash
 * alike, while array order is preserved because ['a','b'] and ['b','a'] really
 * are different documents. 'undefined' gets its own marker so that "nothing
 * here" never hashes as "explicitly null", which is the difference between an
 * absent settings key and a cleared one.
 *
 * Cycles are tolerated rather than thrown on: adapter values come from YAML and
 * JSON, but the engine also hands it live host objects, and a fingerprint that
 * threw would take the whole reconcile down with it.
 */
export function fingerprintOf(value: unknown): string {
  return createHash('sha256').update(describe(value, [])).digest('hex').slice(0, FINGERPRINT_LENGTH)
}

/**
 * The path an op addresses, or [] when the op owns the whole target.
 *
 * merge-config, set-enabled, code and verify-only have no sub-path: they read
 * and write their target as a unit, so their drift window is the entire value.
 * A copy is returned so a caller cannot write the spec's own array back.
 */
export function touchedPaths(patch: Patch): string[] {
  return 'path' in patch.op ? [...patch.op.path] : []
}

/**
 * Read the value at a path without touching anything.
 *
 * A segment addresses an array slot only when the current value really is an
 * array and the segment is a canonical index. Everything else reads as absent,
 * because a reader that guessed would invent drift nobody caused.
 */
export function selectAt(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const segment of path) {
    if (Array.isArray(current)) {
      const index = indexOf(segment)
      if (index === void 0) return void 0
      current = current[index]
      continue
    }
    if (!isRecord(current)) return void 0
    current = current[segment]
  }
  return current
}

/** Render a path segment the way the writer walked it: a real array slot as [1]. */
function renderKey(key: string): string {
  if (indexOf(key) !== void 0) return '[' + key + ']'
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? '.' + key : "['" + key + "']"
}

function assign(node: unknown, key: string, value: Json, at: string): Json {
  if (Array.isArray(node)) {
    const index = indexOf(key)
    if (index === void 0) throw new TypeError('writeAt cannot use ' + at + ' as an array index')
    if (index >= node.length) throw new TypeError('writeAt index ' + index + ' is out of range at ' + at)
    const copy = node.slice()
    copy[index] = value
    return copy
  }
  if (node === void 0) return { [key]: value }
  if (!isRecord(node)) throw new TypeError('writeAt cannot descend into a non-object at ' + at)
  return { ...(node as Record<string, Json>), [key]: value }
}

function writeStep(node: unknown, path: readonly string[], next: unknown, at: string): Json {
  const key = path[0] as string
  const here = at + renderKey(key)
  if (path.length === 1) return assign(node, key, next as Json, here)
  const child = isRecord(node) || Array.isArray(node) ? selectAt(node, [key]) : void 0
  // A container that is simply absent gets created, because that is how a spec
  // grows a settings namespace. A container that is present but is a scalar is
  // a hard error: replacing it silently would destroy data this patch never
  // claimed to own.
  if (child !== void 0 && !isRecord(child) && !Array.isArray(child)) {
    throw new TypeError('writeAt cannot descend into a non-object at ' + here)
  }
  return assign(node, key, writeStep(child ?? {}, path.slice(1), next, here), here)
}

/**
 * Return a copy of 'value' with 'next' written at 'path'.
 *
 * Only the containers along the path are cloned: every untouched sibling keeps
 * its original reference, so the caller's value is neither mutated nor deep
 * copied. Arrays are only ever indexed, never grown — a spec naming index 3 of
 * a list that does not exist yet is a spec bug, and inventing the list would
 * hide it, so the numeric segment becomes an ordinary key on a fresh object
 * instead. Every structural mistake throws a TypeError naming the offending
 * path, because a patch that silently wrote somewhere else is worse than one
 * that refused outright.
 */
export function writeAt(value: unknown, path: readonly string[], next: unknown): Json {
  if (path.length === 0) throw new TypeError('writeAt requires a non-empty path')
  return writeStep(value, path, next, '$')
}

/**
 * Fingerprint what a patch currently sees.
 *
 * Only the sub-tree the op addresses is hashed, so a sibling key somebody else
 * edited does not make an in-sync patch look drifted. The op is folded in as
 * well: two patches writing the same value to the same place are still two
 * different claims, and a fingerprint that could not tell them apart could not
 * answer "did this patch run".
 */
export function patchFingerprint(patch: Patch, current: unknown): string {
  const path = touchedPaths(patch)
  const subject = path.length === 0 ? current : selectAt(current, path)
  return fingerprintOf({ op: patch.op, value: subject })
}

/**
 * Fingerprint the state a patch wants to leave behind.
 *
 * Deliberately symmetric with patchFingerprint. For a 'set' the resolved value
 * is exactly what the current document should already hold at that path. For an
 * 'unset' the desired value is nothing at all, so the expected side has to look
 * through the same window and find undefined there — which is precisely the
 * moment an unset has already been applied, and so the only moment the two
 * fingerprints agree.
 */
export function expectedFingerprint(patch: Patch, resolvedValue: unknown): string {
  const path = touchedPaths(patch)
  const subject =
    path.length === 0 || patch.op.kind !== 'unset' ? resolvedValue : selectAt(resolvedValue, path)
  return fingerprintOf({ op: patch.op, value: subject })
}
