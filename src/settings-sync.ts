/**
 * Settings-side ladder enforcement for DeepSeek Harness.
 *
 * The llm-pi-ai namespace may not exist yet when this plugin is applied, so the
 * first sync retries for a short window instead of assuming readiness.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { buildReasoningOps, type LadderConfig } from './reasoning-settings.ts'
import { recordError, recordSettingsWrite, setPhase } from './status.ts'

/**
 * A namespace is represented by its validated string at runtime. Keeping the
 * literal here works with both the legacy settingsNamespace() API and DSH
 * 0.1.6+, where that helper is no longer exported.
 */
export const PI_AI_NAMESPACE = 'llm-pi-ai'

const LOG_PREFIX = '[dsh-reasoning-ladder]'
const STARTUP_RETRY_DELAY_MS = 50
const STARTUP_RETRY_LIMIT = 40

/** Returns true once the namespace exists, whether or not anything was written. */
async function syncLadderSettings(ctx: Context, config: LadderConfig): Promise<boolean> {
  const current = ctx.settings.get(PI_AI_NAMESPACE)
  if (current === undefined) return false

  const ops: SettingsPathOp[] = buildReasoningOps(current, config)
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

  const sync = (): void => {
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
  }

  // llm-pi-ai may register its settings namespace later in the composition.
  // Retry briefly so a fresh install does not miss the first sync.
  setTimeout(sync, 0)
  ctx.on('settings/updated', (namespace: unknown) => {
    if (namespace === PI_AI_NAMESPACE) sync()
  })
}
