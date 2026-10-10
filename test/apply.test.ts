/**
 * The one write path: the button that actually starts a child process.
 *
 * Everything here is fake. There is no spawn, no pnpm and no real HTTP — the
 * point of the file is that the decisions which decide *whether* a process may
 * start (is the body an argv? is the header there? is the patch drifted? is
 * something already running?) are pure enough to pin without one. src/host/
 * spawn.ts owns the actual child; this file owns the refusal to start it.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  APPLY_HEADER,
  APPLY_HEADER_VALUE,
  APPLY_PATH,
  APPLY_TIMEOUT_MS,
  MAX_BODY_BYTES,
  MAX_OUTPUT_CHARS,
  capOutput,
  planApply,
  readBody,
  registerApplyRoute,
  type ApplyEnvironment,
  type RunOutcome,
  type RunPort,
} from '../src/host/apply.ts'
import type { PatcherStatus } from '../src/adapters/types.ts'
import type { Patch, PatcherConfig } from '../src/spec/types.ts'

/* ---------------------------------------------------------------- fixtures */

const SCRIPT = '/profile/node_modules/dsh-plugin-patcher/scripts/apply-code-patch.mjs'
const PROFILE = '/profile'

function codePatch(overrides: Partial<Patch> = {}): Patch {
  return {
    id: 'demo-code',
    enabled: true,
    reason: 'the shipped bundle still lacks the guard',
    target: { kind: 'package-file', pkg: 'demo-pkg', version: '1.0.0', path: 'index.js' },
    op: { kind: 'code', edits: [{ find: 'const label = 1', replace: 'const label = 2', count: 1 }] },
    ...overrides,
  }
}

function spec(patches: Patch[]): PatcherConfig {
  return { patches, reconcileNonce: 0, initialized: true }
}

