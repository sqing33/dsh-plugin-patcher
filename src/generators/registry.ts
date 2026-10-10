/**
 * The generator registry the engine hands to `loadSpec` and to the settings
 * adapter.
 *
 * Generators are addressed by id from the spec, so the registry is the single
 * place that decides which ids exist. A spec naming anything else is reported
 * as an unknown generator rather than silently expanded to nothing.
 */

import type { Generator, GeneratorRegistry } from '../spec/resolve.ts'
import { reasoningLadderGenerator } from './reasoning-ladder.ts'

export { reasoningLadderGenerator }

/** The generators this plugin ships. */
export const BUILTIN_GENERATORS: readonly Generator[] = [reasoningLadderGenerator]

/**
 * Build the registry. `extra` is last on purpose: a host that wants its own
 * generator can override a builtin id without having to unregister it first,
 * which is the same last-one-wins rule the profile patch file uses for a
 * duplicated row id.
 */
export function createGeneratorRegistry(extra: Iterable<Generator> = []): GeneratorRegistry {
  const registry = new Map<string, Generator>()
  for (const generator of [...BUILTIN_GENERATORS, ...extra]) {
    registry.set(generator.id, generator)
  }
  return registry
}

/** id and description per generator, for the settings page to list. */
export function generatorCatalog(generators: GeneratorRegistry = createGeneratorRegistry()): Array<{
  id: string
  description: string
}> {
  return [...generators.values()]
    .map((generator) => ({ id: generator.id, description: generator.description }))
    .sort((left, right) => left.id.localeCompare(right.id))
}
