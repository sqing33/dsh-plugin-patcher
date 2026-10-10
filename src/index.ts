/**
 * dsh-plugin-patcher — a declarative patcher for DeepSeek Harness.
 *
 * One spec, kept in this plugin's own settings namespace, declares every
 * rewrite this plugin performs: a value inside another plugin's settings
 * namespace, a row in the profile patch file, or an edit inside another
 * package's installed source. The host reads that spec, compares it against
 * the world, writes only the difference, and reports what it concluded.
 *
 * The spec is the only control channel. The client edits it through the
 * ordinary settings namespace, the host watches that namespace, and a
 * reconcileNonce bump re-applies everything on demand. Nothing is written
 * behind the operator's back: a target is touched only while a patch naming
 * it is enabled, every write is bracketed by a journal entry holding the
 * previous value, and turning a patch off rolls that value back.
 *
 * The reasoning-effort ladder this plugin grew out of ships as a generator:
 * the spec asks for it, the settings layer materialises it against whatever
 * provider profiles exist right now.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { packageFileAdapter, type PackageFilePort } from './adapters/package-file.ts'
import { listPatchRows, patchRowAdapter, patchRowFilePort, type PatchRowSummary } from './adapters/patch-row.ts'
import { settingsAdapter, type SettingsPort } from './adapters/settings.ts'
import type { Adapter, PatcherStatus } from './adapters/types.ts'
import { registerApplyRoute, type ApplyEnvironment } from './host/apply.ts'
import { loadDefaultPatches, needsSeed, packageRootFrom, seedOps } from './host/defaults.ts'
import { nodeRunPort } from './host/spawn.ts'
import { Journal } from './engine/journal.ts'
import { reconcile, type EngineAdapter, type EngineAdapters } from './engine/reconcile.ts'
import { StatusStore } from './engine/status.ts'
import { createGeneratorRegistry, generatorCatalog } from './generators/registry.ts'
import { journalPathOf, patchPathOf, profileDirFrom } from './host/profile.ts'
import { registerStateRoute, type PatcherState } from './host/state.ts'
import { loadSpec, type ResolvedSpec } from './spec/resolve.ts'
import { patcherConfigSchema } from './spec/schema.ts'
import type { Patch, PatcherConfig, Target } from './spec/types.ts'

export { STATE_PATH, renderState, registerStateRoute, type PatcherState } from './host/state.ts'
export { APPLY_PATH, planApply, registerApplyRoute, type RunPort } from './host/apply.ts'
export { DEFAULT_EXAMPLE_FILES, defaultConfig, loadDefaultPatches, needsSeed } from './host/defaults.ts'
export { journalPathOf, patchPathOf, profileDirFrom } from './host/profile.ts'
export { createGeneratorRegistry, generatorCatalog, BUILTIN_GENERATORS } from './generators/registry.ts'
export { reasoningLadderGenerator } from './generators/reasoning-ladder.ts'
export { loadSpec, type ResolvedSpec, type Generator, type SpecDiagnostic } from './spec/resolve.ts'
export { patcherConfigSchema } from './spec/schema.ts'
export type {
  CodeEdit,
  Op,
  PatcherConfig,
  PackageFileTarget,
  Patch,
  PatchRowTarget,
  SettingsTarget,
  Target,
  Value,
} from './spec/types.ts'
export type { LadderConfig, LadderTargets } from './reasoning-settings.ts'

/** The row id in the profile patch file, and the settings namespace. One name. */
export const name = 'dsh-plugin-patcher'
export const namespace = name
export const Config = patcherConfigSchema
export const inject = ['settings']

/**
 * Settle time before a reconcile runs.
 *
 * describe() emits settings/document-updated for the namespace it just
 * described, so a reconcile triggered by that event would otherwise schedule
 * itself forever. Waiting a beat lets one settings write settle before the
 * walk, and collapses a burst of writes into a single pass.
 */
const DEBOUNCE_MS = 50

