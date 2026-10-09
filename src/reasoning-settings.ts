import { defaultEffortsFor, mergeEfforts } from './ladder.ts'

export type Efforts = Record<string, string>

export interface SettingsOp {
  op: 'set'
  path: string[]
  value: unknown
}

export interface ModelReasoningConfig {
  efforts?: Efforts
  disabled?: boolean
}

export interface ProviderReasoningConfig {
  api?: string
  reasoning?: string
  efforts?: Efforts
  disabled?: boolean
  models?: Record<string, ModelReasoningConfig>
}

export interface LadderTargets {
  /** false = keep upstream's preserve-guard; true = force-overwrite declared values. */
  overwrite?: boolean
  /** Whether to touch the `modelOverrides` section of a provider profile. */
  modelOverrides?: boolean
}

export interface LadderConfig {
  auto?: boolean
  defaults?: { api?: string; reasoning?: string; efforts?: Efforts }
  providers?: Record<string, ProviderReasoningConfig>
  targets?: LadderTargets
}

function atPath(source: unknown, path: string[]): unknown {
  let current: unknown = source
  for (const key of path) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return void 0
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringAt(value: unknown): string | undefined {
  return typeof value === 'string' ? value : void 0
}

function effectiveEfforts(
  api: string | undefined,
  providerEfforts: Efforts | undefined,
  modelEfforts: Efforts | undefined,
): Efforts {
  return mergeEfforts(mergeEfforts(defaultEffortsFor(api), providerEfforts), modelEfforts)
}

export function mergeProviderConfig(
  defaults: LadderConfig['defaults'],
  override: ProviderReasoningConfig | undefined,
): ProviderReasoningConfig {
  const defaultEfforts = defaults?.efforts
  const overrideEfforts = override?.efforts
  const efforts =
    defaultEfforts === void 0 && overrideEfforts === void 0
      ? void 0
      : mergeEfforts(defaultEfforts ?? {}, overrideEfforts)
  return {
    api: override?.api ?? defaults?.api,
    reasoning: override?.reasoning ?? defaults?.reasoning,
    efforts,
    disabled: override?.disabled,
    models: override?.models,
  }
}

/**
 * Build the ops that force the ladder onto one provider profile.
 *
 * `targets.overwrite` (default true) is the only behavioural switch and it
 * maps one-to-one onto a diff hunk: when false we keep the upstream 0.2.8
 * preserve-guard `if (entry.reasoningEfforts !== void 0) return entry`, when
 * true we drop it and overwrite whatever was already declared.
 */
export function buildProviderOps(
  provider: string,
  providerConfig: ProviderReasoningConfig,
  profile: Record<string, unknown>,
  targets: LadderTargets = {},
): SettingsOp[] {
  if (providerConfig.disabled === true) return []
  const overwrite = targets?.overwrite !== false
  const coverModelOverrides = targets?.modelOverrides !== false
  const ops: SettingsOp[] = []
  const api = providerConfig.api ?? stringAt(profile.api)

  if (providerConfig.reasoning !== void 0 && profile.reasoning === void 0) {
    ops.push({ op: 'set', path: ['providers', provider, 'reasoning'], value: providerConfig.reasoning })
  }

  const models = profile.models
  if (Array.isArray(models)) {
    let modelsChanged = false
    const nextModels = models.map((entry) => {
      if (!isRecord(entry)) return entry
      const modelId = entry.id
      if (typeof modelId !== 'string' || modelId.length === 0) return entry
      const modelConfig = providerConfig.models?.[modelId]
      if (modelConfig?.disabled === true) {
        if (entry.reasoningEfforts === void 0) {
          modelsChanged = true
          return { ...entry, reasoningEfforts: false }
        }
        return entry
      }
      if (!overwrite && entry.reasoningEfforts !== void 0) return entry
      modelsChanged = true
      return {
        ...entry,
        reasoningEfforts: effectiveEfforts(api, providerConfig.efforts, modelConfig?.efforts),
      }
    })
    if (modelsChanged) {
      ops.push({ op: 'set', path: ['providers', provider, 'models'], value: nextModels })
    }
  }

  const overrides = profile.modelOverrides
  if (coverModelOverrides && isRecord(overrides)) {
    for (const [modelId, modelOverride] of Object.entries(overrides)) {
      if (!isRecord(modelOverride)) continue
      const modelConfig = providerConfig.models?.[modelId]
      if (modelConfig?.disabled === true) {
        if (modelOverride.reasoningEfforts === void 0) {
          ops.push({
            op: 'set',
            path: ['providers', provider, 'modelOverrides', modelId, 'reasoningEfforts'],
            value: false,
          })
        }
        continue
      }
      if (!overwrite && modelOverride.reasoningEfforts !== void 0) continue
      ops.push({
        op: 'set',
        path: ['providers', provider, 'modelOverrides', modelId, 'reasoningEfforts'],
        value: effectiveEfforts(api, providerConfig.efforts, modelConfig?.efforts),
      })
    }
  }

  return ops
}

/** Build additive updates for all Provider profiles that already exist in llm-pi-ai. */
export function buildReasoningOps(current: unknown, config: LadderConfig = {}): SettingsOp[] {
  const providers = atPath(current, ['providers'])
  if (!isRecord(providers)) return []
  const ops: SettingsOp[] = []
  const configuredProviders = config.providers ?? {}
  const auto = config.auto !== false
  for (const [provider, profile] of Object.entries(providers)) {
    if (!isRecord(profile)) continue
    const override = configuredProviders[provider]
    if (!auto && override === void 0) continue
    ops.push(
      ...buildProviderOps(provider, mergeProviderConfig(config.defaults, override), profile, config.targets),
    )
  }
  return ops
}
