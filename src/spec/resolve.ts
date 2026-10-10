/**
 * Turning whatever is in this plugin's settings namespace into a spec the
 * engine can act on.
 *
 * This layer exists because dsh-settings is a deliberately weak gate. With the
 * root of the Config marked volatile, `settings.mutate()` skips validation of
 * everything below the top-level keys (see the note in spec/schema.ts), and
 * `describe()` passes array elements through untouched. So a spec that reached
 * this plugin can contain any JSON at all. Everything downstream — the
 * adapters, the journal, the engine — is allowed to assume the spec that comes
 * out of here is well formed.
 */

import { patcherConfigSchema } from './schema.ts'
import { hasTraversal, opPath } from './types.ts'
import type { Json, Op, Patch, PatcherConfig, Target, Value } from './types.ts'

/**
 * A named value producer, addressed from the spec as `{ $gen: id, args }`.
 *
 * Generators exist so the settings form can offer a handful of things nobody
 * wants to type by hand — a full provider block, a ladder of reasoning levels —
 * without the engine growing any special case for them.
 */
export interface GeneratorContext {
  /**
   * The live value at the path the request is about to write, when the caller
   * knows it. Generators that compute a value *from* what is already there
   * (a ladder over the models a provider already declares) need this; a
   * generator that only needs its own arguments never reads it.
   */
  readonly current?: unknown
}

export interface Generator {
  readonly id: string
  /** One line, shown in the settings page as the generator's own description. */
  readonly description: string
  generate(args: Record<string, unknown>, context?: GeneratorContext): Json
}

export type GeneratorRegistry = ReadonlyMap<string, Generator>

/** One problem found in the spec, addressed precisely enough to fix by hand. */
export interface SpecDiagnostic {
  /** Dotted path into the spec, e.g. `patches[1].op.path`. */
  path: string
  message: string
  /** The patch this belongs to, when it can be attributed to one. */
  patchId?: string
}

export interface ResolvedSpec {
  /**
   * The spec, or `undefined` when it failed the schema layer. A structural
   * failure means there is nothing to reconcile, so the engine must not fall
   * back to an empty spec and quietly claim everything is fine.
   */
  config: PatcherConfig | undefined
  diagnostics: SpecDiagnostic[]
  /**
   * Patch ids that must not be applied because their own definition is broken.
   * Their siblings still reconcile.
   */
  rejected: ReadonlySet<string>
  /**
   * Patch-row ids claimed by more than one patch. Those patches go to
   * `conflict` rather than letting the last one silently win, because a patch
   * row is a single shared line in one file.
   */
  contestedRows: ReadonlySet<string>
  /** Config slots written by more than one patch at overlapping paths. */
  contestedSlots: ReadonlySet<string>
}

/**
 * Which operations each target can carry.
 *
 * package-file is not offered verify-only. That operation carries no payload,
 * so on a file it would have nothing to look for and could only ever report
 * success — an assertion that cannot fail is worse than no assertion, because
 * it reads like a check. The version pin on a package-file target is the real
 * assertion: a package that moved on shows up as unsupported, not silent.
 */
