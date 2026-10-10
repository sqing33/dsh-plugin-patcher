/**
 * Settings-side ladder enforcement for DeepSeek Harness.
 *
 * DSH 0.1.7 exposes no per-namespace reader: `SettingsForms` only has
 * describe() / update() / replace() / mutate() / configure(). The namespace is
 * therefore located by scanning describe() for the entry whose `ns` matches,
 * and the descriptor's `value` is what buildReasoningOps() expects.
 *
 * describe() also emits `settings/document-updated` whenever a namespace's
 * stored value changes, so writing here re-enters this module. A single
 * in-flight guard plus a post-write re-sync keeps that from spinning.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SettingsDescriptor, SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { buildReasoningOps, type LadderConfig } from './reasoning-settings.ts'
import { recordError, recordSettingsWrite, setPhase } from './status.ts'

/**
 * A namespace is represented by its validated string at runtime. Keeping the
 * literal here works with both the legacy settingsNamespace() API and DSH
 * 0.1.6+, where that helper is no longer exported.
 */
export const PI_AI_NAMESPACE = 'llm-pi-ai'

export const LOG_PREFIX = '[dsh-plugin-patcher]'
const STARTUP_RETRY_DELAY_MS = 50
const STARTUP_RETRY_LIMIT = 40

/**
 * Locate the live value of one settings namespace.
 *
 * Returns undefined when the namespace is not registered yet. Note that
 * describe() deliberately hides namespaces whose Config declares no volatile
 * field, so a missing entry is ambiguous: it can mean "not loaded yet" or
 * "not patchable". The retry loop below treats it as "not loaded yet" and
 * gives up loudly, which is the safe direction.
 */
export function readNamespace(
  descriptors: readonly SettingsDescriptor[],
  namespace: string,
): SettingsDescriptor | undefined {
  return descriptors.find((descriptor) => descriptor.ns === namespace)
}

/** Returns true once the namespace exists, whether or not anything was written. */
async function syncLadderSettings(ctx: Context, config: LadderConfig): Promise<boolean> {
  const descriptor = readNamespace(ctx.settings.describe(), PI_AI_NAMESPACE)
  if (descriptor === undefined) return false

  const ops: SettingsPathOp[] = buildReasoningOps(descriptor.value, config)
  if (ops.length === 0) return true

  try {
    await ctx.settings.mutate(PI_AI_NAMESPACE, ops)
    recordSettingsWrite(ops.length)
    ctx.logger.info(LOG_PREFIX + ' wrote %d reasoning ladder setting(s)', ops.length)
  } catch (error) {
    ctx.logger.warn(LOG_PREFIX + ' could not update llm-pi-ai settings')
    ctx.logger.warn(recordError(error, 'could not update llm-pi-ai settings'))
  }
  return true
}

export function applyLadderSettings(ctx: Context, config: LadderConfig = {}): void {
  let startupAttempts = 0
  let inFlight = false

  const sync = (): void => {
    // Our own write re-enters us through settings/document-updated; dropping
    // the redundant pass is enough because the write already converged.
    if (inFlight) return
    inFlight = true
    void syncLadderSettings(ctx, config)
      .then((ready) => {
        if (ready) {
          setPhase('ready')
          return
        }
        if (startupAttempts >= STARTUP_RETRY_LIMIT) {
          ctx.logger.warn(
            LOG_PREFIX + ' gave up waiting for the ' + PI_AI_NAMESPACE + ' namespace after '
              + STARTUP_RETRY_LIMIT + ' attempts; no reasoning ladder was written',
          )
          recordError(
            new Error('still undefined after ' + STARTUP_RETRY_LIMIT + ' retries'),
            'gave up waiting for the ' + PI_AI_NAMESPACE + ' namespace',
          )
          setPhase('failed')
          return
        }
        startupAttempts += 1
        setTimeout(sync, STARTUP_RETRY_DELAY_MS)
      })
      .catch((error) => {
        ctx.logger.warn(LOG_PREFIX + ' reasoning ladder sync failed')
        ctx.logger.warn(recordError(error, 'reasoning ladder sync failed'))
        setPhase('failed')
      })
      .finally(() => {
        inFlight = false
      })
  }

  // llm-pi-ai may register its settings namespace later in the composition.
  // Retry briefly so a fresh install does not miss the first sync.
  setTimeout(sync, 0)
  ctx.on('settings/document-updated', (namespace: unknown) => {
    if (namespace === PI_AI_NAMESPACE) sync()
  })
}
