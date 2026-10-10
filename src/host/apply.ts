/**
 * The one button that runs a command.
 *
 * Everything else in this plugin is the host writing, and the host is
 * deliberately unable to write into another package — see
 * src/adapters/package-file.ts for the three reasons. A file patch is
 * therefore applied by scripts/apply-code-patch.mjs in a separate process,
 * with pnpm's own lock, and the operator running it.
 *
 * This route is the only thing that starts that process, and it exists
 * because "the operator ran a command" and "the operator pressed a button
 * that says what it does" are the same authorisation. The click *is* the
 * consent: nothing is spawned until someone asks for it by name, the page
 * shows the exact argv first, and there is no postinstall hook and no
 * background timer that could fire on its own.
 *
 * The security shape is worth stating plainly, because an endpoint that runs
 * a child process is exactly the thing that should make a reviewer stop:
 *
 * - **Same origin only.** A cross-site page cannot add a custom header
 *   without a CORS preflight, and the harness web server does not answer one,
 *   so requiring `x-dsh-plugin-patcher` turns a drive-by POST from any other
 *   site into a request that never gets sent.
 * - **Not a free command line.** The body is a patch id, never an argv. The
 *   process is built from the spec the host already holds, so no request can
 *   name a program, a file or an argument.
 * - **Only a patch that is actually drifted.** A patch that is already
 *   applied, absent, or in conflict is refused before anything is spawned.
 * - **One at a time.** A second request while a patch is running gets 409
 *   rather than a second pnpm fighting the first for the profile lock.
 * - **Bounded.** The body is capped, the output is capped, and the child is
 *   killed on a deadline.
 */

import type { PatcherStatus } from '../adapters/types.ts'
import type { PatcherConfig } from '../spec/types.ts'

/** Path the browser posts to. Same origin as the harness UI, so no CORS. */
export const APPLY_PATH = '/dsh-plugin-patcher/api/apply'

/**
 * Required on every request.
 *
 * Its only job is to be a header a cross-origin caller cannot set without a
 * preflight this server will not answer. The value is a constant because a
 * secret would suggest it carries meaning it does not.
 */
export const APPLY_HEADER = 'x-dsh-plugin-patcher'
export const APPLY_HEADER_VALUE = '1'

/** A patch id and a flag. Anything else in the body is ignored. */
export interface ApplyBody {
  patchId: string
  dryRun: boolean
}

/** Long enough for a cold pnpm on a slow disk, short enough to not hang. */
export const APPLY_TIMEOUT_MS = 300_000
export const MAX_BODY_BYTES = 4096
export const MAX_OUTPUT_CHARS = 60_000

export interface RunOutcome {
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
  truncated: boolean
}

/** How the host starts a child process. Injected so the route stays testable. */
export interface RunPort {
run(script: string, args: readonly string[], options: { cwd?: string; timeoutMs: number }): Promise<RunOutcome>
}

/** Everything the route needs to know, read fresh on every request. */
export interface ApplyEnvironment {
  spec: PatcherConfig | undefined
  statusOf(patchId: string): PatcherStatus | undefined
  /** Absolute path of scripts/apply-code-patch.mjs, or undefined when unresolvable. */
  scriptPath: string | undefined
  profileDir: string | undefined
}

export type ApplyPlan =
  | { ok: false; status: number; error: string }
  | {
      ok: true
      patchId: string
      /** The argv, verbatim, so the page can show it before the click. */
      command: string
      args: string[]
      cwd: string
      dryRun: boolean
    }

/**
 * States a preview may be asked for.
 *
 * `--dry-run` writes nothing, so it is safe and useful in exactly the
 * states where the operator wants to see why: a patch that is partly
 * applied, or one the host could not classify.
 */
const PREVIEWABLE = new Set(['drifted', 'conflict', 'failed'])

/**
 * Decide whether a request may spawn anything, and with which argv.
 *
 * Pure on purpose: the checks that decide whether a child process is safe
 * to start are the ones most worth pinning in a test, and they are the ones
 * that would otherwise only be exercised by a real pnpm run.
 */
