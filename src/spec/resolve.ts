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
import type { Json, Op, Patch, PatcherConfig, Target, Value } from './types.ts'

/**
 * A named value producer, addressed from the spec as `{ $gen: id, args }`.
 *
 * Generators exist so the settings form can offer a handful of things nobody
 * wants to type by hand — a full provider block, a ladder of reasoning levels —
 * without the engine growing any special case for them.
 */
export interface Generator {
  readonly id: string
  /** One line, shown in the settings page as the generator's own description. */
  readonly description: string
  generate(args: Record<string, unknown>): Json
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
}

const TARGET_OPS: Record<Target['kind'], readonly Op['kind'][]> = {
  settings: ['set', 'unset', 'verify-only'],
  'patch-row': ['merge-config', 'set-enabled', 'verify-only'],
  'package-file': ['code', 'verify-only'],
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
): { value?: Json; error?: string } {
  if (isGeneratorRequest(value)) {
    const generator = generators.get(value.$gen)
    if (!generator) {
      return { error: `${path}: unknown generator "${value.$gen}"` }
    }
    let produced: Json
    try {
      produced = generator.generate(value.args ?? {})
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { error: `${path}: generator "${value.$gen}" failed: ${message}` }
    }
    return { value: produced }
  }
  if (Array.isArray(value)) {
    const out: Json[] = []
    for (const [index, item] of value.entries()) {
      const step = expandValue(item, generators, `${path}[${index}]`)
      if (step.error) return { error: step.error }
      out.push(step.value as Json)
    }
    return { value: out }
  }
  if (isPlainObject(value)) {
    const out: Record<string, Json> = {}
    for (const [key, item] of Object.entries(value)) {
      const step = expandValue(item, generators, `${path}.${key}`)
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
    case 'code':
      if (patch.op.edits.length === 0) {
        fail('op.edits', 'code with no edits would rewrite the file for nothing')
      }
      break
    case 'set-enabled':
    case 'verify-only':
      break
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
    }
  }

  const rejected = new Set<string>()
  const seen = new Set<string>()
  const rowOwners = new Map<string, string[]>()

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
  })

  const contestedRows = new Set<string>()
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

  for (const id of referencedGenerators(parsed)) {
    if (!generators.has(id)) {
      diagnostics.push({ path: 'op.value', message: `spec references unknown generator "${id}"` })
    }
  }

  return { config: parsed, diagnostics, rejected, contestedRows }
}

export { describeTarget }
