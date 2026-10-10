/**
 * The host layer: where the files are, what the state route says, and whether
 * one apply() actually reconciles.
 *
 * The apply() cases run against a fake settings service rather than the real
 * one. That is deliberate — the real service is exercised by the host itself,
 * and what needs proving here is the wiring: the debounce, the event
 * subscription, the ports, the route, and that a spec which names a settings
 * path really does end up written.
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { apply } from '../src/index.ts'
import { journalPathOf, patchPathOf, profileDirFrom } from '../src/host/profile.ts'
import { renderState, registerStateRoute, STATE_PATH, type PatcherState } from '../src/host/state.ts'
import type { PatcherConfig } from '../src/spec/types.ts'

const NAMESPACES = {
  'llm-pi-ai': { providers: { openai: { models: [{ id: 'm' }] } } },
  'dsh-plugin-patcher': {} as Record<string, unknown>,
}

/** Minimal settings service: describe/mutate over a plain object store. */
function fakeSettings(): {
  describe(): Array<{ ns: string; value: unknown; revision: number }>
  mutate(ns: string, ops: Array<{ op: 'set' | 'unset'; path: string[]; value?: unknown }>, revision?: number): Promise<void>
  configure(presentation: unknown): void
  writable: boolean
  values: Record<string, unknown>
  writes: Array<{ ns: string; ops: unknown[] }>
} {
  const values: Record<string, unknown> = structuredClone(NAMESPACES)
  const writes: Array<{ ns: string; ops: unknown[] }> = []
  const revisions = new Map<string, number>()
  function setAt(root: unknown, path: string[], value: unknown): unknown {
    if (path.length === 0) return value
    const container = (root ?? {}) as Record<string, unknown>
    const [head, ...rest] = path
    container[head] = setAt(container[head], rest, value)
    return container
  }
  function unsetAt(root: unknown, path: string[]): unknown {
    if (path.length === 0) return undefined
    const container = (root ?? {}) as Record<string, unknown>
    if (path.length === 1) {
      delete container[head(container, path)]
      return container
    }
    container[head(container, path)] = unsetAt(container[head(container, path)], path.slice(1))
    return container
  }
  const head = (container: Record<string, unknown>, path: string[]): string => path[0] as string
  return {
    values,
    writes,
    writable: true,
    configure() {},
    describe() {
      return Object.keys(values).map((ns) => ({
        ns,
        value: values[ns],
        revision: revisions.get(ns) ?? 0,
      }))
    },
    async mutate(ns, ops, _revision) {
      writes.push({ ns, ops })
      for (const op of ops) {
        if (op.op === 'set') values[ns] = setAt(values[ns], op.path, structuredClone(op.value))
        else values[ns] = unsetAt(values[ns], op.path)
      }
      revisions.set(ns, (revisions.get(ns) ?? 0) + 1)
    },
  }
}

interface Fake {
  ctx: never
  settings: ReturnType<typeof fakeSettings>
  routes: Map<string, (req: { method?: string }, res: never) => void | Promise<void>>
  listeners: Map<string, Array<(...args: unknown[]) => void>>
  bundles: Array<{ name: string; version?: string }>
  enabled: Array<[string, boolean]>
  profileDir: string
  emit(event: string, ...args: unknown[]): void
  fetch(path: string, method?: string): Promise<{ status: number; headers: Record<string, string>; body: string }>
}

