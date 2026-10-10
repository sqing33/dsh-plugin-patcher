/**
 * The browser's half of the one-click fix.
 *
 * The store's whole job is to make one click produce one run, and to keep the
 * last reply next to the patch it belongs to so a diff is never shown under the
 * wrong card. The host enforces the same single-flight rule independently — the
 * page must not be the only thing standing between two clicks and one profile
 * lock.
 */

import { useSyncExternalStore } from 'react'
import { APPLY_HEADER, APPLY_HEADER_VALUE, APPLY_PATH } from '../host/apply.ts'
import { refreshPatcherState } from './usePatcherState.ts'
import { APPLY_CONTENT_TYPE, applyRequestBody, readApplyReply, type ApplyReply } from './apply-wire.ts'

export type { ApplyReply }

export interface ApplySnapshot {
  /** The patch being applied or previewed right now, if any. */
  running: string | undefined
  /** Whether the run in progress is a preview. */
  previewing: boolean
  /** The last reply, successful or not. */
  result: ApplyReply | undefined
  /** The id the last reply belongs to, so a stale diff is not shown elsewhere. */
  patchId: string | undefined
}

const IDLE: ApplySnapshot = { running: undefined, previewing: false, result: undefined, patchId: undefined }

let snapshot: ApplySnapshot = IDLE
const listeners = new Set<() => void>()

function publish(next: ApplySnapshot): void {
  snapshot = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useApply(): ApplySnapshot {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot)
}

/**
 * Run a patch's fix, or show what it would do first.
 *
 * The header is what makes this same-origin: a cross-origin page cannot set it
 * without a preflight, and this server does not answer one. Without it the
 * button would be a command endpoint anyone could make a visitor press.
 */
export async function applyPatch(patchId: string, dryRun: boolean): Promise<ApplyReply> {
  if (snapshot.running !== undefined) {
    return { ok: false, error: 'another fix is still running' }
  }
  publish({ running: patchId, previewing: dryRun, result: undefined, patchId })
  let reply: ApplyReply
  try {
    const response = await fetch(APPLY_PATH, {
      method: 'POST',
      headers: { 'content-type': APPLY_CONTENT_TYPE, [APPLY_HEADER]: APPLY_HEADER_VALUE },
      body: applyRequestBody(patchId, dryRun),
    })
    reply = readApplyReply(await response.text(), response.status)
  } catch (error) {
    reply = { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  publish({ running: undefined, previewing: false, result: reply, patchId })
  // The host reconciles on its own when a run finishes, but the card may have
  // been showing the state from before the command ran; ask rather than wait.
  refreshPatcherState()
  return reply
}