export function planApply(body: unknown, env: ApplyEnvironment, node = process.execPath): ApplyPlan {
  if (body === null || typeof body !== 'object') {
    return { ok: false, status: 400, error: 'the body must be a JSON object' }
  }
  const { patchId, dryRun } = body as { patchId?: unknown; dryRun?: unknown }
  if (typeof patchId !== 'string' || patchId.length === 0) {
    return { ok: false, status: 400, error: 'patchId must be a non-empty string' }
  }
  if (dryRun !== undefined && typeof dryRun !== 'boolean') {
    return { ok: false, status: 400, error: 'dryRun must be a boolean' }
  }
  const preview = dryRun === true

  if (env.scriptPath === undefined) {
    return {
      ok: false,
      status: 501,
      error:
        'scripts/apply-code-patch.mjs was not found in the installed package, so this build cannot apply file patches by itself. Run the command by hand instead.',
    }
  }
  if (env.profileDir === undefined) {
    return {
      ok: false,
      status: 501,
      error:
        'the profile directory could not be resolved from where this plugin was loaded, so there is nowhere safe to run pnpm.',
    }
  }

  const patch = env.spec?.patches.find((candidate) => candidate.id === patchId)
  if (patch === undefined) {
    return {
      ok: false,
      status: 404,
      error: 'no patch named "' + patchId + '" is in the spec; it may have been deleted since this page was rendered',
    }
  }
  if (patch.target.kind !== 'package-file' || patch.op.kind !== 'code') {
    return {
      ok: false,
      status: 400,
      error:
        'only a package-file code patch is applied by a command; this one is a ' +
        patch.op.kind +
        ' on a ' +
        patch.target.kind +
', which the host applies itself',
    }
  }
  if (!patch.enabled) {
    return {
      ok: false,
      status: 409,
      error: 'this patch is turned off, so the host would roll it back rather than apply it',
    }
  }

  const status = env.statusOf(patchId)
  if (status === undefined) {
    return {
      ok: false,
      status: 409,
      error: 'this patch has no status yet; the host has not finished its first reconcile',
    }
  }
  if (preview ? !PREVIEWABLE.has(status.state) : status.state !== 'drifted') {
    return {
      ok: false,
      status: 409,
      error:
        'this patch is ' +
        status.state +
        (preview
          ? '; a preview only makes sense for a patch the host could not apply cleanly'
          : '; only a drifted patch is worth running the command for'),
    }
  }

  const args = [
    env.scriptPath,
    '--patch-id',
    patch.id,
    '--pkg',
    patch.target.pkg,
    '--profile-dir',
    env.profileDir,
  ]
  if (preview) args.push('--dry-run')
  else args.push('--install')
  return { ok: true, patchId: patch.id, command: node, args, cwd: env.profileDir, dryRun: preview }
}

interface Reply {
  writeHead(status: number, headers: Record<string, string>): unknown
  end(body?: string): unknown
}

/** The slice of an incoming request this route reads. */
export interface ApplyRequest extends AsyncIterable<unknown> {
  method?: string
  headers?: Record<string, string | string[] | undefined>
}

interface RouteHost {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: ApplyRequest, res: Reply) => void | Promise<void>
  }): () => void
}

export interface ApplyRouteDeps {
  read(): ApplyEnvironment
  run: RunPort
  /** Called after every finished run so the page's state moves on. */
  onDone(): void
  timeoutMs?: number
}

function header(req: ApplyRequest, name: string): string | undefined {
  const raw = req.headers?.[name]
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' ? value : undefined
}

function reply(res: Reply, status: number, body: unknown, extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extra,
  })
  res.end(JSON.stringify(body))
}

/**
 * Read at most `limit` bytes of body, or report that it was too much.
 *
 * The stream is destroyed on overflow rather than drained: this route has
 * no use for the rest of a body it has already refused.
 */
export async function readBody(req: ApplyRequest, limit = MAX_BODY_BYTES): Promise<{ ok: true; text: string } | { ok: false }> {
  const chunks: string[] = []
  let size = 0
  // A Uint8Array does not override toString: String(bytes) joins the byte
  // values with commas, so a body that arrived as one would be read as
  // "123,34,125" and fail the JSON parse for a reason that has nothing to do
  // with JSON. Buffers happen to work today only because Buffer overrides
  // toString, which is a coincidence, not a contract.
  const decoder = new TextDecoder()
  const textOf = (chunk: unknown): string => {
    if (typeof chunk === 'string') return chunk
    if (chunk instanceof Uint8Array) return decoder.decode(chunk, { stream: true })
    return String(chunk)
  }
  try {
    for await (const chunk of req) {
      const text = textOf(chunk)
      size += Buffer.byteLength(text)
      if (size > limit) return { ok: false }
      chunks.push(text)
    }
  } catch {
    return { ok: false }
  }
  return { ok: true, text: chunks.join('') }
}

