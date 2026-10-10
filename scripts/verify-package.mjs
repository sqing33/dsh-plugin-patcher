import { access, readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function fail(message) {
  console.error('Package verification failed: ' + message)
  process.exitCode = 1
}

/** Every .ts/.tsx under `dir`, recursively. */
async function sources(dir) {
  const found = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...(await sources(path)))
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) found.push(path)
  }
  return found
}

const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const patchPath = packageJson.dsh?.bundle?.patch

const peerDependencies = packageJson.peerDependencies ?? {}
const peerDependenciesMeta = packageJson.peerDependenciesMeta ?? {}
for (const peer of Object.keys(peerDependencies)) {
  if (peerDependenciesMeta[peer]?.optional !== true) {
    fail('host-provided peer dependency must be optional: ' + peer)
  }
}
for (const peer of Object.keys(peerDependenciesMeta)) {
  if (!(peer in peerDependencies)) fail('peerDependenciesMeta contains an undeclared peer: ' + peer)
}

if (typeof patchPath !== 'string' || patchPath.length === 0) {
  fail('package.json must declare dsh.bundle.patch')
} else if (!(await exists(resolve(root, patchPath)))) {
  fail('bundle patch does not exist: ' + patchPath)
}

for (const path of ['lib/index.js', 'lib/client.js', 'README.md', 'README.zh.md', 'LICENSE']) {
  if (!(await exists(resolve(root, path)))) fail('required file does not exist: ' + path)
}

// The browser half is not optional here: this plugin exists to rewrite other
// plugins, and a page nobody can open is a spec nobody can see.
if (packageJson.exports?.['./client'] !== './lib/client.js') {
  fail('package.json must export ./client, or the host finds no browser bundle')
}
if (typeof packageJson.dsh?.client?.platform !== 'string') {
  fail('package.json must declare dsh.client.platform')
}
for (const path of ['lib/client.js', 'lib/client.js.map']) {
  if (!(packageJson.files ?? []).includes(path)) fail('files must ship ' + path)
}

for (const path of ['src/reasoning-settings.ts', 'src/index.ts', 'src/spec/schema.ts']) {
  const source = await readFile(resolve(root, path), 'utf8')
  if (source.includes('import { settingsNamespace')) {
    fail('host must not import the removed settingsNamespace runtime helper: ' + path)
  }
}
const hostEntry = await readFile(resolve(root, 'src/index.ts'), 'utf8')
if (!hostEntry.includes('export const namespace = name')) {
  fail('the settings namespace and the profile row id must be the same exported name')
}
if (!hostEntry.includes('patcherConfigSchema')) {
  fail('the plugin Config must be the spec schema, not the retired ladder schema')
}
const specSchema = await readFile(resolve(root, 'src/spec/schema.ts'), 'utf8')
if (!/\)\s*\.volatile\(\)/.test(specSchema.split('patcherConfigSchema =')[1] ?? '')) {
  fail('the spec schema root must be volatile, or dsh-settings refuses every write')
}

/**
 * One string serves three roles: the settings namespace, the profile row id,
 * and the dictionary namespace the page registers. A mismatch between the
 * client and the host fails silently and expensively — the host watches a
 * namespace nobody writes while the page writes one nobody reads — so the two
 * are compared here rather than trusted.
 */
const hostName = hostEntry.match(/export const name = '([^']+)'/)?.[1]
const clientNs = await readFile(resolve(root, 'src/client/ns.ts'), 'utf8')
const clientName = clientNs.match(/export const NAMESPACE = '([^']+)'/)?.[1]
if (hostName === undefined) {
  fail('the host entry must export a literal plugin name')
} else if (clientName !== hostName) {
  fail('client NAMESPACE (' + clientName + ') must equal the host name (' + hostName + ')')
}

/**
 * A template literal closed by a backtick-with-comma on its own line.
 *
 * rolldown's parser mis-reads that shape as an unterminated string and reports
 * "Identifier expected. 'export' is a reserved word" against the first export
 * *below* the literal — the wrong file and the wrong cause, and it costs a
 * bisect to find. The CSS in this plugin is the only place the shape arises, so
 * the check is exact rather than a lint.
 */
for (const path of await sources(resolve(root, 'src'))) {
  const source = await readFile(path, 'utf8')
  if (/^`\s*,\s*$/m.test(source)) {
    fail('a template literal must not be closed with a backtick and a comma: ' + path)
  }
}

const built = await readFile(resolve(root, 'lib/index.js'), 'utf8')
if (built.includes('import { settingsNamespace')) {
  fail('host bundle still imports the removed settingsNamespace runtime helper')
}
if (!built.includes('dsh-plugin-patcher')) fail('host bundle does not register the dsh-plugin-patcher plugin')
if (built.includes('__ModuleLoader__')) fail('the host bundle must not carry the browser wrapper')

const clientBundle = await readFile(resolve(root, 'lib/client.js'), 'utf8')
if (!clientBundle.includes('window.__ModuleLoader__.load')) {
  fail('the browser bundle must register itself through the module loader')
}
if (clientBundle.includes('node:fs') || clientBundle.includes('node:path')) {
  fail('the browser bundle must not reach for node builtins')
}
if (!clientBundle.includes(hostName ?? 'dsh-plugin-patcher')) {
  fail('the browser bundle does not carry the plugin namespace')
}

const patch = await readFile(resolve(root, patchPath), 'utf8')
if (!patch.includes('name: dsh-plugin-patcher')) fail('bundle patch must register dsh-plugin-patcher')
if (!patch.includes('id: dsh-plugin-patcher')) {
  fail('the bundle patch row id must equal the settings namespace dsh-plugin-patcher')
}
if (patch.includes('reasoning-ladder')) fail('the bundle patch still carries the retired reasoning-ladder row id')

if (process.exitCode !== 1) console.log('Package structure is valid.')