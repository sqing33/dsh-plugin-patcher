/** Every reasoning level the DSH pi-ai adapter understands. */
export const REASONING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const

export type ReasoningLevel = (typeof REASONING_LEVELS)[number]

/**
 * The ladder this plugin enforces.
 *
 * Differs from upstream dsh-reasoning-effort in exactly one way: the bottom
 * rung is `off` rather than `low`. See README "Relationship to upstream".
 */
const FIVE_LEVEL_EFFORTS: Record<string, string> = {
  off: 'off',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
}

/** Defaults for protocols supported by the Harness pi-ai adapter. */
const DEFAULT_EFFORTS_BY_API: Record<string, Record<string, Record<string, string>>> = {
  'openai-completions': FIVE_LEVEL_EFFORTS,
  'openai-responses': FIVE_LEVEL_EFFORTS,
  deepseek: FIVE_LEVEL_EFFORTS,
  openrouter: FIVE_LEVEL_EFFORTS,
  together: FIVE_LEVEL_EFFORTS,
  zai: FIVE_LEVEL_EFFORTS,
  qwen: FIVE_LEVEL_EFFORTS,
  'string-thinking': FIVE_LEVEL_EFFORTS,
  'ant-ling': FIVE_LEVEL_EFFORTS,
  anthropic: FIVE_LEVEL_EFFORTS,
}

/** Fallback for an omitted or unknown provider API. */
const DEFAULT_EFFORTS: Record<string, string> = { ...FIVE_LEVEL_EFFORTS }

export function defaultEffortsFor(api: string | undefined): Record<string, string> {
  if (api !== void 0) {
    const found = DEFAULT_EFFORTS_BY_API[api]
    if (found !== void 0) return { ...found }
  }
  return { ...DEFAULT_EFFORTS }
}

/**
 * Merge a user override over the protocol defaults.
 *
 * This is a shallow spread, so an override can *add* a rung but never remove
 * one. That is why an exact five-rung ladder cannot be reached through
 * upstream's config path and has to be written by this plugin directly.
 */
export function mergeEfforts(
  base: Record<string, string>,
  override: Record<string, string> | undefined,
): Record<string, string> {
  return override === void 0 ? { ...base } : { ...base, ...override }
}
