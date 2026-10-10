/**
 * dsh-plugin-patcher — a declarative patcher for DeepSeek Harness.
 *
 * The patch spec lives in this plugin's own settings namespace, so a client
 * page can drive the host simply by editing that namespace. The bundled
 * reasoning-effort ladder is the first patch shipped with it, and is kept
 * behaviourally identical to the former standalone dsh-reasoning-ladder.
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
export const name = 'dsh-plugin-patcher'
export const inject = ['settings']

export function apply(ctx: Context, config: LadderConfig = {}): void {
  setPhase('patch')
  forcePatchEffortTiers(ctx, config)
  setPhase('settings')
  applyLadderSettings(ctx, config)
}
