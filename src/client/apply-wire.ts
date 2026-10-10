/**
 * The pure half of the one-click fix: what goes out, and what comes back.
 *
 * Split from the store because a store needs a browser. The body and the reply
 * reader are the two places where a mistake would be invisible — a malformed
 * body is refused with a 400 the page would have to explain, and a reply read
 * wrongly shows an empty box where a diff should be.
 */

export const APPLY_CONTENT_TYPE = 'application/json'

/**
 * The body of an apply request.
 *
 * A patch id and a flag, never a command. The host rebuilds the argv from the
 * spec it already holds, so nothing that arrives over the wire can steer it;
 * this is the other half of that promise, so that a body cannot even be
 * misread as one.
 */
export function applyRequestBody(patchId: string, dryRun: boolean): string {
  return JSON.stringify({ patchId, dryRun })
}

export interface ApplyReply {
  ok: boolean
  error?: string
  patchId?: string
  dryRun?: boolean
  code?: number
  timedOut?: boolean
  truncated?: boolean
  stdout?: string
  stderr?: string
}

/**
 * Read a reply without trusting its shape.
 *
 * A host that is mid-restart answers with a proxy error page, and a page that
 * called `reply.json()` on that would throw where a message is wanted.
 */
export function readApplyReply(text: string, status: number): ApplyReply {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, error: status === 0 ? 'the request never reached the host' : 'the host answered ' + status + ' with something this page cannot read' }
  }
  // An array passes typeof 'object' and would then read as a reply with every
  // field missing, which shows an empty box instead of a message.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'the host answered ' + status + ' with something this page cannot read' }
  }
  const wire = parsed as Record<string, unknown>
  return {
    ok: wire['ok'] === true,
    error: typeof wire['error'] === 'string' ? wire['error'] : undefined,
    patchId: typeof wire['patchId'] === 'string' ? wire['patchId'] : undefined,
    dryRun: wire['dryRun'] === true,
    code: typeof wire['code'] === 'number' ? wire['code'] : undefined,
    timedOut: wire['timedOut'] === true,
    truncated: wire['truncated'] === true,
    stdout: typeof wire['stdout'] === 'string' ? wire['stdout'] : undefined,
    stderr: typeof wire['stderr'] === 'string' ? wire['stderr'] : undefined,
  }
}

/** What a reply is worth showing: the command's own words, or the refusal. */
export function applyOutput(reply: ApplyReply | undefined): string {
  if (reply === undefined) return ''
  if (reply.error !== undefined && reply.error !== '') return reply.error
  const parts: string[] = []
  if (reply.stdout !== undefined && reply.stdout.trim() !== '') parts.push(reply.stdout.trim())
  if (reply.stderr !== undefined && reply.stderr.trim() !== '') parts.push(reply.stderr.trim())
  if (parts.length === 0 && reply.ok) return 'done, and the host said nothing about it'
  return parts.join('\n')
}
