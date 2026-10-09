import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { defaultEffortsFor, mergeEfforts } from '../src/ladder.ts'
import {
  buildProviderOps,
  buildReasoningOps,
  mergeProviderConfig,
} from '../src/reasoning-settings.ts'

const LADDER = { off: 'off', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' }
const UPSTREAM_LADDER = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' }

describe('defaultEffortsFor', () => {
  it('returns the five-rung ladder with an off bottom rung', () => {
    assert.deepEqual(defaultEffortsFor('openai-completions'), LADDER)
    assert.deepEqual(defaultEffortsFor('anthropic'), LADDER)
  })

  it('falls back to the same ladder for an unknown or missing api', () => {
    assert.deepEqual(defaultEffortsFor('some-future-protocol'), LADDER)
    assert.deepEqual(defaultEffortsFor(undefined), LADDER)
  })

  it('returns a fresh object so a caller cannot mutate the defaults', () => {
    const first = defaultEffortsFor('deepseek')
    first.high = 'tampered'
    assert.deepEqual(defaultEffortsFor('deepseek'), LADDER)
  })

  it('never exposes a low rung, unlike upstream', () => {
    assert.ok(!('low' in defaultEffortsFor('openai-responses')))
  })
})

describe('mergeEfforts', () => {
  it('copies the base when there is no override', () => {
    const base = { high: 'high' }
    const merged = mergeEfforts(base, undefined)
    assert.deepEqual(merged, { high: 'high' })
    assert.notEqual(merged, base)
  })

  it('lets an override add a rung but never remove one', () => {
    assert.deepEqual(mergeEfforts({ high: 'high' }, { low: 'low' }), { high: 'high', low: 'low' })
    assert.deepEqual(mergeEfforts(UPSTREAM_LADDER, {}), UPSTREAM_LADDER)
  })
})

describe('mergeProviderConfig', () => {
  it('lets a provider override inherit from defaults', () => {
    const merged = mergeProviderConfig(
      { api: 'anthropic', reasoning: 'enabled', efforts: { high: 'high' } },
      { efforts: { high: 'H' } },
    )
    assert.equal(merged.api, 'anthropic')
    assert.equal(merged.reasoning, 'enabled')
    assert.deepEqual(merged.efforts, { high: 'H' })
  })

  it('leaves efforts undefined when neither side declares any', () => {
    assert.equal(mergeProviderConfig({}, undefined).efforts, undefined)
  })
})

describe('buildProviderOps', () => {
  it('writes the ladder onto a model that declares nothing', () => {
    const ops = buildProviderOps('acme', {}, { api: 'openai-completions', models: [{ id: 'm1' }] })
    assert.deepEqual(ops, [
      { op: 'set', path: ['providers', 'acme', 'models'], value: [{ id: 'm1', reasoningEfforts: LADDER }] },
    ])
  })

  it('overwrites an already-declared ladder by default', () => {
    const profile = { api: 'anthropic', models: [{ id: 'm1', reasoningEfforts: UPSTREAM_LADDER }] }
    const ops = buildProviderOps('acme', {}, profile)
    assert.deepEqual(ops[0]?.value, [{ id: 'm1', reasoningEfforts: LADDER }])
  })

  it('preserves an already-declared ladder when overwrite is false', () => {
    const profile = { api: 'anthropic', models: [{ id: 'm1', reasoningEfforts: UPSTREAM_LADDER }] }
    assert.deepEqual(buildProviderOps('acme', {}, profile, { overwrite: false }), [])
  })

  it('still fills a gap when overwrite is false', () => {
    const profile = { api: 'anthropic', models: [{ id: 'm1' }, { id: 'm2', reasoningEfforts: UPSTREAM_LADDER }] }
    const ops = buildProviderOps('acme', {}, profile, { overwrite: false })
    assert.deepEqual(ops[0]?.value, [{ id: 'm1', reasoningEfforts: LADDER }, { id: 'm2', reasoningEfforts: UPSTREAM_LADDER }])
  })

  it('marks a disabled model with reasoningEfforts false instead of a ladder', () => {
    const profile = { api: 'anthropic', models: [{ id: 'm1' }] }
    const ops = buildProviderOps('acme', { models: { m1: { disabled: true } } }, profile)
    assert.deepEqual(ops[0]?.value, [{ id: 'm1', reasoningEfforts: false }])
  })

  it('leaves an explicitly disabled model that already declares a ladder alone', () => {
    const entry = { id: 'm1', reasoningEfforts: UPSTREAM_LADDER }
    const ops = buildProviderOps('acme', { models: { m1: { disabled: true } } }, { api: 'anthropic', models: [entry] })
    assert.deepEqual(ops, [])
  })

  it('skips every model when the provider itself is disabled', () => {
    assert.deepEqual(buildProviderOps('acme', { disabled: true }, { models: [{ id: 'm1' }] }), [])
  })

  it('passes model-level effort overrides through the merge', () => {
    const profile = { api: 'anthropic', models: [{ id: 'm1' }] }
    const ops = buildProviderOps('acme', { efforts: { max: 'MAX' }, models: { m1: { efforts: { off: 'none' } } } }, profile)
    assert.deepEqual(ops[0]?.value, [
      { id: 'm1', reasoningEfforts: { ...LADDER, off: 'none', max: 'MAX' } },
    ])
  })

  it('only fills provider reasoning when the profile has none', () => {
    assert.deepEqual(buildProviderOps('acme', { reasoning: 'enabled' }, { models: [] }), [
      { op: 'set', path: ['providers', 'acme', 'reasoning'], value: 'enabled' },
    ])
    assert.deepEqual(buildProviderOps('acme', { reasoning: 'enabled' }, { reasoning: 'disabled', models: [] }), [])
  })

  it('does not emit a models op when no model actually changed', () => {
    assert.deepEqual(buildProviderOps('acme', {}, { api: 'anthropic', models: [] }), [])
  })

  it('ignores malformed model entries', () => {
    const profile = { api: 'anthropic', models: [null, 'x', { name: 'no-id' }, { id: 'm1' }] }
    const ops = buildProviderOps('acme', {}, profile)
    assert.deepEqual(ops[0]?.value, [null, 'x', { name: 'no-id' }, { id: 'm1', reasoningEfforts: LADDER }])
  })
})

describe('buildReasoningOps: modelOverrides section', () => {
  const profile = {
    api: 'anthropic',
    models: [{ id: 'm1' }],
    modelOverrides: { m1: { reasoningEfforts: UPSTREAM_LADDER }, m2: {} },
  }

  it('overwrites a declared modelOverride by default', () => {
    const ops = buildProviderOps('acme', {}, profile)
    assert.deepEqual(ops, [
      { op: 'set', path: ['providers', 'acme', 'models'], value: [{ id: 'm1', reasoningEfforts: LADDER }] },
      { op: 'set', path: ['providers', 'acme', 'modelOverrides', 'm1', 'reasoningEfforts'], value: LADDER },
      { op: 'set', path: ['providers', 'acme', 'modelOverrides', 'm2', 'reasoningEfforts'], value: LADDER },
    ])
  })

  it('preserves declared modelOverrides when overwrite is false', () => {
    const ops = buildProviderOps('acme', {}, profile, { overwrite: false })
    assert.deepEqual(ops, [
      { op: 'set', path: ['providers', 'acme', 'models'], value: [{ id: 'm1', reasoningEfforts: LADDER }] },
      { op: 'set', path: ['providers', 'acme', 'modelOverrides', 'm2', 'reasoningEfforts'], value: LADDER },
    ])
  })

  it('skips the whole section when targets.modelOverrides is false', () => {
    const ops = buildProviderOps('acme', {}, profile, { modelOverrides: false })
    assert.deepEqual(ops, [
      { op: 'set', path: ['providers', 'acme', 'models'], value: [{ id: 'm1', reasoningEfforts: LADDER }] },
    ])
  })
})

describe('buildReasoningOps', () => {
  const current = {
    providers: {
      alpha: { api: 'openai-completions', models: [{ id: 'a1' }] },
      beta: { api: 'anthropic', models: [{ id: 'b1' }] },
      broken: 'not-a-record',
    },
  }

  it('covers every provider by default and skips malformed entries', () => {
    const ops = buildReasoningOps(current, {})
    assert.deepEqual(ops.map((op) => op.path.slice(0, 2).join('.')), ['providers.alpha', 'providers.beta'])
  })

  it('returns nothing when the namespace has no providers map', () => {
    assert.deepEqual(buildReasoningOps(undefined, {}), [])
    assert.deepEqual(buildReasoningOps({}, {}), [])
    assert.deepEqual(buildReasoningOps({ providers: [] }, {}), [])
  })

  it('honours auto: false by only touching explicitly listed providers', () => {
    assert.deepEqual(buildReasoningOps(current, { auto: false, providers: { beta: {} } }).length, 1)
    assert.deepEqual(buildReasoningOps(current, { auto: false, providers: {} }), [])
  })

  it('leaves a listed provider untouched when the profile is disabled', () => {
    assert.deepEqual(buildReasoningOps(current, { auto: false, providers: { alpha: { disabled: true } } }), [])
  })
})
