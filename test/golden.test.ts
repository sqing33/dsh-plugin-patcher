import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { buildReasoningOps } from '../src/reasoning-settings.ts'

/**
 * Golden regression guard.
 *
 * The fixtures were produced by running the reference (forked) implementation
 * over the same snapshot; every case in the shared group is byte-identical to
 * it. The two extension cases exist only in this plugin and are pinned here so
 * the deliberate divergence cannot drift unnoticed either.
 */

const snapshot = JSON.parse(readFileSync(new URL('./fixtures/llm-pi-ai-snapshot.json', import.meta.url), 'utf8'))
const golden = JSON.parse(readFileSync(new URL('./fixtures/expected-ops.json', import.meta.url), 'utf8'))

const CONFIGS: Record<string, unknown> = {
  default: {},
  'auto off, one provider': { auto: false, providers: { anthropic: {} } },
  'auto off, provider disabled': { auto: false, providers: { anthropic: { disabled: true } } },
  'defaults.efforts additive': { defaults: { efforts: { max: 'MAX' } } },
  'defaults.api override': { defaults: { api: 'anthropic', efforts: { off: 'none' } } },
  'provider efforts override': { providers: { unknownproto: { efforts: { off: 'none' } } } },
  'model-level override': { providers: { anthropic: { models: { 'claude-opus-5': { efforts: { high: 'H' } } } } } },
  'provider reasoning fill': { providers: { unknownproto: { reasoning: 'enabled' } } },
  'model disabled via config': { providers: { anthropic: { models: { 'claude-opus-5': { disabled: true } } } } },
  'empty config object': { providers: {} },
  'overwrite off': { targets: { overwrite: false } },
  'modelOverrides off': { targets: { modelOverrides: false } },
}

describe('golden ops', () => {
  for (const [label, config] of Object.entries(CONFIGS)) {
    it(label, () => {
      assert.deepEqual(buildReasoningOps(snapshot, config as never), golden[label])
    })
  }

  it('covers every fixture so a new case cannot be silently unpinned', () => {
    assert.deepEqual(Object.keys(CONFIGS).sort(), Object.keys(golden).sort())
  })
})