async function fakeHost(spec: PatcherConfig, options: { profileDir?: string } = {}): Promise<Fake> {
  const profileDir = options.profileDir ?? (await mkdtemp(join(tmpdir(), 'patcher-host-')))
  await mkdir(join(profileDir, 'node_modules', 'demo'), { recursive: true })
  await writeFile(join(profileDir, 'node_modules', 'demo', 'index.js'), 'const label = 1\n')
  await writeFile(join(profileDir, 'cordis.patch.yml'), '- id: demo\n  disabled: false\n')
  const settings = fakeSettings()
  const routes = new Map<string, (req: { method?: string }, res: never) => void | Promise<void>>()
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  const enabled: Array<[string, boolean]> = []
  const services: Record<string, unknown> = {
    settings,
    pluginManager: {
      listBundles: async () => [{ name: 'demo', version: '1.0.0' }],
      setPluginEnabled: async (id: string, on: boolean) => {
        enabled.push([id, on])
        // The real manager rewrites the row and reloads; a fake that only
        // records the call would leave the file disagreeing with the world and
        // the engine's re-read would (correctly) call that drift.
        const before = await readFile(join(profileDir, 'cordis.patch.yml'), 'utf8')
        await writeFile(join(profileDir, 'cordis.patch.yml'), before.replace('disabled: false', 'disabled: true'))
      },
    },
    configEditor: { documentPath: join(profileDir, 'cordis.patch.yml') },
    webServer: {
      register(route: { path: string; handler: (req: { method?: string }, res: never) => void | Promise<void> }) {
        if (routes.has(route.path)) throw new Error('duplicate route ' + route.path)
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
  }
  const ctx = {
    settings,
    logger: { warn() {} },
    reflect: { get: (name: string) => services[name] },
    on(event: string, handler: (...args: unknown[]) => void) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
    },
  }
  // The spec is what the client would have written into the namespace.
  settings.values['dsh-plugin-patcher'] = spec
  const fake: Fake = {
    ctx: ctx as never,
    settings,
    routes,
    listeners,
    bundles: [{ name: 'demo', version: '1.0.0' }],
    enabled,
    profileDir,
    emit(event, ...args) {
      for (const handler of listeners.get(event) ?? []) handler(...args)
    },
    async fetch(path, method = 'GET') {
      const handler = routes.get(path)
      if (handler === undefined) throw new Error('no route ' + path)
      let captured: { status: number; headers: Record<string, string>; body: string } = {
        status: 0,
        headers: {},
        body: '',
      }
      const res = {
        writeHead(status: number, headers: Record<string, string>) {
          captured = { ...captured, status, headers }
        },
        end(body = '') {
          captured = { ...captured, body }
        },
      }
      await handler({ method }, res as never)
      return captured
    },
  }
  return fake
}

/** apply() debounces; tests wait for the pass to actually finish. */
async function settled(host: Fake, after?: string): Promise<PatcherState & { ok: boolean }> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    const reply = await host.fetch(STATE_PATH)
    const state = JSON.parse(reply.body) as PatcherState & { reconciledAt?: string }
    if (state.reconciledAt !== undefined && state.reconciledAt !== after) return state
  }
  throw new Error('the host never finished a reconcile')
}

function settingsPatch(): PatcherConfig {
  return {
    patches: [
      {
        id: 'effort',
        enabled: true,
        reason: 'pin the effort ladder onto every declared model',
        target: { kind: 'settings', namespace: 'llm-pi-ai' },
        op: { kind: 'set', path: ['providers', 'openai', 'defaultReasoning'], value: 'high' },
      },
    ],
    reconcileNonce: 0,
  }
}

describe('where the plugin is installed', () => {
  it('walks a hoisted install back to the profile directory', () => {
    assert.equal(
      profileDirFrom('file:///root/.dsh/profiles/web/node_modules/dsh-plugin-patcher/lib/index.js'),
      '/root/.dsh/profiles/web',
    )
  })

  it('decodes a percent-encoded path, because that is the real directory', () => {
    assert.equal(
      profileDirFrom('file:///srv/my%20profile/node_modules/@scope/dsh-thing/lib/index.js'),
      '/srv/my profile',
    )
  })

  it('uses the last node_modules on the path, not the first', () => {
    assert.equal(
      profileDirFrom('file:///a/node_modules/pkg/node_modules/inner/lib/index.js'),
      '/a/node_modules/pkg',
    )
  })

  it('refuses to guess when the module did not come from a node_modules tree', () => {
    assert.equal(profileDirFrom('file:///workspace/dsh-plugin-patcher/lib/index.js'), undefined)
    assert.equal(profileDirFrom('file:///lib/index.js'), undefined)
  })

  it('refuses a Windows path rather than pretending it understands one', () => {
    assert.equal(profileDirFrom('file:///C:/p/node_modules/pkg/lib/index.js'), undefined)
    assert.equal(profileDirFrom('C:\\p\\node_modules\\pkg\\lib\\index.js'), undefined)
  })

  it('turns an unknown profile into unknown paths, not into guesses', () => {
    assert.equal(patchPathOf(undefined), undefined)
    assert.equal(journalPathOf(undefined), undefined)
    assert.equal(journalPathOf('/p'), '/p/plugin-patcher/journal.jsonl')
  })
})

describe('the state route', () => {
  const state = (): PatcherState => ({
    namespace: 'dsh-plugin-patcher',
    version: 0,
    writable: true,
    profileDir: undefined,
    journalPath: undefined,
    spec: undefined,
    diagnostics: [],
    rejected: [],
    contestedRows: [],
    generators: [],
    statuses: [],
    tally: {} as PatcherState['tally'],
    reconciledAt: undefined,
    error: undefined,
  })

  it('declines to register when the composition has no web server', () => {
    assert.equal(registerStateRoute({}, () => state()), undefined)
  })

  it('answers a GET with the state and no-store headers', async () => {
    const host = await fakeHost(settingsPatch())
    apply(host.ctx)
    const reply = await host.fetch(STATE_PATH)
    assert.equal(reply.status, 200)
    assert.equal(reply.headers['content-type'], 'application/json; charset=utf-8')
    assert.equal(reply.headers['cache-control'], 'no-store')
    assert.equal(JSON.parse(reply.body).ok, true)
  })

  it('refuses every write method', async () => {
    const host = await fakeHost(settingsPatch())
    apply(host.ctx)
    const reply = await host.fetch(STATE_PATH, 'POST')
    assert.equal(reply.status, 405)
    assert.equal(reply.headers['allow'], 'GET, HEAD')
  })

  it('reports a state it could not serialise instead of dropping the connection', () => {
    const circular: Record<string, unknown> = { namespace: 'x' }
    circular['self'] = circular
    const reply = JSON.parse(renderState({ ...state(), spec: circular as never }))
    assert.equal(reply.ok, false)
    assert.match(String(reply.error), /could not be serialised/)
  })
})

