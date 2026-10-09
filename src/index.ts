/**
 * dsh-reasoning-ladder — a reasoning-effort ladder for DeepSeek Harness.
 *
 * This plugin exists so the effort ladder can live outside the plugin that
 * renders the selector. Install upstream dsh-reasoning-effort for the client
 * UI (configure it with auto: false so it never writes settings) and install
 * this plugin as the single writer of the llm-pi-ai settings namespace and of
 * the profile's cordis.patch.yml.
 *
 * The ladder itself is off / medium / high / xhigh / max: a five-rung ladder
 * whose bottom rung is 'off' rather than 'low'.
 */

import type { Context } from '@deepseek-ai/cordis'
import { forcePatchEffortTiers } from './patch-rewrite.ts'
import { ladderConfigSchema } from './schema.ts'
import { applyLadderSettings } from './settings-sync.ts'
import { setPhase } from './status.ts'
import type { LadderConfig } from './reasoning-settings.ts'

export { getStatus, type LadderStatus } from './status.ts'
export type { LadderConfig, LadderTargets } from './reasoning-settings.ts'

export const Config = ladderConfigSchema
export const name = 'reasoning-ladder'
export const inject = ['settings']

export function apply(ctx: Context, config: LadderConfig = {}): void {
  setPhase('patch')
  forcePatchEffortTiers(ctx, config)
  setPhase('settings')
  applyLadderSettings(ctx, config)
}
