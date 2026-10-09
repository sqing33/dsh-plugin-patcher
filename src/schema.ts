/**
 * Schemastery surface for the ladder config.
 *
 * Kept apart from ladder.ts so the ladder arithmetic stays a pure module with
 * no imports at all: the unit tests then run under bare node with nothing
 * installed, instead of depending on the host's dependency tree.
 */

import z from '@deepseek-ai/schemastery'
import { REASONING_LEVELS } from './ladder.ts'

export const effortsSchema = z.dict(
  z.union([z.string(), z.const(null)]),
  z.union(REASONING_LEVELS),
)

const modelLadderConfig = z.object({
  efforts: effortsSchema,
  disabled: z.boolean(),
})

const providerLadderConfig = z.object({
  api: z.string(),
  reasoning: z.union(REASONING_LEVELS),
  efforts: effortsSchema,
  disabled: z.boolean(),
  models: z.dict(modelLadderConfig),
})

export const ladderConfigSchema = z.object({
  /** false = only act on providers listed under providers. */
  auto: z.boolean(),
  /** false = leave the profile patch alone (settings-only enforcement). */
  force: z.boolean(),
  defaults: z.object({
    api: z.string(),
    reasoning: z.union(REASONING_LEVELS),
    efforts: effortsSchema,
  }),
  providers: z.dict(providerLadderConfig),
  targets: z.object({
    /** true (default) = overwrite already-declared reasoningEfforts. */
    overwrite: z.boolean(),
    /** true (default) = also cover the modelOverrides section. */
    modelOverrides: z.boolean(),
  }),
})
