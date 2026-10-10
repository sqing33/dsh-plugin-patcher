/**
 * The reasoning ladder, as a generator.
 *
 * This is the one thing the plugin existed to do before it could patch
 * anything, and it is the reason a generator exists at all: the ladder is not
 * a constant, it is a *function* of the provider profiles that are already
 * stored. Every model a provider declares needs a reasoningEfforts block, and
 * which models those are is only known at reconcile time.
 *
 * The ladder itself is not re-implemented here. buildReasoningOps() in
 * reasoning-settings.ts is the tested code that produced these writes before
 * this plugin had a spec, and its output is applied to a copy of the providers
 * object here. The generator is the adapter from ops to value, not a second
 * implementation of the diff.
 */

import { writeAt } from '../engine/fingerprint.ts'
import { buildReasoningOps, type LadderConfig } from '../reasoning-settings.ts'
import type { Generator, GeneratorContext, Json } from '../spec/resolve.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isLadderConfig(value: unknown): value is LadderConfig {
  return value === void 0 || isRecord(value)
}

export const reasoningLadderGenerator: Generator = {
  id: 'reasoning-ladder',
  description:
    'Force the five-rung reasoning ladder onto every model a provider already declares.',

  generate(args: Record<string, unknown>, context?: GeneratorContext): Json {
    const config = args['config']
    if (!isLadderConfig(config)) {
      throw new Error('args.config must be an object of ladder settings')
    }

    // args.providers wins over the live value so the settings page can expand
    // a spec against a snapshot it fetched itself, and so a test can run
    // without a host. The live value is the normal path: a spec that pinned
    // its own copy of the provider list would be pinned to a list that stops
    // being true the moment somebody adds a model.
    const declared = args['providers']
    const live = context?.current
    const providers = declared !== void 0 ? declared : live
    if (!isRecord(providers)) {
      if (declared !== void 0) {
        throw new Error('args.providers must be an object keyed by provider name')
      }
      throw new Error(
        'nothing to work from: put the op at path [providers] so the live value is',
        + 'available, or pass the providers block as an argument',
      )
    }

    const ops = buildReasoningOps({ providers }, config)
    let next: Json = { providers } as Json
    for (const op of ops) {
      next = writeAt(next, op.path, op.value as Json)
    }
    return (next as Record<string, unknown>)['providers'] as Json
  }
}
