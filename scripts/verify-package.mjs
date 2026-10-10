import { access, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
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

for (const path of ['lib/index.js', 'README.md', 'README.zh.md', 'LICENSE']) {
  if (!(await exists(resolve(root, path)))) fail('required file does not exist: ' + path)
}

for (const path of ['src/reasoning-settings.ts', 'src/index.ts', 'src/spec/schema.ts']) {
  const source = await readFile(resolve(root, path), 'utf8')
  if (source.includes('import { settingsNamespace')) {
    fail('host must not import the removed settingsNamespace runtime helper: ' + path)
  }
}
const hostEntry = await readFile(resolve(root, 'src/index.ts'), 'utf8')
if (!hostEntry.includes("export const namespace = name")) {
  fail('the settings namespace and the profile row id must be the same exported name')
}
if (!hostEntry.includes('patcherConfigSchema')) {
  fail('the plugin Config must be the spec schema, not the retired ladder schema')
}
const specSchema = await readFile(resolve(root, 'src/spec/schema.ts'), 'utf8')
if (!/\)\s*\.volatile\(\)/.test(specSchema.split('patcherConfigSchema =')[1] ?? '')) {
  fail('the spec schema root must be volatile, or dsh-settings refuses every write')
}

const built = await readFile(resolve(root, 'lib/index.js'), 'utf8')
if (built.includes('import { settingsNamespace')) {
  fail('host bundle still imports the removed settingsNamespace runtime helper')
}
if (!built.includes('dsh-plugin-patcher')) fail('host bundle does not register the dsh-plugin-patcher plugin')
if (built.includes('__ModuleLoader__')) fail('this plugin must not ship a client bundle')

const patch = await readFile(resolve(root, patchPath), 'utf8')
if (!patch.includes('name: dsh-plugin-patcher')) fail('bundle patch must register dsh-plugin-patcher')
if (!patch.includes('id: dsh-plugin-patcher')) {
  fail('the bundle patch row id must equal the settings namespace dsh-plugin-patcher')
}
if (patch.includes('reasoning-ladder')) fail('the bundle patch still carries the retired reasoning-ladder row id')

if (process.exitCode !== 1) console.log('Package structure is valid.')
