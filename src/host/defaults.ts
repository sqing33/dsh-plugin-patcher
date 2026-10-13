/**
 * The spec a fresh install starts with.
 *
 * An empty patch list is a perfectly valid thing to want, so a plugin that
 * merely wrote its defaults in would take that decision away forever: every
 * reconcile would put them back and no amount of deleting would stick. What
 * separates the two is `initialized`, and the only writer of that flag is
 * the seed below, which runs exactly once per namespace.
 *
 * The patches themselves are the files in examples/. They are the hand-edits
 * this profile actually carries, already written as spec, and they are read
 * rather than inlined for the reason that matters most here: a second copy of
 * a 17KB list of find/replace pairs would drift from the first within a week,
 * and a stale default is worse than no default because it applies an edit that
 * no longer matches anything.
 *
 * One of them also names a file to add rather than a string to replace, and
 * that file lives in patches/ beside this module's own source. The content of
 * injected code belongs in a file an editor can open, under version control,
 * and lint: a 150-line module escaped into a JSON string in a settings text
 * box is unreviewable, and unreviewable is how a patch ends up rewriting the
 * wrong file.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadSpec } from '../spec/resolve.ts'
import type { Patch, PatcherConfig } from '../spec/types.ts'

/**
 * The examples that make up the built-in default, in the order they are
 * written. Order is cosmetic — patches are applied one at a time and each
 * one touches a different package — but a stable order makes a reseeded
 * spec byte-identical to the last one.
 */
export const DEFAULT_EXAMPLE_FILES: readonly string[] = [
  'plan-build-switch-command-arity.json',
  'think-translate-icons-and-seat.json',
  'reasoning-effort-force-effort-tiers.json',
  'subagent-director-background-owner.json',
]

/** Whether this module can still find the package it shipped with. */
export type ExistsFn = (path: string) => boolean

/**
 * Walk up from a module's URL to the directory holding its package.json.
 *
 * The distance from this file to the package root differs between the source
 * tree (src/host/) and the built one (lib/), so the root is *found* rather
 * than computed: the first ancestor with a package.json is it, and that is
 * true from a linked checkout, a pnpm store path and a global install alike.
 *
 * @returns the root, or undefined when there is none (a bundled single file).
 */
export function packageRootFrom(moduleUrl: string, exists: ExistsFn = existsSync): string | undefined {
  let path = moduleUrl
  if (path.startsWith('file://')) {
    try {
      path = decodeURIComponent(path.slice('file://'.length))
    } catch {
      // A malformed escape says nothing about the layout; the scan below
      // still runs on the raw text and either matches or does not.
    }
  }
  if (path.includes('\\') || /^\/[A-Za-z]:/.test(path)) return undefined
  const parts = path.split('/')
  for (let at = parts.length; at > 0; at--) {
    const dir = parts.slice(0, at).join('/')
    if (dir !== '' && exists(join(dir, 'package.json'))) return dir
  }
  return undefined
}

/** Reads one shipped example, or undefined when it cannot be read. */
export type ExampleReader = (name: string) => string | undefined

export interface DefaultsResult {
  patches: Patch[]
  /** One line per example that did not make it in, with the reason. */
  problems: string[]
}

/**
 * Read the shipped examples and flatten them into one patch list.
 *
 * Every file goes through the real loader, so a default that the schema
 * rejects is dropped here with its diagnostic rather than written into the
 * namespace — where it would make the whole spec unloadable and leave the
 * operator with a page full of errors and no way back, since the seed only
 * runs once.
 */
export function loadDefaultPatches(read: ExampleReader = shippedExampleReader(import.meta.url)): DefaultsResult {
  const patches: Patch[] = []
  const problems: string[] = []
  const seen = new Set<string>()
  for (const name of DEFAULT_EXAMPLE_FILES) {
    const text = read(name)
    if (text === undefined) {
      problems.push(name + ' is missing from the installed package')
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      problems.push(name + ' is not valid JSON: ' + (error instanceof Error ? error.message : String(error)))
      continue
    }
    const spec = loadSpec(parsed, new Map())
    if (spec.config === undefined) {
      problems.push(name + ' did not load: ' + (spec.diagnostics[0]?.message ?? 'unknown reason'))
      continue
    }
    for (const patch of spec.config.patches) {
      if (seen.has(patch.id)) {
        problems.push(name + ' repeats the patch id "' + patch.id + '"; the first one wins')
        continue
      }
      seen.add(patch.id)
      patches.push(patch)
    }
  }
  return { patches, problems }
}

/**
 * The default spec, ready to be written into the namespace.
 *
 * `initialized` is set in the same write rather than a moment later, so a
 * crash between the two cannot produce a spec that looks unseeded forever.
 */
export function defaultConfig(patches: readonly Patch[]): PatcherConfig {
  return { patches: [...patches], reconcileNonce: 0, initialized: true }
}

/**
 * Whether the host should seed yet.
 *
 * An undefined config means the spec did not load at all, and overwriting
 * unparseable input would destroy whatever the operator was trying to say —
 * so a broken spec is left exactly as it is, with its diagnostics showing.
 */
export function needsSeed(config: PatcherConfig | undefined): boolean {
  return config !== undefined && config.initialized !== true
}

/** The settings write that installs the default spec. */
export interface SettingsWrite {
  op: 'set'
  path: string[]
  value: unknown
}

export function seedOps(patches: readonly Patch[]): SettingsWrite[] {
  return [
    { op: 'set', path: ['patches'], value: [...patches] },
    { op: 'set', path: ['initialized'], value: true },
  ]
}

/** A reader bound to the examples directory this module was loaded with. */
export function shippedExampleReader(moduleUrl: string, exists: ExistsFn = existsSync): ExampleReader {
  const root = packageRootFrom(moduleUrl, exists)
  const dir = root === undefined ? undefined : join(root, 'examples')
  return (name) => {
    if (dir === undefined) return undefined
    try {
      return readFileSync(join(dir, name), 'utf8')
    } catch {
      return undefined
    }
  }
}