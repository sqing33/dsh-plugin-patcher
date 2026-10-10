/**
 * The browser's one connection to the host.
 *
 * The page and the plugin detail sections both render the same host state, so
 * the poll lives in a module store instead of a hook per component: one poller,
 * one snapshot object, and a snapshot identity that only changes when the host
 * says something new. A component that re-renders on every poll would burn a
 * frame every two seconds for nothing.
 */

import { useSyncExternalStore } from 'react'
import { STATE_PATH, type PatcherState } from '../host/state.ts'

/** How often to ask. The host bumps its version only when a status changes. */
const POLL_MS = 2500

export interface PatcherSnapshot {
  state: PatcherState | undefined
  /** Why the last read failed, when it did. */
  error: string | undefined
  /** True once the host has answered at least once. */
  ready: boolean
}

interface Wire {
  ok: boolean
  error?: string
}

let snapshot: PatcherSnapshot = { state: undefined, error: undefined, ready: false }
let timer: ReturnType<typeof setTimeout> | undefined
let inFlight = false
let started = false
const listeners = new Set<() => void>()

function publish(next: PatcherSnapshot): void {
  snapshot = next
  for (const listener of listeners) listener()
}

/** A state the host would not change again is not worth re-rendering for. */
function sameAs(previous: PatcherState | undefined, next: PatcherState | undefined): boolean {
  if (previous === undefined || next === undefined) return false
  return previous.version === next.version && previous.reconciledAt === next.reconciledAt
}

function schedule(): void {
  if (timer !== undefined) return
  timer = setTimeout(() => {
    timer = undefined
    void poll()
  }, POLL_MS)
}

async function poll(): Promise<void> {
  if (inFlight) return
  inFlight = true
  try {
    const reply = await fetch(STATE_PATH, { headers: { accept: 'application/json' } })
    const wire = (await reply.json()) as Wire & Partial<PatcherState>
    if (wire.ok !== true || wire.namespace === undefined) {
      publish({
        state: snapshot.state,
        error: wire.error ?? `the state route answered ${reply.status} with something this page cannot read`,
        ready: snapshot.ready,
      })
      return
    }
    const next = wire as PatcherState
    if (sameAs(snapshot.state, next)) return
    publish({ state: next, error: undefined, ready: true })
  } catch (error) {
    publish({
      state: snapshot.state,
      error: error instanceof Error ? error.message : String(error),
      ready: snapshot.ready,
    })
  } finally {
    inFlight = false
    schedule()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (!started) {
    started = true
    void poll()
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size > 0) return
    started = false
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
}

export function usePatcherState(): PatcherSnapshot {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot)
}

/** Ask again now, rather than waiting out the poll interval. */
export function refreshPatcherState(): void {
  if (timer !== undefined) clearTimeout(timer)
  timer = undefined
  void poll()
}

/**
 * The write face of the spec namespace.
 *
 * Structural on purpose: this plugin must not name the settings provider's
 * types, or a rename there turns into a compile error in a file that has no
 * compiler. The two members below are the whole contract it needs.
 */
export interface SpecForm {
  mutate(
    ops: ReadonlyArray<{ op: 'set' | 'unset'; path: readonly string[]; value?: unknown }>,
    revision?: number,
  ): Promise<boolean>
}
