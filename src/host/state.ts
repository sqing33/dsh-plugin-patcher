/**
 * The read-only window onto the host.
 *
 * The client owns the spec — it writes it through the ordinary settings
 * namespace — but it cannot see what the host concluded about it. This is that
 * answer: one GET, no parameters, no side effects. Everything the page renders
 * comes from here, so there is exactly one place where "what the host thinks"
 * is defined.
 *
 * The route is read-only on purpose. A patcher that exposed writes over HTTP
 * would be a second, unaudited control channel next to the settings namespace
 * that already does the job.
 */

import type { PatcherStatus, PatchState } from '../adapters/types.ts'
import type { SpecDiagnostic } from '../spec/resolve.ts'
import type { PatcherConfig } from '../spec/types.ts'

/** Path the browser fetches. Same origin as the harness UI, so no CORS. */
export const STATE_PATH = '/dsh-plugin-patcher/api/state'

export interface PatcherState {
  /** The settings namespace holding the spec; also this plugin's profile row id. */
  namespace: string
  /** Bumped only when a status actually changed, so a client can poll cheaply. */
  version: number
  /** False when the profile is memory-only and writes would be dropped. */
  writable: boolean
  profileDir: string | undefined
  journalPath: string | undefined
  /** The spec as the host resolved it, or undefined when it did not load. */
  spec: PatcherConfig | undefined
  diagnostics: SpecDiagnostic[]
  /** Patch ids the schema rejected; each one still reports its own state. */
  rejected: string[]
  /** Row ids more than one patch claims. */
  contestedRows: string[]
  generators: Array<{ id: string; description: string }>
  statuses: PatcherStatus[]
  tally: Record<PatchState, number>
  /** When the last reconcile finished, or undefined before the first one. */
  reconciledAt: string | undefined
  /** The last host-level failure, when one stopped a whole reconcile. */
  error: string | undefined
}

/**
 * Serialise the state.
 *
 * A payload containing something JSON cannot hold (a BigInt from a settings
 * file, a cycle) must not turn the page into a parse error with no
 * explanation, so the failure is reported *in* the response instead.
 */
export function renderState(state: PatcherState): string {
  try {
    return JSON.stringify({ ...state, ok: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return JSON.stringify({ ok: false, namespace: state.namespace, error: `the state could not be serialised: ${message}` })
  }
}

/** The slice of a node response this route writes to. */
interface Reply {
  writeHead(status: number, headers: Record<string, string>): unknown
  end(body?: string): unknown
}

interface RouteHost {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: { method?: string }, res: Reply) => void | Promise<void>
  }): () => void
}

/**
 * Publish the state route.
 *
 * The web server is optional in some compositions, so its absence returns
 * undefined rather than throwing: the host keeps reconciling and the settings
 * namespace stays writable, the page is simply not there.
 */
export function registerStateRoute(ctx: unknown, read: () => PatcherState): (() => void) | undefined {
  const host = (ctx as { reflect?: { get?(name: string): unknown } } | undefined)?.reflect?.get?.('webServer') as
    | RouteHost
    | undefined
  if (host === undefined || typeof host.register !== 'function') return undefined
  return host.register({
    kind: 'exact',
    path: STATE_PATH,
    async handler(req, res) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: 'GET, HEAD' })
        res.end(JSON.stringify({ ok: false, error: 'this endpoint is read-only' }))
        return
      }
      let body: string
      try {
        body = renderState(read())
      } catch (error) {
        // Reading state must never take the server down; a page that cannot
        // load is better than one that cannot be served at all.
        const message = error instanceof Error ? error.message : String(error)
        body = JSON.stringify({ ok: false, error: `the state could not be read: ${message}` })
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(body)
        return
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(body)
    },
  })
}
