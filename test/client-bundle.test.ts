/**
 * Does the built browser bundle actually load?
 *
 * Every other test in this repository exercises source. This one evaluates
 * lib/client.js the way the host does — through the `__ModuleLoader__` wrapper,
 * with a `require` that answers react — and then calls apply() against a host
 * that records what was registered. A bundle that throws while evaluating, or
 * that registers nothing, looks exactly like a working plugin from the terminal
 * and shows up in the UI as a settings section that is not there.
 *
 * It reads the build output, so it fails until `pnpm run build` has run. That is
 * deliberate: the bundle is the artefact the host loads, and the source it is
 * built from is tested everywhere else.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Enough of react for a bundle that only calls jsx-runtime at render time. */
const stubReact = {
  createElement: () => ({}),
  useState: () => [undefined, () => undefined],
  useMemo: (fn: () => unknown) => fn(),
  useCallback: (fn: unknown) => fn,
  useSyncExternalStore: () => ({}),
  Fragment: 'fragment',
}

interface LoaderRow {
  id: string
  factory: (require: (name: string) => unknown) => unknown
}

/** Evaluate the bundle the way the host's loader does. */
function loadBundle(source: string): { apply: (ctx: unknown) => void; inject: string[] } {
  const loaded: LoaderRow[] = []
  const run = (row: LoaderRow): unknown => row.factory(() => stubReact)
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(row: LoaderRow) {
          loaded.push(row)
          return run(row)
        },
      },
    },
  }
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  assert.equal(loaded.length, 1, 'the bundle must register exactly one module')
  const first = loaded[0]!
  assert.equal(first.id, 'dsh-plugin-patcher', 'the loader row must name this package')
  const exports = run(first) as { apply: (ctx: unknown) => void; inject: string[] }
  assert.equal(typeof exports.apply, 'function')
  assert.ok(Array.isArray(exports.inject))
  return exports
}

interface SlotRecord {
  options: Record<string, unknown>
  component: unknown
}

function fakeHost(): {
  ctx: Record<string, unknown>
  slots: SlotRecord[]
  injected: string[]
  dictionaries: string[]
  lookedUp: string[]
} {
  const slots: SlotRecord[] = []
  const injected: string[] = []
  const dictionaries: string[] = []
  const lookedUp: string[] = []
  return {
    ctx: {
      effect(body: () => unknown) {
        return body() as () => void
      },
      slots: {
        inject(name: string, body: () => () => void) {
          injected.push(name)
          body()
        },
        register(options: Record<string, unknown>, component: unknown) {
          slots.push({ options, component })
          return () => {
            const at = slots.findIndex((slot) => slot.component === component)
            if (at !== -1) slots.splice(at, 1)
          }
        },
      },
      locale: {
        register(namespace: string) {
          dictionaries.push(namespace)
          return () => undefined
        },
        bind(namespace: string) {
          lookedUp.push(namespace)
          return (key: string) => key
        },
      },
      configForms: {
        get(entryId: string) {
          lookedUp.push(entryId)
          return { async mutate() { return true } }
        },
      },
    },
    slots,
    injected,
    dictionaries,
    lookedUp,
  }
}

const source = await readFile(resolve(root, 'lib/client.js'), 'utf8')

test('the browser bundle loads and hands back an apply and an inject list', () => {
  const module = loadBundle(source)
  assert.equal(typeof module.apply, 'function')
  assert.deepEqual([...module.inject].sort(), ['configForms', 'locale', 'remote', 'slots'])
})

test('apply() registers the settings section and both plugin detail slots', () => {
  const module = loadBundle(source)
  const host = fakeHost()
  module.apply(host.ctx)
  assert.deepEqual(host.injected, [
    'settings.section',
    'plugins.detail.badge',
    'plugins.detail.section',
  ])
  assert.deepEqual(
    host.slots.map((slot) => slot.options.name),
    ['settings.section', 'plugins.detail.badge', 'plugins.detail.section'],
  )
})

test('the settings section is keyed by the plugin name, which is also the spec namespace', () => {
  const module = loadBundle(source)
  const host = fakeHost()
  module.apply(host.ctx)
  const section = host.slots[0]!.options
  assert.equal(section.id, 'dsh-plugin-patcher')
  assert.equal(section.locale, 'dsh-plugin-patcher')
  // The form is the spec namespace and nothing else: a second write channel
  // would be a second thing the host has to watch.
  assert.ok(host.lookedUp.includes('dsh-plugin-patcher'))
  assert.deepEqual(host.dictionaries, ['dsh-plugin-patcher'])
})

test('the section label is a function, because the locale can change under it', () => {
  const module = loadBundle(source)
  const host = fakeHost()
  module.apply(host.ctx)
  const label = host.slots[0]!.options.label
  assert.equal(typeof label, 'function')
  assert.equal((label as () => string)(), 'title')
})

test('the detail slots render null for a subject this plugin has no patches for', () => {
  const module = loadBundle(source)
  const host = fakeHost()
  module.apply(host.ctx)
  const badge = host.slots[1]!.component as (props: unknown) => unknown
  const section = host.slots[2]!.component as (props: unknown) => unknown
  const props = { subject: { kind: 'bundle', pkg: 'dsh-nothing-to-do-with' } }
  // The host state has not been read yet, so there is nothing to match: both
  // must decline rather than render an empty card on every plugin's page.
  assert.equal(badge(props), null)
  assert.equal(section(props), null)
})
