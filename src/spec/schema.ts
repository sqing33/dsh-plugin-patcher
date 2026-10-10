/**
 * Schemastery surface for the patch spec.
 *
 * Two schemastery behaviours shape this file, and both are load-bearing.
 *
 * 1. **Every field needs an explicit `.required()`.** Schemastery treats an
 *    absent key as `undefined` and lets it through: `z.object({ reason:
 *    z.string() })` happily accepts `{}`. Constraints still fire on a key that
 *    *is* present — `.min(1)`, `.pattern()`, `z.const()` all threw when tested
 *    — so `.required()` is what turns "would be nice" into "cannot be missing".
 *    Anything genuinely optional simply omits it, and that is visible in the
 *    source.
 *
 * 2. **The trailing `.volatile()` is what makes this namespace exist.**
 *
 *    dsh-settings decides what may be edited at runtime through
 *    `isVolatilePath(schema, path)`, which short-circuits on the root node:
 *
 *        function isVolatilePath(schema, path) {
 *          if (schema.meta.volatile) return true
 *          ...
 *        }
 *
 *    and `volatileForm()` only ever recurses into `type === "object"` nodes.
 *    Marking the root volatile therefore both (a) makes describe() return this
 *    namespace at all — a namespace whose Config has no volatile field is
 *    hidden from the settings form entirely — and (b) makes every sub-path,
 *    including array indices, writable through `settings.mutate()`. Marking
 *    individual fields instead would leave anything under a z.array()
 *    unreachable.
 *
 * Note also that calling this schema yields a cosmokit `Volatile` reference,
 * not its data: read it with `.get()`. See `SchemaOutput` in the schemastery
 * typings, which maps the 'volatile' mode to `Volatile<T | undefined>`.
 */

import z from '@deepseek-ai/schemastery'
import { PACKAGE_PATH_PATTERN, PATCH_ID_PATTERN, SOURCE_PATTERN } from './types.ts'

/** Accepts any JSON. The `$gen` shape is discriminated in code, not here. */
const jsonValue = z.any()

const generatorRequest = z.object({
  $gen: z.string().min(1).required(),
  args: z.dict(jsonValue),
})

const codeEdit = z.object({
  find: z.string().min(1).required().description('Exact text to find. A literal, never a pattern.'),
  replace: z.string().required().description('Replacement text.'),
  count: z.const(1 as const).required().description('Occurrences to require. Always 1.'),
})

/**
 * One file a code patch adds, with its content kept as a real file in this
 * package rather than escaped into the spec.
 *
 * Both fields are `.required()` for the reason in the header: a `files` entry
 * that is missing its `path` would otherwise parse into an entry that writes
 * nowhere, and one missing its `source` into an entry with nothing to copy.
 * `path` cannot block `..` (see hasTraversal in types.ts) and `source` cannot
 * block `..` at all while still allowing a nested `patches/pkg/x.js`, so both
 * are checked a second time in src/spec/resolve.ts.
 */
const sourceFile = z.object({
  path: z.string().pattern(PACKAGE_PATH_PATTERN).required().description('Package-relative destination inside the patched package.'),
  source: z.string().pattern(SOURCE_PATTERN).required().description('Where the content lives: relative to this package root, under patches/.'),
})

const settingsTarget = z.object({
  kind: z.const('settings' as const).required(),
  namespace: z.string().min(1).required().description("The target plugin's profile entry id."),
})

const patchRowTarget = z.object({
  kind: z.const('patch-row' as const).required(),
  rowId: z.string().min(1).required().description("The '- id:' of the row to edit."),
  // Deliberately optional: it is a guard, and a guard you must fill in to use
  // the row at all is not a guard.
  name: z.string().min(1).description("Optional guard: the row's name: must also match."),
})

const packageFileTarget = z.object({
  kind: z.const('package-file' as const).required(),
  pkg: z.string().min(1).required().description('Package name as installed in the profile.'),
  // Required, not optional. A pnpm patch that no longer matches the installed
  // version fails hard with ERR_PNPM_UNUSED_PATCH and writes not a single byte,
  // which from the operator's side is indistinguishable from the patcher having
  // done nothing at all. Requiring the version here turns that silent no-op
  // into a spec that refuses to load.
  version: z.string().min(1).required().description('Exact installed version. A mismatch is unsupported.'),
  path: z.string().pattern(PACKAGE_PATH_PATTERN).required().description('Package-relative file path.'),
})

const target = z.union([settingsTarget, patchRowTarget, packageFileTarget])

const op = z.union([
  z.object({
    kind: z.const('set' as const).required(),
    path: z.array(z.string().min(1)).required(),
    value: jsonValue,
  }),
  z.object({
    kind: z.const('unset' as const).required(),
    path: z.array(z.string().min(1)).required(),
  }),
  z.object({
    kind: z.const('merge-config' as const).required(),
    config: z.dict(jsonValue).required(),
  }),
  z.object({
    kind: z.const('set-enabled' as const).required(),
    enabled: z.boolean().required(),
  }),
  z.object({
    kind: z.const('code' as const).required(),
    edits: z.array(codeEdit).required(),
    // `.default([])`, not `.required()`: every spec written before files
    // existed is still a valid spec, and a required key would turn this
    // extension into a breaking change for each of them. The `edits` above
    // stays required, because a spec carrying neither list is refused by
    // src/spec/resolve.ts rather than here.
    files: z.array(sourceFile).default([]),
  }),
  z.object({ kind: z.const('verify-only' as const).required() }),
])

const patch = z.object({
  id: z.string().pattern(PATCH_ID_PATTERN).required().description('Unique within the spec; the journal is keyed by it.'),
  enabled: z.boolean().default(true),
  reason: z.string().min(1).required().description('Why this patch exists. Shown verbatim in the settings page.'),
  target: target.required(),
  op: op.required(),
})

export const patcherConfigSchema = z.object({
  patches: z.array(patch).default([]),
  reconcileNonce: z.natural().default(0),
  // Seeded by the host on first sight of this namespace, and only then.
  // See the comment on PatcherConfig.initialized: an empty patch list has
  // to mean one thing or the other, and this is what picks which.
  initialized: z.boolean().default(false),
}).volatile()

export { generatorRequest, jsonValue }