function status(state: PatcherStatus['state']): PatcherStatus {
  return {
    patchId: 'demo-code',
    state,
    kind: 'package-file',
    targetLabel: 'demo-pkg@1.0.0/index.js',
    reason: 'the shipped bundle still lacks the guard',
    detail: '',
    enabled: true,
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

/** A ready-to-use environment; each test overrides only the field it is about. */
function env(overrides: Partial<ApplyEnvironment> = {}): ApplyEnvironment {
  return {
    spec: spec([codePatch()]),
    statusOf: () => status('drifted'),
    scriptPath: SCRIPT,
    profileDir: PROFILE,
    ...overrides,
  }
}

/* ------------------------------------------------------------- planApply */

describe('planApply: what the body is allowed to be', () => {
  it('rejects a body that is not an object at all', () => {
    const plan = planApply('patchId=demo-code', env())
    assert.equal(plan.ok, false)
    assert.equal(plan.ok === false && plan.status, 400)
  })

  it('rejects null, which typeof reports as an object', () => {
    const plan = planApply(null, env())
    assert.equal(plan.ok === false && plan.status, 400)
  })

  it('rejects an array, even one that happens to be the right length', () => {
    // Destructuring an array by property name yields undefined, so this is
    // caught by the patchId check; the point is that it never reaches argv.
    const plan = planApply(['demo-code'], env())
    assert.equal(plan.ok === false && plan.status, 400)
  })

  it('rejects a missing patchId', () => {
    const plan = planApply({}, env())
    assert.equal(plan.ok === false && plan.status, 400)
    assert.match(plan.ok === false ? plan.error : '', /patchId/)
  })

  it('rejects a non-string patchId rather than coercing it', () => {
    const plan = planApply({ patchId: 42 }, env())
    assert.equal(plan.ok === false && plan.status, 400)
  })

  it('rejects the empty string, which would otherwise be a real lookup', () => {
    const plan = planApply({ patchId: '' }, env())
    assert.equal(plan.ok === false && plan.status, 400)
  })

  it('rejects a dryRun that is present but not a boolean', () => {
    // "dryRun: \"false\"" is the sort of thing a hand-written curl sends, and
    // silently reading it as true would preview when the operator meant to run.
    const plan = planApply({ patchId: 'demo-code', dryRun: 'false' }, env())
    assert.equal(plan.ok === false && plan.status, 400)
    assert.match(plan.ok === false ? plan.error : '', /dryRun/)
  })

  it('ignores a dryRun of false, which is just the default', () => {
    const plan = planApply({ patchId: 'demo-code', dryRun: false }, env())
    assert.equal(plan.ok, true)
  })
})

describe('planApply: the build cannot run a command at all', () => {
  it('says 501, not 404, when the script is missing from the install', () => {
    // 404 would mean "you asked for a patch that does not exist", which sends
    // the operator looking in the settings page for a problem that is in the
    // packaging. 501 says the button is simply inert in this build.
    const plan = planApply({ patchId: 'demo-code' }, env({ scriptPath: undefined }))
    assert.equal(plan.ok === false && plan.status, 501)
  })

  it('says 501 when the profile directory could not be resolved', () => {
    const plan = planApply({ patchId: 'demo-code' }, env({ profileDir: undefined }))
    assert.equal(plan.ok === false && plan.status, 501)
    assert.match(plan.ok === false ? plan.error : '', /profile/)
  })
})

describe('planApply: the patch must be the one the host already holds', () => {
  it('is 404 for an id that is not in the spec', () => {
    const plan = planApply({ patchId: 'ghost' }, env())
    assert.equal(plan.ok === false && plan.status, 404)
  })

  it('names the requested id in the 404, so the stale page is diagnosable', () => {
    // The realistic cause is a page left open across a spec edit; the operator
    // needs to know *which* id the page asked for to find the renamed patch.
    const plan = planApply({ patchId: 'ghost' }, env())
    assert.match(plan.ok === false ? plan.error : '', /ghost/)
  })

  it('is 404 when there is no spec at all', () => {
    const plan = planApply({ patchId: 'demo-code' }, env({ spec: undefined }))
    assert.equal(plan.ok === false && plan.status, 404)
  })

  it('refuses a target the host writes itself', () => {
    const plan = planApply(
      { patchId: 'effort' },
      env({
        spec: spec([
          codePatch({
            id: 'effort',
            target: { kind: 'settings', namespace: 'llm-pi-ai' },
            op: { kind: 'set', path: ['x'], value: 1 },
          }),
        ]),
      }),
    )
    assert.equal(plan.ok === false && plan.status, 400)
  })

  it('refuses a package-file patch whose op is not a code edit', () => {
    const plan = planApply(
      { patchId: 'demo-code' },
      env({
        spec: spec([
          codePatch({ op: { kind: 'set', path: ['a'], value: 1 } }),
        ]),
      }),
    )
    assert.equal(plan.ok === false && plan.status, 400)
  })

  it('refuses a patch that is turned off', () => {
    // An enabled:false patch means the host would roll it back, so running the
    // apply command would move the tree in the opposite direction to the spec.
    const plan = planApply(
      { patchId: 'demo-code' },
      env({ spec: spec([codePatch({ enabled: false })]) }),
    )
    assert.equal(plan.ok === false && plan.status, 409)
  })
})

describe('planApply: only a patch in the right state is worth a process', () => {
  it('refuses when the host has not produced a status yet', () => {
    const plan = planApply({ patchId: 'demo-code' }, env({ statusOf: () => undefined }))
    assert.equal(plan.ok === false && plan.status, 409)
  })

  it('refuses a real run on an in-sync patch', () => {
    const plan = planApply({ patchId: 'demo-code' }, env({ statusOf: () => status('in-sync') }))
    assert.equal(plan.ok === false && plan.status, 409)
  })

  it('refuses a real run on a patch in conflict', () => {
    const plan = planApply({ patchId: 'demo-code' }, env({ statusOf: () => status('conflict') }))
    assert.equal(plan.ok === false && plan.status, 409)
  })

  it('refuses a real run on a patch whose target is absent', () => {
    const plan = planApply({ patchId: 'demo-code' }, env({ statusOf: () => status('absent') }))
    assert.equal(plan.ok === false && plan.status, 409)
  })

  it('refuses a real run on a patch the host could not classify', () => {
    const plan = planApply({ patchId: 'demo-code' }, env({ statusOf: () => status('unsupported') }))
    assert.equal(plan.ok === false && plan.status, 409)
  })

  it('refuses a real run on a patch that already failed', () => {
    // 'failed' is previewable but not runnable: re-running the same command
    // over a patch that just failed is how an operator loses an afternoon.
    const plan = planApply({ patchId: 'demo-code' }, env({ statusOf: () => status('failed') }))
    assert.equal(plan.ok === false && plan.status, 409)
  })

  it('accepts a real run on a drifted patch', () => {
    const plan = planApply({ patchId: 'demo-code' }, env())
    assert.equal(plan.ok, true)
  })
})

describe('planApply: a preview is allowed in the states worth explaining', () => {
  for (const state of ['drifted', 'conflict', 'failed'] as const) {
    it('previews a ' + state + ' patch', () => {
      // --dry-run writes nothing, so it is safe to run in exactly the states
      // where the operator wants to know *why* before spending a real install.
      const plan = planApply({ patchId: 'demo-code', dryRun: true }, env({ statusOf: () => status(state) }))
      assert.equal(plan.ok, true)
    })
  }

  it('still refuses to preview a patch that is already in sync', () => {
    const plan = planApply(
      { patchId: 'demo-code', dryRun: true },
      env({ statusOf: () => status('in-sync') }),
    )
    assert.equal(plan.ok === false && plan.status, 409)
  })

  it('refuses to preview a patch whose target is absent', () => {
    const plan = planApply(
      { patchId: 'demo-code', dryRun: true },
      env({ statusOf: () => status('absent') }),
    )
    assert.equal(plan.ok === false && plan.status, 409)
  })
})

describe('planApply: the argv it builds', () => {
  it('is exactly the script and its three flags, in that order', () => {
    // The order is pinned because the settings page renders this array as the
    // consent prompt; a reordering that only touched this test would still
    // change what the operator is shown they are about to run.
    const plan = planApply({ patchId: 'demo-code' }, env(), '/usr/bin/node')
    assert.equal(plan.ok, true)
    if (!plan.ok) return
    assert.deepEqual(plan.args, [
      SCRIPT,
      '--patch-id',
      'demo-code',
      '--pkg',
      'demo-pkg',
      '--profile-dir',
      PROFILE,
      '--install',
    ])
  })

  it("carries the host's own script path, not one from the body", () => {
    const plan = planApply({ patchId: 'demo-code', scriptPath: '/tmp/evil.mjs' }, env(), '/usr/bin/node')
    assert.equal(plan.ok, true)
    if (!plan.ok) return
    assert.equal(plan.args[0], SCRIPT)
  })

  it('ignores a pkg smuggled into the body and uses the spec one', () => {
    // This is the whole security claim of the route: the body is a patch id,
    // never an argv, so no request can redirect the install at another package.
    const plan = planApply({ patchId: 'demo-code', pkg: 'something-else' }, env(), '/usr/bin/node')
    assert.equal(plan.ok, true)
    if (!plan.ok) return
    assert.equal(plan.args[4], 'demo-pkg')
  })

  it('ignores extra flags in the body entirely', () => {
    const plan = planApply(
      { patchId: 'demo-code', extraArgs: ['--force'], args: ['--registry=http://x'] },
      env(),
      '/usr/bin/node',
    )
    assert.equal(plan.ok, true)
    if (!plan.ok) return
    assert.deepEqual(plan.args.slice(7), ['--install'])
  })

  it('adds --dry-run and not --install for a preview', () => {
    const plan = planApply({ patchId: 'demo-code', dryRun: true }, env(), '/usr/bin/node')
    assert.equal(plan.ok, true)
    if (!plan.ok) return
    assert.equal(plan.args.at(-1), '--dry-run')
    assert.equal(plan.args.includes('--install'), false)
  })

  it('adds --install and not --dry-run for a real run', () => {
    const plan = planApply({ patchId: 'demo-code' }, env(), '/usr/bin/node')
    assert.equal(plan.ok, true)
    if (!plan.ok) return
    assert.equal(plan.args.at(-1), '--install')
    assert.equal(plan.args.includes('--dry-run'), false)
  })

  it('defaults the command to this node binary', () => {
    // Whatever runs the script must be the same node the host itself is on:
    // the script is an .mjs with no shebang path guarantee across installs.
    const plan = planApply({ patchId: 'demo-code' }, env())
    assert.equal(plan.ok, true)
    if (!plan.ok) return
    assert.equal(plan.command, process.execPath)
  })

  it('honours an injected node', () => {
    const plan = planApply({ patchId: 'demo-code' }, env(), '/opt/node/bin/node')
    assert.equal(plan.ok, true)
    if (!plan.ok) return
    assert.equal(plan.command, '/opt/node/bin/node')
  })

  it('runs with cwd set to the profile directory', () => {
    // pnpm is invoked from the profile on purpose; the script needs the
    // profile's own node_modules and lock, not the plugin's.
    const plan = planApply({ patchId: 'demo-code' }, env())
    assert.equal(plan.ok, true)
    if (!plan.ok) return
    assert.equal(plan.cwd, PROFILE)
  })

  it('echoes the plan back so the page can show the id and the mode', () => {
    const plan = planApply({ patchId: 'demo-code', dryRun: true }, env())
    assert.equal(plan.ok, true)
    if (!plan.ok) return
    assert.equal(plan.patchId, 'demo-code')
    assert.equal(plan.dryRun, true)
  })
})

/* -------------------------------------------------------------- readBody */

/** A request body as the harness hands one over: an async iterable of chunks. */
function bodyReq(chunks: unknown[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

describe('readBody', () => {
  it('joins the chunks of a normal body', async () => {
    const result = await readBody(bodyReq([Buffer.from('{"patchId":'), Buffer.from('"demo-code"}')]) as never)
    assert.equal(result.ok, true)
    assert.equal(result.ok === true ? result.text : '', '{"patchId":"demo-code"}')
  })

  it('accepts a Uint8Array chunk', async () => {
    const result = await readBody(bodyReq([new Uint8Array([123, 34, 125])]) as never)
    assert.equal(result.ok === true ? result.text : '', '{"}')
  })

  it('accepts a string chunk', async () => {
    const result = await readBody(bodyReq(['{"patchId":"demo-code"}']) as never)
    assert.equal(result.ok === true ? result.text : '', '{"patchId":"demo-code"}')
  })

  it('treats an empty body as an empty string, not as a failure', async () => {
    // A POST with no body still has to reach the JSON parser, which then
    // produces the 400. Refusing here would report the wrong problem.
    const result = await readBody(bodyReq([]) as never)
    assert.equal(result.ok, true)
    assert.equal(result.ok === true ? result.text : '', '')
  })

  it('refuses a body over the limit and stops pulling chunks', async () => {
    // Draining a body it has already refused is how a 4 KB cap turns into an
    // unbounded read on a hostile client.
    let pulled = 0
    const req = {
      async *[Symbol.asyncIterator]() {
        for (let index = 0; index < 5000; index += 1) {
          pulled += 1
          yield Buffer.from('x'.repeat(64))
        }
      },
    }
    const result = await readBody(req as never, 1024)
    assert.equal(result.ok, false)
    assert.ok(pulled < 5000, 'it drained the whole body, pulling ' + pulled + ' chunks')
  })

  it('counts bytes rather than characters', async () => {
    // The cap is a byte cap because that is what the socket delivers; a
    // multi-byte character must not slip four times its weight past it.
    const req = bodyReq([Buffer.from('é'.repeat(600))])
    const result = await readBody(req as never, 1000)
    assert.equal(result.ok, false)
  })

  it('reports an unreadable body as a refusal rather than a rejection', async () => {
    // A stream that dies mid-body must still produce an HTTP answer; letting
    // the rejection escape would leave the browser with a hung request.
    const req = {
      async *[Symbol.asyncIterator]() {
        yield Buffer.from('{"patchId":')
        throw new Error('the client hung up')
      },
    }
    const result = await readBody(req as never)
    assert.equal(result.ok, false)
  })

  it('uses the default limit of 4 KiB when none is given', () => {
    // Pinned because the route's own 413 message quotes this number.
    assert.equal(MAX_BODY_BYTES, 4096)
  })
})

/* ------------------------------------------------------------- capOutput */

describe('capOutput', () => {
  it('returns short output unchanged', () => {
    const result = capOutput('a short pnpm log')
    assert.deepEqual(result, { text: 'a short pnpm log', truncated: false })
  })

  it('keeps the tail of an over-long output, not the head', () => {
    // A failing pnpm says what went wrong last; keeping the head would show
    // the operator the download progress and none of the error.
    const result = capOutput('HEAD-MARKER' + 'x'.repeat(MAX_OUTPUT_CHARS) + 'TAIL-MARKER', 200)
    assert.equal(result.truncated, true)
    assert.ok(result.text.includes('TAIL-MARKER'))
    assert.equal(result.text.includes('HEAD-MARKER'), false)
  })

  it('never returns more than the limit', () => {
    const result = capOutput('x'.repeat(100_000), 500)
    assert.equal(result.truncated, true)
    assert.ok(result.text.length <= 500, 'returned ' + result.text.length + ' characters')
  })

  it('says how much it dropped, so the page can tell it is not the whole log', () => {
    const result = capOutput('x'.repeat(1000), 100)
    assert.match(result.text, /characters dropped/)
  })

  it('leaves a body exactly at the limit alone', () => {
    // Off-by-one here would truncate a log that fitted, and the "dropped"
    // banner would be a lie.
    const result = capOutput('x'.repeat(100), 100)
    assert.deepEqual(result, { text: 'x'.repeat(100), truncated: false })
  })

  it('has a default cap large enough to hold a pnpm failure', () => {
    assert.equal(MAX_OUTPUT_CHARS, 60_000)
  })
})

/* ----------------------------------------------------- registerApplyRoute */

interface Reply {
  status: number
  headers: Record<string, string>
  body: string
  json(): Record<string, unknown>
}

interface Harness {
  ctx: never
  routes: Map<string, (req: never, res: never) => void | Promise<void>>
  runCalls: Array<{ script: string; args: readonly string[]; options: { cwd?: string; timeoutMs: number } }>
  doneCount: number
  post(body: unknown, init?: { method?: string; headers?: Record<string, string>; raw?: string }): Promise<Reply>
}

const JSON_HEADERS = {
  [APPLY_HEADER]: APPLY_HEADER_VALUE,
  'content-type': 'application/json',
}

/** The fake web server + ctx, assembled the way the host sees them. */
function harness(
  outcome: Partial<RunOutcome> = {},
  envOverrides: Partial<ApplyEnvironment> = {},
  deps: { timeoutMs?: number; gate?: Promise<void> } = {},
): Harness {
  const routes = new Map<string, (req: never, res: never) => void | Promise<void>>()
  const runCalls: Harness['runCalls'] = []
  let doneCount = 0
  // Only a gate the test brought in is awaited. An internally created one could
  // never be released: the test is still inside post() waiting for the handler
  // that is waiting for the run, and post() is what would have released it.
  const gate = deps.gate

  const run: RunPort = {
    async run(script, args, options) {
      runCalls.push({ script, args: [...args], options })
      if (gate !== undefined) await gate
      return { code: 0, stdout: '', stderr: '', timedOut: false, truncated: false, ...outcome }
    },
  }

  const ctx = {
    reflect: {
      get: (name: string) =>
        name === 'webServer'
          ? {
              register(route: { path: string; handler: (req: never, res: never) => void | Promise<void> }) {
                if (routes.has(route.path)) throw new Error('duplicate route ' + route.path)
                routes.set(route.path, route.handler)
                return () => routes.delete(route.path)
              },
            }
          : undefined,
    },
  }

  const fake: Harness = {
    ctx: ctx as never,
    routes,
    runCalls,
    get doneCount() {
      return doneCount
    },
    async post(body, init = {}) {
      const handler = routes.get(APPLY_PATH)
      if (handler === undefined) throw new Error('no route ' + APPLY_PATH)
      const headers = { ...JSON_HEADERS, ...(init.headers ?? {}) }
      const text = init.raw ?? JSON.stringify(body)
      const chunks = init.raw !== undefined ? [Buffer.from(init.raw)] : [Buffer.from(text)]

      let captured: { status: number; headers: Record<string, string>; body: string } = {
        status: 0,
        headers: {},
        body: '',
      }
      const res = {
        writeHead(status: number, replyHeaders: Record<string, string>) {
          captured = { ...captured, status, headers: replyHeaders }
        },
        end(payload = '') {
          captured = { ...captured, body: payload }
        },
      }
      const req = {
        method: init.method ?? 'POST',
        headers,
        async *[Symbol.asyncIterator]() {
          for (const chunk of chunks) yield chunk
        },
      }
      await handler(req as never, res as never)
      return {
        ...captured,
        json: () => JSON.parse(captured.body) as Record<string, unknown>,
      }
    },
  }

  const returned = registerApplyRoute(ctx, {
    read: () => env(envOverrides),
    run,
    onDone: () => { doneCount += 1 },
    ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
  })
  if (returned === undefined) throw new Error('the route did not register')

  return fake
}

describe('registerApplyRoute: refusing before anything is spawned', () => {
  it('declines to register when there is no web server', () => {
    assert.equal(registerApplyRoute({}, { read: () => env(), run: { run: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false, truncated: false }) }, onDone() {} }), undefined)
  })

  it('answers a non-POST with 405 and an allow header', async () => {
    const web = harness()
    const reply = await web.post({ patchId: 'demo-code' }, { method: 'GET' })
    assert.equal(reply.status, 405)
    assert.equal(reply.headers['allow'], 'POST')
  })

  it('answers a request with no custom header with 403', async () => {
    // The header is the only thing stopping a page on another site from
    // starting a pnpm install here; without it a form POST would suffice.
    const web = harness()
    const reply = await web.post({ patchId: 'demo-code' }, { headers: { [APPLY_HEADER]: '' } })
    assert.equal(reply.status, 403)
  })

  it('refuses a header with the right name but the wrong value', async () => {
    // Matching by name alone would be enough for a same-origin check, so the
    // constant value is there to make the intent explicit rather than secret.
    const web = harness()
    const reply = await web.post({ patchId: 'demo-code' }, { headers: { [APPLY_HEADER]: 'yes' } })
    assert.equal(reply.status, 403)
  })

  it('answers a non-JSON content type with 415', async () => {
    const web = harness()
    const reply = await web.post({ patchId: 'demo-code' }, { headers: { 'content-type': 'text/plain' } })
    assert.equal(reply.status, 415)
  })

  it('accepts a content type that carries a charset', async () => {
    const web = harness()
    const reply = await web.post({ patchId: 'demo-code' }, { headers: { 'content-type': 'application/json; charset=utf-8' } })
    assert.equal(reply.status, 200)
  })

  it('answers a body over the cap with 413 and never starts a process', async () => {
    const web = harness()
    const reply = await web.post(undefined, { raw: '{"pad":"' + 'x'.repeat(MAX_BODY_BYTES) + '"}' })
    assert.equal(reply.status, 413)
    assert.equal(web.runCalls.length, 0)
  })

  it('answers a body that is not JSON with 400 and names the parse error', async () => {
    const web = harness()
    const reply = await web.post(undefined, { raw: 'not json at all' })
    assert.equal(reply.status, 400)
    assert.match(String(reply.json()['error']), /not JSON/)
  })
})

describe('registerApplyRoute: a refused plan keeps its own status', () => {
  it('surfaces a 404 for a patch the spec no longer has', async () => {
    const web = harness()
    const reply = await web.post({ patchId: 'ghost' })
    assert.equal(reply.status, 404)
    assert.equal(web.runCalls.length, 0)
  })

  it('surfaces a 501 for a build with no apply script', async () => {
    const web = harness({}, { scriptPath: undefined })
    const reply = await web.post({ patchId: 'demo-code' })
    assert.equal(reply.status, 501)
  })

  it('surfaces the plan error text verbatim', async () => {
    // The plan writes its own explanations; the route's only job here is not
    // to flatten them into a generic "bad request".
    const web = harness()
    const reply = await web.post({ patchId: 'demo-code', dryRun: 'maybe' })
    assert.equal(reply.status, 400)
    assert.equal(reply.json()['error'], 'dryRun must be a boolean')
  })

  it('marks every refusal as not ok', async () => {
    const web = harness()
    assert.equal((await web.post({ patchId: 'ghost' })).json()['ok'], false)
  })
})

describe('registerApplyRoute: a run that went well', () => {
  it('answers 200 and echoes stdout and stderr', async () => {
    const web = harness({ stdout: 'done.\n', stderr: '' })
    const reply = await web.post({ patchId: 'demo-code' })
    assert.equal(reply.status, 200)
    assert.equal(reply.json()['stdout'], 'done.\n')
    assert.equal(reply.json()['ok'], true)
  })

  it('tells the page which patch and which mode ran', async () => {
    const web = harness({ stdout: '' })
    const reply = await web.post({ patchId: 'demo-code', dryRun: true })
    assert.equal(reply.json()['patchId'], 'demo-code')
    assert.equal(reply.json()['dryRun'], true)
  })

  it('tells the page to move on exactly once', async () => {
    // onDone is what makes the settings page re-read the state; calling it
    // twice would queue two reconciles for one run.
    const web = harness({ stdout: '' })
    await web.post({ patchId: 'demo-code' })
    assert.equal(web.doneCount, 1)
  })

  it('passes the plan argv to the run port unchanged', async () => {
    const web = harness({ stdout: '' })
    await web.post({ patchId: 'demo-code' })
    assert.equal(web.runCalls.length, 1)
    assert.deepEqual(web.runCalls[0]?.args, [
      SCRIPT,
      '--patch-id',
      'demo-code',
      '--pkg',
      'demo-pkg',
      '--profile-dir',
      PROFILE,
      '--install',
    ])
  })

  it('runs the child in the profile directory', async () => {
    const web = harness({ stdout: '' })
    await web.post({ patchId: 'demo-code' })
    assert.equal(web.runCalls[0]?.options.cwd, PROFILE)
  })

  it('uses this node to run the script', async () => {
    const web = harness({ stdout: '' })
    await web.post({ patchId: 'demo-code' })
    assert.equal(web.runCalls[0]?.script, process.execPath)
  })

  it('marks the response no-store so a reload does not replay it', async () => {
    const web = harness({ stdout: '' })
    const reply = await web.post({ patchId: 'demo-code' })
    assert.equal(reply.headers['cache-control'], 'no-store')
  })
})

describe('registerApplyRoute: a run that did not go well', () => {
  it('answers 500 on a non-zero exit and still echoes the output', async () => {
    // The stderr of a failed pnpm is the entire point of having clicked; a 500
    // with an empty body would leave the operator with a status code and no
    // reason.
    const web = harness({ code: 1, stdout: 'fetching…', stderr: 'ERR_PNPM_LOCK  the lockfile is stale' })
    const reply = await web.post({ patchId: 'demo-code' })
    assert.equal(reply.status, 500)
    assert.equal(reply.json()['stderr'], 'ERR_PNPM_LOCK  the lockfile is stale')
    assert.equal(reply.json()['ok'], false)
  })

  it('reports the exit code it saw', async () => {
    const web = harness({ code: 3, stdout: '', stderr: '' })
    assert.equal((await web.post({ patchId: 'demo-code' })).json()['code'], 3)
  })

  it('answers 504 when the child had to be killed on the deadline', async () => {
    // 504 rather than 500: nothing is wrong with the patch, the machine was
    // too slow, and the page should offer to try again.
    const web = harness({ code: -1, stdout: 'partial', stderr: '', timedOut: true })
    const reply = await web.post({ patchId: 'demo-code' })
    assert.equal(reply.status, 504)
    assert.equal(reply.json()['timedOut'], true)
  })

  it('still echoes the output when the run port capped it', async () => {
    // capOutput shortens the text; a route that dropped the field when
    // truncated would lose exactly the tail it was keeping.
    const web = harness({ code: 1, stdout: 'kept tail', stderr: '', truncated: true })
    const reply = await web.post({ patchId: 'demo-code' })
    assert.equal(reply.json()['stdout'], 'kept tail')
    assert.equal(reply.json()['truncated'], true)
  })

  it('answers 500 rather than dropping the connection when the spawn itself fails', async () => {
    // A missing node binary rejects the promise inside the run port; the route
    // has to turn that into a reply or the browser waits forever.
    const routes = new Map<string, (req: never, res: never) => void | Promise<void>>()
    const ctx = {
      reflect: {
        get: () => ({
          register(route: { path: string; handler: (req: never, res: never) => void | Promise<void> }) {
            routes.set(route.path, route.handler)
            return () => routes.delete(route.path)
          },
        }),
      },
    }
    registerApplyRoute(ctx, {
      read: () => env(),
      run: { run: async () => { throw new Error('spawn node ENOENT') } },
      onDone() {},
    })
    const handler = routes.get(APPLY_PATH)
    assert.ok(handler !== undefined)
    let body = ''
    await handler(
      {
        method: 'POST',
        headers: JSON_HEADERS,
        async *[Symbol.asyncIterator]() { yield Buffer.from('{"patchId":"demo-code"}') },
      } as never,
      { writeHead() {}, end(text = '') { body = text } } as never,
    )
    const reply = JSON.parse(body) as Record<string, unknown>
    assert.equal(reply['ok'], false)
    assert.match(String(reply['stderr']), /ENOENT/)
  })
})

describe('registerApplyRoute: one run at a time', () => {
  it('answers 409 to a second request while the first is still going', async () => {
    // pnpm holds the profile lock; two concurrent installs would fight over it
    // and the operator would be shown whichever failed last.
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const web = harness({}, {}, { gate })

    const first = web.post({ patchId: 'demo-code' })
    const second = await web.post({ patchId: 'demo-code' })
    assert.equal(second.status, 409)
    assert.match(String(second.json()['error']), /already applying/)

    release?.()
    assert.equal((await first).status, 200)
  })

  it('lets a new request through once the first has finished', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const web = harness({}, {}, { gate })

    const first = web.post({ patchId: 'demo-code' })
    release?.()
    assert.equal((await first).status, 200)
    assert.equal((await web.post({ patchId: 'demo-code' })).status, 200)
    assert.equal(web.runCalls.length, 2)
  })

  it('does not count a request that was refused before it started', async () => {
    // A 404 must not leave the route believing something is running, or the
    // next real click would be answered with 409 for no reason.
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const web = harness({}, {}, { gate })
    assert.equal((await web.post({ patchId: 'ghost' })).status, 404)
    const run = web.post({ patchId: 'demo-code' })
    release?.()
    assert.equal((await run).status, 200)
  })
})

describe('registerApplyRoute: the deadline and the disposer', () => {
  it('hands the run port the timeout the deps declared', async () => {
    // A test that takes 300 s is not a test, so the timeout is injectable;
    // this pins that the declared value is the one that reaches the port
    // rather than a hard-coded default.
    const web = harness({ stdout: '' }, {}, { timeoutMs: 1234 })
    await web.post({ patchId: 'demo-code' })
    assert.equal(web.runCalls[0]?.options.timeoutMs, 1234)
  })

  it('falls back to the module default when no timeout is declared', () => {
    assert.equal(APPLY_TIMEOUT_MS, 300_000)
  })

  it('unregisters the route when the disposer is called', async () => {
    const routes = new Map<string, (req: never, res: never) => void | Promise<void>>()
    const ctx = {
      reflect: {
        get: () => ({
          register(route: { path: string; handler: (req: never, res: never) => void | Promise<void> }) {
            routes.set(route.path, route.handler)
            return () => routes.delete(route.path)
          },
        }),
      },
    }
    const dispose = registerApplyRoute(ctx, {
      read: () => env(),
      run: { run: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false, truncated: false }) },
      onDone() {},
    })
    assert.ok(dispose !== undefined)
    assert.ok(routes.has(APPLY_PATH))
    dispose()
    assert.equal(routes.has(APPLY_PATH), false)
  })
})