/**
 * Fibers that already own a reconcile loop.
 *
 * A settings write re-resolves this fiber's config, which can re-enter
 * apply() on the same fiber. One loop per fiber, please.
 */
const running = new WeakSet<object>()

/** Services are optional in some compositions; a missing one disables a feature. */
function service<T>(ctx: unknown, serviceName: string): T | undefined {
  const reflect = (ctx as { reflect?: { get?(name: string): unknown } } | undefined)?.reflect
  return (typeof reflect?.get === 'function' ? reflect.get(serviceName) : undefined) as T | undefined
}

/** The engine only ever hands a port back to the adapter that owns it. */
function bind<A>(adapter: Adapter<A, Target>): EngineAdapter {
  return adapter as unknown as EngineAdapter
}

interface Manager {
  listBundles(): Promise<Array<{ name: string; version?: string }>>
  setPluginEnabled(id: string, enabled: boolean): Promise<unknown>
}

export function apply(ctx: Context, _config: PatcherConfig = {}): void {
  const fiber = ctx as unknown as object
  if (running.has(fiber)) return
  running.add(fiber)

  const profileDir = profileDirFrom(import.meta.url)
  const packageRoot = packageRootFrom(import.meta.url)
  const manager = service<Manager>(ctx, 'pluginManager')
  const configEditor = service<{ documentPath?: string }>(ctx, 'configEditor')
  const generators = createGeneratorRegistry()
  const statuses = new StatusStore()
  const journalPath = journalPathOf(profileDir)
  const journal = new Journal(journalPath ?? join(profileDir ?? '/', 'plugin-patcher', 'journal.jsonl'))
  const warn = (message: string, ...rest: unknown[]): void => {
    const logger = (ctx as { logger?: { warn?(m: string, ...r: unknown[]): void } }).logger
    if (typeof logger?.warn === 'function') logger.warn(message, ...rest)
  }

  let spec: ResolvedSpec = loadSpec(undefined, generators)
  let reconciledAt: string | undefined
  let failure: string | undefined
  // Kept apart from `failure` on purpose. A failed reconcile clears itself on the
  // next good pass, but a seed that never landed is a standing condition — the
  // profile still has no defaults, and the next reconcile will not fix that.
  let seedFailure: string | undefined
  let versions: Map<string, string> | undefined
  let bundles: Array<{ pkg: string; version: string | undefined }> = []
  let inventoryRows: PatchRowSummary[] = []
  /**
   * The one writer of an installed package's files, and the button that
   * starts it. Both are paths into this very package; neither is a guess —
   * a missing file simply means the page offers the command by hand.
   */
  const scriptPath = packageRoot === undefined ? undefined : join(packageRoot, 'scripts', 'apply-code-patch.mjs')
  const scriptPresent = scriptPath !== undefined && existsSync(scriptPath)
  /** The patches a fresh install starts with, and anything wrong with them. */
  const defaults = loadDefaultPatches()
  let timer: ReturnType<typeof setTimeout> | undefined
  let busy = false
  let again = false

  const settingsPort: SettingsPort = {
    describe: () => ctx.settings.describe(),
    mutate: (ns, ops, revision) => ctx.settings.mutate(ns, ops, revision),
    generators,
  }

  /** One row's enablement, through the plugin manager's own locking API. */
  const setRowEnabled = (rowId: string, enabled: boolean): Promise<void> =>
    Promise.resolve(manager?.setPluginEnabled(rowId, enabled)).then(() => undefined)

  /**
   * Write the built-in defaults into this plugin's own namespace.
   *
   * Through `settings.mutate` rather than the file directly, because that is
   * the one path that holds the profile lock, validates the paths against the
   * schema, and emits the event that schedules the next reconcile. A write
   * that quietly did nothing — a memory-only profile, a non-loopback page —
   * is reported instead of being mistaken for a successful seed.
   */
  async function seed(patches: readonly Patch[]): Promise<void> {
    seedFailure = undefined
    if (ctx.settings.writable === false) {
      seedFailure =
        'this profile keeps settings in memory, so there is nowhere to write the built-in ' +
        'defaults. The namespace is untouched; add a patch by hand to bind one.'
      return
    }
    try {
      await ctx.settings.mutate(namespace, seedOps(patches))
    } catch (error) {
      seedFailure =
        'the built-in defaults could not be written: ' +
        (error instanceof Error ? error.message : String(error)) +
        '. Nothing was changed.'
      return
    }
    // `mutate` resolves void, and a write that was dropped resolves the same
    // way as one that landed — so read the namespace back and believe that
    // instead. Silently re-seeding every reconcile because a write vanished
    // would be worse than not seeding at all.
    const after = loadSpec(ctx.settings.describe().find((d) => d.ns === namespace)?.value, generators)
    if (after.config?.initialized !== true) {
      seedFailure =
        'the built-in defaults were accepted but did not survive the write; the namespace is ' +
        'still uninitialised. Nothing else will be written until that is understood.'
    }
  }

  const patchPath = configEditor?.documentPath ?? patchPathOf(profileDir)
  const rowPort = patchPath === undefined ? undefined : patchRowFilePort(patchPath, setRowEnabled)
  /** A missing or unreadable patch file is an empty inventory, not a failed reconcile. */
  const readRows = (): string => {
    if (patchPath === undefined) return ''
    try {
      return readFileSync(patchPath, 'utf8')
    } catch {
      return ''
    }
  }

  /**
   * Read a file inside an installed package.
   *
   * The spec's path pattern rejects absolute paths and .., but a spec is
   * untrusted input, so the resolved path is re-checked against the package
   * root here: a capability that can be aimed outside its own package is not
   * a capability worth having.
   */
  const filePort: PackageFilePort = {
    version(pkg) {
      return versions?.get(pkg)
    },
    locate(pkg, path) {
      if (profileDir === undefined) return undefined
      const root = join(profileDir, 'node_modules', pkg)
      const file = join(root, path)
      if (file !== root && !file.startsWith(root + sep)) return undefined
      return existsSync(file) ? file : undefined
    },
    readFile(file) {
      return readFileSync(file, 'utf8')
    },
    readSource(ref) {
      // A code patch that adds a file gets its content from this package, not
      // from the spec. The reference is resolved against our own root and the
      // result is re-checked against it, for the same reason locate re-checks:
      // the spec chooses the reference, so the spec does not get to choose where
      // it lands.
      const root = packageRoot
      if (root === undefined) {
        throw new Error('the patcher package root could not be found, so there is nowhere to read "' + ref + '" from')
      }
      const file = join(root, ref)
      if (file !== root && !file.startsWith(root + sep)) {
        throw new Error('the source reference "' + ref + '" resolves outside the patcher package')
      }
      return readFileSync(file, 'utf8')
    },
  }

  function adapters(): EngineAdapters {
    const bindings: EngineAdapters = { settings: { adapter: bind(settingsAdapter), port: settingsPort } }
    if (rowPort !== undefined) bindings['patch-row'] = { adapter: bind(patchRowAdapter), port: rowPort }
    // Without the bundle list there is no way to tell an absent package from a
    // package whose version the spec simply got wrong, so the whole kind is
    // withheld and the engine reports every file target as unsupported.
    if (versions !== undefined) bindings['package-file'] = { adapter: bind(packageFileAdapter), port: filePort }
    return bindings
  }

  async function once(): Promise<void> {
    try {
      if (manager !== undefined) {
        const listed = await manager.listBundles()
        bundles = listed
          .map((bundle) => ({ pkg: bundle.name, version: bundle.version }))
          .sort((a, b) => (a.pkg < b.pkg ? -1 : 1))
        versions = new Map(listed.map((bundle) => [bundle.name, bundle.version ?? '']))
      } else {
        versions = undefined
      }
      const raw = ctx.settings.describe().find((descriptor) => descriptor.ns === namespace)?.value
      const before = loadSpec(raw, generators)
      spec = before
      // Seed once, on the first reconcile of a namespace nobody has written
      // to. The flag is written in the same call as the patches, so a crash
      // between the two cannot leave a spec that looks unseeded forever.
      if (needsSeed(before.config)) {
        if (defaults.patches.length > 0) {
          await seed(defaults.patches)
          // The write lands in cordis.patch.yml, and so does everything else
          // the settings namespace holds, which is where the apply command
          // reads the spec from. Carry the result forward so this pass already
          // reconciles it instead of waiting for the event to come back.
          spec = loadSpec(ctx.settings.describe().find((d) => d.ns === namespace)?.value, generators)
        } else {
          seedFailure =
            'there is nothing to seed: ' +
            (defaults.problems[0] ?? 'the shipped examples were all empty') +
            '. The namespace stays as it is rather than being marked initialised with no patches in it.'
        }
      }
      const done = await reconcile({
        spec,
        adapters: adapters(),
        journal,
        onStatus: (status) => {
          const merged = statuses.list().filter((known) => known.patchId !== status.patchId)
          statuses.replace([...merged, status])
        },
      })
      statuses.replace(done)
      inventoryRows = rowPort === undefined ? [] : listPatchRows(readRows())
      reconciledAt = new Date().toISOString()
      failure = undefined
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
      warn('dsh-plugin-patcher: a reconcile did not finish: %s', failure)
    }
  }

  async function tick(): Promise<void> {
    if (busy) {
      again = true
      return
    }
    busy = true
    try {
      await once()
    } finally {
      busy = false
    }
    if (again) {
      again = false
      schedule()
    }
  }

  function schedule(): void {
    if (timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      void tick()
    }, DEBOUNCE_MS)
  }

  function state(): PatcherState {
    return {
      namespace,
      version: statuses.version,
      writable: ctx.settings.writable !== false,
      profileDir,
      journalPath,
      spec: spec.config,
      diagnostics: [...spec.diagnostics],
      rejected: [...spec.rejected],
      contestedRows: [...spec.contestedRows],
      generators: generatorCatalog(generators),
      defaults: defaults.patches,
      defaultProblems: defaults.problems,
      inventory: {
        settings: ctx.settings.describe().map((descriptor) => descriptor.ns).sort(),
        rows: inventoryRows,
        bundles,
      },
      statuses: [...statuses.list()],
      tally: statuses.tally(),
      reconciledAt,
      // A reconcile error is the more immediate of the two, but a standing seed
    // failure must never be the one that gets dropped.
    error: failure ?? seedFailure,
    }
  }

  // The spec namespace carries a hand-written page, not a generated one.
  try {
    ctx.settings.configure({ auto: false })
  } catch (error) {
    warn('dsh-plugin-patcher: could not claim the settings page policy: %s', error)
  }

  ctx.on('settings/document-updated', (changed: string) => {
    if (changed === namespace) schedule()
  })

  const dispose = registerStateRoute(ctx, state)
  if (dispose === undefined) {
    warn('dsh-plugin-patcher: no web server here, so there is no state route; the settings namespace still works')
  } else {
    ctx.on('dispose', dispose)
  }

  /**
   * The button that runs a command, wired to the page's own state.
   *
   * Read fresh on every request rather than captured: a reconcile that lands
   * between the click and the check has to decide, and only the host knows.
   */
  const applyEnvironment = (): ApplyEnvironment => ({
    spec: spec.config,
    statusOf: (patchId) => statuses.get(patchId),
    scriptPath: scriptPresent ? scriptPath : undefined,
    profileDir,
  })
  const disposeApply = registerApplyRoute(ctx, {
    read: applyEnvironment,
    run: nodeRunPort,
    onDone: schedule,
  })
  if (disposeApply !== undefined) {
    ctx.on('dispose', disposeApply)
  }

  schedule()
}
