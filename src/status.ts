/**
 * Observable state for the ladder plugin.
 *
 * Everything this plugin does is fire-and-forget: it runs once at startup and
 * then reacts to settings updates. Without a status surface a failed write is
 * indistinguishable from a plugin that simply had nothing to do, so every
 * failure is recorded here as well as logged.
 */

export type LadderPhase = 'pending' | 'patch' | 'settings' | 'ready' | 'failed'

export interface LadderStatus {
  phase: LadderPhase
  lastError: string | null
  patchFile: string | null
  patchBackupFile: string | null
  patchModelsRewritten: number
  settingsOpsWritten: number
}

const status: LadderStatus = {
  phase: 'pending',
  lastError: null,
  patchFile: null,
  patchBackupFile: null,
  patchModelsRewritten: 0,
  settingsOpsWritten: 0,
}

export function getStatus(): Readonly<LadderStatus> {
  return status
}

export function setPhase(phase: LadderPhase): void {
  status.phase = phase
}

export function recordPatchWrite(patchFile: string, backupFile: string, models: number): void {
  status.patchFile = patchFile
  status.patchBackupFile = backupFile
  status.patchModelsRewritten = models
}

export function recordSettingsWrite(ops: number): void {
  status.settingsOpsWritten = ops
}

/** Record a failure and return the formatted message, for logging. */
export function recordError(error: unknown, message: string): string {
  const detail = error instanceof Error ? error.message : String(error)
  status.lastError = message + ': ' + detail
  return status.lastError
}