const TARGET_OPS: Record<Target['kind'], readonly Op['kind'][]> = {
  settings: ['set', 'unset', 'verify-only'],
  'patch-row': ['merge-config', 'set-enabled', 'verify-only'],
  'package-file': ['code'],
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A value is a generator request only when it is a plain object carrying a
 * non-empty string `$gen`. dsh-settings projects arrays and `z.any()` nodes
 * through unchanged, so this check has to be strict — a payload that merely
 * happens to have a `$gen` key of some other shape is data, not a request.
 */
export function isGeneratorRequest(value: Value | unknown): value is { $gen: string; args?: Record<string, unknown> } {
  return isPlainObject(value) && typeof value.$gen === 'string' && value.$gen.length > 0
}

/**
 * Materialise a spec value: run every `$gen` request in it through the
 * registry, recursively. Returns `undefined` plus a reason when a request
 * names a generator that is not registered or throws, so the caller can report
 * exactly which patch failed instead of writing a half-expanded value.
 */
export function expandValue(
  value: Value | unknown,
  generators: GeneratorRegistry,
  path = '$',
  context?: GeneratorContext,
): { value?: Json; error?: string } {
  if (isGeneratorRequest(value)) {
    const generator = generators.get(value.$gen)
    if (!generator) {
      return { error: `${path}: unknown generator "${value.$gen}"` }
    }
    let produced: Json
    try {
      produced = generator.generate(value.args ?? {}, context)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { error: `${path}: generator "${value.$gen}" failed: ${message}` }
    }
    return { value: produced }
  }
  if (Array.isArray(value)) {
    const out: Json[] = []
    for (const [index, item] of value.entries()) {
      const step = expandValue(item, generators, `${path}[${index}]`, context)
      if (step.error) return { error: step.error }
      out.push(step.value as Json)
    }
    return { value: out }
  }
  if (isPlainObject(value)) {
    const out: Record<string, Json> = {}
    for (const [key, item] of Object.entries(value)) {
      const step = expandValue(item, generators, `${path}.${key}`, context)
      if (step.error) return { error: step.error }
      out[key] = step.value as Json
    }
    return { value: out }
  }
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    return { error: `${path}: ${typeof value} is not a value a patch can write` }
  }
  return { value: value as Json }
}

/** Every generator id reachable from a spec, without expanding anything. */
export function referencedGenerators(config: PatcherConfig): Set<string> {
  const ids = new Set<string>()
  const walk = (value: unknown): void => {
    if (isGeneratorRequest(value)) {
      ids.add(value.$gen)
      return
    }
    if (Array.isArray(value)) {
      value.forEach(walk)
      return
    }
    if (isPlainObject(value)) Object.values(value).forEach(walk)
  }
  for (const patch of config.patches) {
    if (patch.op.kind === 'set') walk(patch.op.value)
  }
  return ids
}

function describeTarget(target: Target): string {
  switch (target.kind) {
    case 'settings':
      return target.namespace
    case 'patch-row':
      return target.rowId
    case 'package-file':
      return `${target.pkg}${target.version ? '@' + target.version : ''}`
  }
}

/**
 * A plain JSON object. `typeof null === 'object'`, hence the second test.
 *
 * The adapter side keeps its own copy of this on purpose: it is three lines,
 * and an adapters-to-spec import would be a dependency edge the module graph
 * does not otherwise have.
 */
/**
 * The one physical slot a patch writes, or undefined when it writes none.
 *
 * A settings namespace is not a separate store: dsh-settings resolves it
 * through the config editor, which lands the value in the `config:` key of the
 * profile patch row with the same id. So a settings patch on `foo` and a
 * patch-row patch on row `foo` are two writers for one key, and letting both
 * through means the second silently undoes the first — which then reports
 * itself drifted on the next reconcile, forever, with nothing pointing at the
 * cause.
 *
 * `set-enabled` is not in here because it writes the row's `disabled:` key
 * rather than `config:`, and a verify-only writes nothing at all. Two paths in
 * one namespace only collide when they overlap, so the slot is the namespace
 * and the caller compares the paths.
 */
export function slotOf(patch: Patch): string | undefined {
  return configSlot(patch)
}

function configSlot(patch: Patch): string | undefined {
  if (patch.op.kind === 'verify-only') return undefined
  if (patch.target.kind === 'settings') return `the config of patch row "${patch.target.namespace}"`
  if (patch.target.kind === 'patch-row' && patch.op.kind === 'merge-config') {
    return `the config of patch row "${patch.target.rowId}"`
  }
  return undefined
}

/**
 * True when two writers into one slot would fight.
 *
 * A path of undefined means the whole slot: a merge writes the entire config
 * key, so it collides with anything else in that slot, and a path collides with
 * it too. Two paths collide when one is the other or sits inside it, because
 * writing a subtree replaces the part of it that was there.
 */