describe('one apply()', () => {
  it('reconciles an enabled settings patch and writes the difference', async () => {
    const host = await fakeHost(settingsPatch())
    apply(host.ctx)
    const result = await settled(host)
    assert.equal(result.statuses.length, 1)
    assert.equal(result.statuses[0]?.state, 'in-sync')
    assert.deepEqual(host.settings.values['llm-pi-ai'], {
      providers: { openai: { models: [{ id: 'm' }], defaultReasoning: 'high' } },
    })
    assert.equal(host.settings.writes.length, 1)
  })

  it('leaves a namespace nobody named alone', async () => {
    const host = await fakeHost(settingsPatch())
    apply(host.ctx)
    await settled(host)
    assert.equal(host.settings.writes.filter((write) => write.ns === 'dsh-plugin-patcher').length, 0)
  })

  it('does not run twice for one fiber', async () => {
    const host = await fakeHost(settingsPatch())
    apply(host.ctx)
    apply(host.ctx)
    await settled(host)
    const before = host.settings.writes.length
    apply(host.ctx)
    for (let attempt = 0; attempt < 8; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal(host.settings.writes.length, before)
  })

  it('reconciles again when the spec namespace changes', async () => {
    const host = await fakeHost({ patches: [], reconcileNonce: 0 })
    apply(host.ctx)
    assert.equal((await settled(host)).statuses.length, 0)
    const first = await settled(host)
    await host.settings.mutate('dsh-plugin-patcher', [
      { op: 'set', path: ['patches'], value: settingsPatch().patches },
    ])
    host.emit('settings/document-updated', 'dsh-plugin-patcher', 1)
    const result = await settled(host, first.reconciledAt)
    assert.equal(result.statuses.length, 1)
    assert.equal(result.statuses[0]?.state, 'in-sync')
  })

  it('ignores an update to a namespace that is not its own', async () => {
    const host = await fakeHost(settingsPatch())
    apply(host.ctx)
    await settled(host)
    const before = host.settings.writes.length
    host.emit('settings/document-updated', 'llm-pi-ai', 1)
    for (let attempt = 0; attempt < 8; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal(host.settings.writes.length, before)
  })

  it('drives a row through the plugin manager, never by editing the file', async () => {
    const host = await fakeHost({
      patches: [
        {
          id: 'dock',
          enabled: true,
          reason: 'the dock row must stay on',
          target: { kind: 'patch-row', rowId: 'demo' },
          op: { kind: 'set-enabled', enabled: false },
        },
      ],
      reconcileNonce: 0,
    })
    apply(host.ctx)
    const result = await settled(host)
    assert.deepEqual(host.enabled, [['demo', false]])
    assert.equal(result.statuses[0]?.state, 'in-sync')
  })

  it('reports a file target as unsupported when the version does not match', async () => {
    const host = await fakeHost({
      patches: [
        {
          id: 'code',
          enabled: true,
          reason: 'the shipped source still needs the guard',
          target: { kind: 'package-file', pkg: 'demo', version: '0.9.0', path: 'index.js' },
          op: { kind: 'code', edits: [{ find: 'const label = 1', replace: 'const label = 2', count: 1 }] },
        },
      ],
      reconcileNonce: 0,
    })
    apply(host.ctx)
    const result = await settled(host)
    assert.equal(result.statuses[0]?.state, 'unsupported')
    assert.match(String(result.statuses[0]?.detail), /0\.9\.0/)
  })

  it('publishes a broken spec as a diagnostic instead of as status', async () => {
    const host = await fakeHost({ patches: [{ id: 'bad' }], reconcileNonce: 0 } as never)
    apply(host.ctx)
    const result = await settled(host)
    assert.equal(result.spec, undefined)
    assert.equal(result.statuses.length, 0)
    assert.ok(result.diagnostics.length > 0)
  })

  it('survives a settings service that throws, and says so', async () => {
    const host = await fakeHost(settingsPatch())
    const broken = {
      ...(host.ctx as unknown as Record<string, unknown>),
      settings: {
        ...host.settings,
        describe() {
          throw new Error('the profile is busy')
        },
      },
    }
    apply(broken as never)
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25))
      const reply = await host.routes.get(STATE_PATH)
      if (reply === undefined) continue
      let body = ''
      await reply({ method: 'GET' }, {
        writeHead() {},
        end(text = '') {
          body = text
        },
      } as never)
      if (body.includes('the profile is busy')) return
    }
    throw new Error('the host swallowed the failure instead of reporting it')
  })
})
