import type { PatchState, PatcherStatus } from '../adapters/types.ts'

/**
 * The published view of every patch, plus a monotonically increasing version.
 *
 * The settings page and the read-only HTTP route both read this, so the store
 * owns two rules the engine would otherwise repeat: a reconcile *replaces* the
 * whole set rather than merging into it (a patch deleted from the spec must
 * disappear from the page, not linger forever), and the version only moves when
 * something a client can see actually changed.
 */
export class StatusStore {
  private readonly byPatch = new Map<string, PatcherStatus>()
  private revision = 0

  /** The value clients send back to detect that they are looking at a stale page. */
  get version(): number {
    return this.revision
  }

  /**
   * Publish a completed reconcile. Prunes ids the spec no longer contains and
   * bumps the version only on a real change, so a no-op reconcile does not
   * make every connected client refetch.
   */
  replace(statuses: readonly PatcherStatus[]): number {
    const next = new Map(statuses.map((status) => [status.patchId, status]))
    let changed = next.size !== this.byPatch.size
    if (!changed) {
      for (const [id, status] of next) {
        const current = this.byPatch.get(id)
        if (!current || current.state !== status.state || current.detail !== status.detail) {
          changed = true
          break
        }
      }
    }
    this.byPatch.clear()
    for (const [id, status] of next) this.byPatch.set(id, status)
    if (changed) this.revision += 1
    return this.revision
  }

  list(): PatcherStatus[] {
    return [...this.byPatch.values()]
  }

  get(patchId: string): PatcherStatus | undefined {
    return this.byPatch.get(patchId)
  }

  /** How many patches are in each state, for the summary row on the page. */
  tally(): Record<PatchState, number> {
    const counts: Record<PatchState, number> = {
      'in-sync': 0,
      drifted: 0,
      conflict: 0,
      unsupported: 0,
      absent: 0,
      failed: 0,
      pending: 0,
    }
    for (const status of this.byPatch.values()) counts[status.state] += 1
    return counts
  }
}