function overlaps(one: readonly string[] | undefined, other: readonly string[] | undefined): boolean {
  if (one === undefined || other === undefined) return true
  const shared = Math.min(one.length, other.length)
  for (let index = 0; index < shared; index += 1) {
    if (one[index] !== other[index]) return false
  }
  return true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The checks the schema cannot express, because each one spans two fields.
 *
 * Schemastery is fail-fast, so a structural problem is reported on its own and
 * these run only on a spec that already parsed. They are deliberately
 * non-throwing: a settings page wants every problem at once, not the first.
 */
function checkPatch(
  patch: Patch,
  index: number,
  diagnostics: SpecDiagnostic[],
  rejected: Set<string>,
): void {
  const at = `patches[${index}]`
  const fail = (path: string, message: string): void => {
    diagnostics.push({ path: `${at}.${path}`, message, patchId: patch.id })
    rejected.add(patch.id)
  }

  // loadSpec's contract is that it never throws, and every line below reaches
  // through `patch.target.kind` and `patch.op.kind`. The schema rejects a
  // non-object patch today, but a null slipping past a validation layer is a
  // TypeError inside the host fiber rather than a line in the diagnostics — so
  // the shape is checked here, where being wrong costs one message.
  if (!isRecord(patch) || !isRecord(patch.target) || !isRecord(patch.op)) {
    diagnostics.push({
      path: at,
      message: 'a patch must be an object with a target and an op',
      patchId: isRecord(patch) && typeof patch.id === 'string' ? patch.id : undefined,
    })
    if (isRecord(patch) && typeof patch.id === 'string') rejected.add(patch.id)
    return
  }

  const allowed = TARGET_OPS[patch.target.kind]
  if (!allowed.includes(patch.op.kind)) {
    fail(
      'op.kind',
      `a "${patch.target.kind}" target cannot be patched with "${patch.op.kind}"; `
        + `expected one of ${allowed.map((k) => `"${k}"`).join(', ')}`,
    )
    return
  }

  switch (patch.op.kind) {
    case 'set':
    case 'unset':
      if (patch.op.path.length === 0) fail('op.path', 'a path must have at least one segment')
      break
    case 'merge-config':
      if (Object.keys(patch.op.config).length === 0) {
        fail('op.config', 'merge-config with an empty config would rewrite the row for nothing')
      }
      break
    case 'code': {
      if (!Array.isArray(patch.op.files)) {
        // Unreachable through the schema, which types the key, and kept
        // anyway for the same reason as the shape check above: loadSpec owes
        // its caller diagnostics, never a TypeError from a line that assumed.
        fail('op.files', 'the files of a code patch must be a list')
        break
      }
      const files = patch.op.files
      if (patch.op.edits.length === 0 && files.length === 0) {
        // The two lists are alternatives, not halves of one instruction, so
        // the offending field is the op and not either list.
        fail('op', 'a code patch must edit or add at least one file')
        break
      }
      // One path twice means the later entry silently overwrites the earlier
      // one, which turns the order of the array into part of what the patch
      // means. Every other ambiguity here is refused rather than resolved.
      const added = new Set<string>()
      files.forEach((file, j) => {
        const where = `op.files[${j}]`
        if (hasTraversal(file.path)) {
          fail(`${where}.path`, `"${file.path}" climbs out of the package with ".."; a patch may only write inside the package it targets`)
          return
        }
        if (hasTraversal(file.source)) {
          fail(`${where}.source`, `"${file.source}" climbs out of this package with ".."; added content may only be read from under patches/`)
          return
        }
        if (added.has(file.path)) {
          fail(`${where}.path`, `"${file.path}" is already added by an earlier files entry; the second one would win, and that makes the order of the list the meaning`)
          return
        }
        added.add(file.path)
      })
      break
    }
    case 'set-enabled':
    case 'verify-only':
      break
  }

  if (patch.target.kind === 'package-file' && hasTraversal(patch.target.path)) {
    // PACKAGE_PATH_PATTERN rejects an absolute path and a backslash, and says
    // nothing about "..": saying it needs the segments, not a match over the
    // whole string. A target that climbs out is a patch aimed at a file in some
    // other package entirely, which is not what the operator wrote.
    fail('target.path', `"${patch.target.path}" climbs out of the package with ".."; a patch may only target a file inside the package it names`)
  }

  if (patch.target.kind === 'package-file' && !patch.target.version) {
    // A pnpm patch that no longer matches the installed version fails hard with
    // ERR_PNPM_UNUSED_PATCH and writes not a single byte, which reads exactly
    // like the patcher having done nothing. Requiring the version up front
    // turns that silent no-op into a refused, explainable patch.
    fail('target.version', 'a package-file patch must pin the exact installed version')
  }
}

/**
 * Validate a raw namespace value and return a spec the engine can trust.
 *
 * Never throws: a bad spec is data the settings page has to render, not an
 * exception the host should crash on.
 */
export function loadSpec(raw: unknown, generators: GeneratorRegistry = new Map()): ResolvedSpec {
  const diagnostics: SpecDiagnostic[] = []

  let parsed: PatcherConfig
  try {
    // `.get()` is not optional. A schema marked `.volatile()` parses into a
    // cosmokit Volatile reference, not into its data: calling it directly
    // hands back an object whose only key is `get`, and every field reads as
    // undefined. See Schemastery.SchemaOutput, which maps the 'volatile' mode
    // to `Volatile<T | undefined>`.
    parsed = patcherConfigSchema(raw ?? {}).get() as PatcherConfig
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const path = Array.isArray((error as { options?: { path?: unknown[] } })?.options?.path)
      ? `patches.${(error as { options: { path: unknown[] } }).options.path.join('.')}`
      : '.'
    return {
      config: undefined,
      diagnostics: [{ path, message }],
      rejected: new Set(),
      contestedRows: new Set(),
      contestedSlots: new Set(),
    }
  }

  const rejected = new Set<string>()
  const seen = new Set<string>()
  const rowOwners = new Map<string, string[]>()
  const slotOwners = new Map<string, Array<{ patchId: string; path: readonly string[] | undefined }>>()
  const contestedSlots = new Set<string>()
  const contestedRows = new Set<string>()

  parsed.patches.forEach((patch, index) => {
    if (seen.has(patch.id)) {
      diagnostics.push({
        path: `patches[${index}].id`,
        message: `duplicate patch id "${patch.id}"; the journal is keyed by id, so ids must be unique`,
        patchId: patch.id,
      })
      rejected.add(patch.id)
    }
    seen.add(patch.id)
    checkPatch(patch, index, diagnostics, rejected)
    if (patch.target.kind === 'patch-row') {
      const owners = rowOwners.get(patch.target.rowId) ?? []
      owners.push(patch.id)
      rowOwners.set(patch.target.rowId, owners)
    }
    const slot = configSlot(patch)
    if (slot !== undefined) {
      const owners = slotOwners.get(slot) ?? []
      owners.push({ patchId: patch.id, path: opPath(patch.op) })
      slotOwners.set(slot, owners)
    }
  })

  for (const [rowId, owners] of rowOwners) {
    if (owners.length < 2) continue
    contestedRows.add(rowId)
    for (const id of owners) {
      diagnostics.push({
        path: 'target.rowId',
        message: `patch row "${rowId}" is claimed by ${owners.length} patches (${owners.join(', ')}); `
          + 'a patch row is one shared line, so neither can win',
        patchId: id,
      })
    }
  }

  for (const [slot, owners] of slotOwners) {
    // Two settings patches in one namespace are fine while their paths are
    // disjoint: the ladder writes providers, a neighbour writes something else.
    // Only overlap means the later write makes the earlier one drifted.
    const fighting = owners.filter((owner) =>
      owners.some((other) => other !== owner && overlaps(other.path, owner.path)),
    )
    if (fighting.length < 2) continue
    contestedSlots.add(slot)
    for (const { patchId } of fighting) {
      diagnostics.push({
        path: 'target',
        message: slot + ' is written by ' + String(fighting.length) + ' patches at overlapping paths ('
          + fighting.map((o) => o.patchId + ' at ' + (o.path === undefined ? 'the whole config' : '[' + o.path.join(', ') + ']')).join('; ') + '); '
          + 'the last write would leave the others drifted, so none of them is applied',
        patchId,
      })
    }
  }

  for (const id of referencedGenerators(parsed)) {
    if (!generators.has(id)) {
      diagnostics.push({ path: 'op.value', message: `spec references unknown generator "${id}"` })
    }
  }

  return { config: parsed, diagnostics, rejected, contestedRows, contestedSlots }
}

export { describeTarget }
