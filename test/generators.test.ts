import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { settingsAdapter, type SettingsPort } from '../src/adapters/settings.ts'
import { createGeneratorRegistry, generatorCatalog, BUILTIN_GENERATORS } from '../src/generators/registry.ts'
import { reasoningLadderGenerator } from '../src/generators/reasoning-ladder.ts'
import { buildReasoningOps, type LadderConfig } from '../src/reasoning-settings.ts'
import type { Generator, GeneratorRegistry } from '../src/spec/resolve.ts'
import type { Json } from '../src/spec/types.ts'
import type { Op, Patch, SettingsTarget } from '../src/spec/types.ts'

const LADDER = { off: 'off', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' }

/** A provider profile with a couple of models, the shape llm-pi-ai projects. */
function profile(): Record<string, unknown> {
  return {
    openai: {
      api: 'openai-completions',
      models: [{ id: 'gpt-6-astra' }, { id: 'gpt-5-code', reasoningEfforts: { custom: 'custom' } }],
      modelOverrides: {
        'gpt-6-astra': { reasoningEfforts: { custom: 'custom' } },
        'gpt-5-code': { reasoningEfforts: { custom: 'custom' } },
      },
    },
  }
}

function run(args: Record<string, unknown>, current?: unknown): unknown {
  return reasoningLadderGenerator.generate(args, { current })
}

describe('the generator registry', () => {
  it('ships the ladder', () => {
    assert.deepEqual([...createGeneratorRegistry().keys()], ['reasoning-ladder'])
  })

  it('lets a host add one without touching the builtin list', () => {
    const extra: Generator = { id: 'x', description: 'd', generate: () => 1 }
    assert.ok(createGeneratorRegistry([extra]).has('x'))
    assert.equal(BUILTIN_GENERATORS.length, 1)
  })

  it('lets a host override a builtin id, the way a duplicated row id resolves', () => {
    const override: Generator = { id: 'reasoning-ladder', description: 'mine', generate: () => 'theirs' }
    assert.equal(createGeneratorRegistry([override]).get('reasoning-ladder')?.description, 'mine')
  })

  it('lists the catalog sorted for the settings page', () => {
    const extras: Generator[] = [
      { id: 'zebra', description: 'z', generate: () => 1 },
      { id: 'alpha', description: 'a', generate: () => 1 },
    ]
    assert.deepEqual(
      generatorCatalog(createGeneratorRegistry(extras)).map((entry) => entry.id),
      ['alpha', 'reasoning-ladder', 'zebra'],
    )
  })
  
  it('describes itself', () => {
    assert.match(reasoningLadderGenerator.description, /five-rung/)
  })
})

describe('the reasoning ladder generator', () => {
  it('returns the providers block, not the namespace wrapper', () => {
    const out = run({ config: {} }, profile()) as Record<string, unknown>
    assert.deepEqual(Object.keys(out), ['openai'])
  })

  it('puts the five-rung ladder on every declared model', () => {
    const out = run({ config: {} }, profile()) as Record<string, Record<string, never>>
    const models = out['openai']['models'] as Array<Record<string, unknown>>
    assert.deepEqual(models[0]?.['reasoningEfforts'], LADDER)
    assert.deepEqual(models[1]?.['reasoningEfforts'], LADDER)
  })

  it('covers modelOverrides as well', () => {
    const out = run({ config: {} }, profile()) as Record<string, Record<string, never>>
    const overrides = out['openai']['modelOverrides'] as Record<string, Record<string, unknown>>
    assert.deepEqual(overrides['gpt-6-astra']?.['reasoningEfforts'], LADDER)
    assert.deepEqual(overrides['gpt-5-code']?.['reasoningEfforts'], LADDER)
  })

  it('agrees with the code that used to do this by hand', () => {
    // The generator exists so that code keeps deciding the ladder. If the two
    // ever disagree, the generator is the one that is wrong.
    const providers = profile()
    const config: LadderConfig = {}
    const expected: Json = { providers } as Json
    for (const op of buildReasoningOps({ providers }, config)) {
      const next = { ...(expected as Record<string, unknown>) } as Record<string, unknown>
      let cursor: Record<string, unknown> = next
      for (const segment of op.path.slice(0, -1)) cursor = cursor[segment] as Record<string, unknown>
      cursor[op.path[op.path.length - 1] as string] = op.value
      Object.assign(expected as Record<string, unknown>, next)
    }
    assert.deepEqual(run({ config }, providers), (expected as Record<string, unknown>)['providers'])
  })

  it('prefers the providers it was given over the live value', () => {
    const out = run({ config: {}, providers: { p: { models: [{ id: 'm' }] } } }, profile())
    assert.deepEqual(Object.keys(out as Record<string, unknown>), ['p'])
  })

  it('honours targets.overwrite=false and keeps what is already declared', () => {
    const out = run({ config: { targets: { overwrite: false } } }, profile()) as Record<string, never>
    const models = (out['openai'] as Record<string, never>)['models'] as Array<Record<string, unknown>>
    // overwrite=false is the upstream preserve-guard: a model that declares
    // nothing still gets the ladder, one that already declares something keeps
    // it. Only the operator's own value survives.
    assert.deepEqual(models[0]?.['reasoningEfforts'], LADDER)
    assert.deepEqual(models[1]?.['reasoningEfforts'], { custom: 'custom' })
  })

  it('turns a model off when the ladder says it is disabled', () => {
    const providers = { openai: { models: [{ id: 'm' }] } }
    const out = run({ config: { providers: { openai: { models: { m: { disabled: true } } } } } }, providers) as Record<string, never>
    const models = (out['openai'] as Record<string, never>)['models'] as Array<Record<string, unknown>>
    assert.equal(models[0]?.['reasoningEfforts'], false)
  })

  it('leaves a provider the config does not cover alone', () => {
    const providers = { openai: { models: [{ id: 'a' }] }, other: { models: [{ id: 'b' }] } }
    const out = run({ config: { auto: false, providers: { openai: {} } } }, providers) as Record<string, never>
    assert.deepEqual((out['other'] as Record<string, never>)['models'], [{ id: 'b' }])
  })

  it('returns an empty object for no providers, without complaining', () => {
    assert.deepEqual(run({ config: {} }, {}), {})
  })

  it('refuses to guess when there is no providers block anywhere', () => {
    assert.throws(() => run({ config: {} }), /path \[providers\]/)
  })

  it('rejects a providers argument that is not an object', () => {
    assert.throws(() => run({ config: {}, providers: [1, 2] }), /keyed by provider name/)
    assert.throws(() => run({ config: {}, providers: 'x' }), /keyed by provider name/)
  })

  it('rejects a config that is not an object', () => {
    assert.throws(() => run({ config: 'nope' }, profile()), /ladder settings/)
  })
})

describe('a generator reaching the settings adapter', () => {
  interface Fake extends SettingsPort {
    value: unknown
    writes: unknown[]
  }

  function port(providers: unknown, generators?: GeneratorRegistry): Fake {
    const writes: unknown[] = []
    // describe() hands back the whole namespace projection, and llm-pi-ai keeps
    // the provider map under a root `providers` key, so the namespace is
    // wrapped here. An op at path [providers] then sees exactly what the live
    // generator context is meant to hand it.
    const value = { providers }
    return {
      value,
      writes,
      generators,
      describe: () => [{ ns: 'llm-pi-ai', autoGenerate: true, schema: {}, value, revision: 1, applies: 'live' }],
      mutate: async (_ns, ops) => {
        writes.push(...ops)
      },
    }
  }

  function patch(op: Op): Patch & { target: SettingsTarget } {
    return {
      id: 'ladder',
      enabled: true,
      reason: 'force the ladder',
      target: { kind: 'settings', namespace: 'llm-pi-ai' },
      op,
    }
  }

  const LADDERSET: Op = {
    kind: 'set',
    path: ['providers'],
    value: { $gen: 'reasoning-ladder', args: { config: {} } },
  }

  it('materialises the request and finds itself already applied', () => {
    const already = { openai: { models: [{ id: 'm', reasoningEfforts: LADDER }] } }
    const snapshot = settingsAdapter.read(port(already, createGeneratorRegistry()), patch(LADDERSET))
    assert.equal(snapshot.state, 'in-sync')
  })

  it('calls drifted when the generated value is not what is stored', () => {
    const snapshot = settingsAdapter.read(port({ openai: { models: [{ id: 'm' }] } }, createGeneratorRegistry()), patch(LADDERSET))
    assert.equal(snapshot.state, 'drifted')
  })

  it('writes the generated value, not the request', async () => {
    const fake = port({ openai: { models: [{ id: 'm' }] } }, createGeneratorRegistry())
    const applied = await settingsAdapter.apply(fake, patch(LADDERSET), { state: 'drifted', value: fake.value, detail: '' })
    assert.equal(applied.state, 'in-sync')
    assert.equal(fake.writes.length, 1)
    const written = (fake.writes[0] as { value: unknown }).value as Record<string, Record<string, Array<Record<string, unknown>>>>
    assert.deepEqual(written['openai']?.['models']?.[0]?.['reasoningEfforts'], LADDER)
  })

  it('writes nothing when the generator is not registered', async () => {
    const fake = port({ openai: { models: [{ id: 'm' }] } })
    const snapshot = settingsAdapter.read(fake, patch(LADDERSET))
    assert.equal(snapshot.state, 'failed')
    assert.match(String(snapshot.detail), /unknown generator/)
    assert.equal(fake.writes.length, 0)
  })

  it('writes nothing when the generator throws', async () => {
    const broken: GeneratorRegistry = new Map([
      ['reasoning-ladder', { id: 'reasoning-ladder', description: 'x', generate: () => { throw new Error('nope') } }],
    ])
    const fake = port({ openai: {} }, broken)
    const snapshot = settingsAdapter.read(fake, patch(LADDERSET))
    assert.equal(snapshot.state, 'failed')
    const applied = await settingsAdapter.apply(fake, patch(LADDERSET), { state: 'drifted', value: fake.value, detail: '' })
    assert.equal(applied.state, 'failed')
    assert.equal(fake.writes.length, 0)
  })

  it('leaves a plain value alone even with a registry present', async () => {
    const fake = port({ a: 1 }, createGeneratorRegistry())
    const applied = await settingsAdapter.apply(fake, patch({ kind: 'set', path: ['b'], value: 2 }), { state: 'drifted', value: fake.value, detail: '' })
    assert.equal(applied.state, 'in-sync')
    assert.deepEqual(fake.writes[0], { op: 'set', path: ['b'], value: 2 })
  })

  it('does not let a value that merely has a $gen key be mistaken for a request', () => {
    const fake = port({}, createGeneratorRegistry())
    const snapshot = settingsAdapter.read(fake, patch({ kind: 'set', path: ['doc'], value: { $gen: 7 } }),)
    assert.notEqual(snapshot.state, 'failed')
  })
})