/**
 * Publish the apply route.
 *
 * A missing web server returns undefined rather than throwing, exactly as the
 * read-only state route does: the rest of the plugin works without a page.
 */
export function registerApplyRoute(ctx: unknown, deps: ApplyRouteDeps): (() => void) | undefined {
  const host = (ctx as { reflect?: { get?(name: string): unknown } } | undefined)?.reflect?.get?.('webServer') as
    | RouteHost
    | undefined
  if (host === undefined || typeof host.register !== 'function') return undefined

  /** The patch id currently being applied, or undefined. One at a time. */
  let inFlight: string | undefined

  return host.register({
    kind: 'exact',
    path: APPLY_PATH,
    async handler(req, res) {
      if (req.method !== 'POST') {
        reply(res, 405, { ok: false, error: 'this endpoint only accepts POST' }, { allow: 'POST' })
        return
      }
      if (header(req, APPLY_HEADER) !== APPLY_HEADER_VALUE) {
        reply(res, 403, {
          ok: false,
          error:
            'the ' + APPLY_HEADER + ' header is required; a cross-origin page cannot set one without a preflight this server does not answer',
        })
        return
      }
      const contentType = header(req, 'content-type') ?? ''
      if (!contentType.toLowerCase().includes('application/json')) {
        reply(res, 415, { ok: false, error: 'the body must be sent as application/json' })
        return
      }
      const body = await readBody(req)
      if (!body.ok) {
        reply(res, 413, { ok: false, error: 'the body was unreadable or larger than ' + MAX_BODY_BYTES + ' bytes' })
        return
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(body.text)
      } catch (error) {
        reply(res, 400, {
          ok: false,
          error: 'the body is not JSON: ' + (error instanceof Error ? error.message : String(error)),
        })
        return
      }

      const plan = planApply(parsed, deps.read())
      if (!plan.ok) {
        reply(res, plan.status, { ok: false, error: plan.error })
        return
      }
      if (inFlight !== undefined) {
        reply(res, 409, {
          ok: false,
          error:
            'already applying "' + inFlight + '"; pnpm holds the profile lock and two at once would fight over it',
        })
        return
      }

      inFlight = plan.patchId
      let outcome: RunOutcome
      try {
        outcome = await deps.run.run(plan.command, plan.args, {
          cwd: plan.cwd,
          timeoutMs: deps.timeoutMs ?? APPLY_TIMEOUT_MS,
        })
      } catch (error) {
        outcome = {
          code: -1,
          stdout: '',
          stderr: 'the command could not be started: ' + (error instanceof Error ? error.message : String(error)),
          timedOut: false,
          truncated: false,
        }
      } finally {
        inFlight = undefined
        deps.onDone()
      }

      reply(res, outcome.timedOut ? 504 : outcome.code === 0 ? 200 : 500, {
        ok: outcome.code === 0 && !outcome.timedOut,
        patchId: plan.patchId,
        dryRun: plan.dryRun,
        code: outcome.code,
        timedOut: outcome.timedOut,
        truncated: outcome.truncated,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
      })
    },
  })
}

/** Trim a child's output to something a browser can hold and a human can read. */
export function capOutput(text: string, limit = MAX_OUTPUT_CHARS): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false }
  // The banner is part of the budget, not an addition to it. Sizing the tail
  // first and prefixing afterwards is how a "cap" ends up handing back more
  // than it promised, which is the one thing a cap is not allowed to do.
  const banner = '... characters dropped ...\n'
  const room = limit - banner.length
  if (room <= 0) return { text: text.slice(text.length - limit), truncated: true }
  // Keep the tail: a failing pnpm says what went wrong last.
  return { text: banner + text.slice(text.length - room), truncated: true }
}