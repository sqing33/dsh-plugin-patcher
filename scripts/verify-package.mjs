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

const hostSource = await readFile(resolve(root, 'src/reasoning-settings.ts'), 'utf8')
if (hostSource.includes('import { settingsNamespace')) {
  fail('host must not import the removed settingsNamespace runtime helper')
}
const syncSource = await readFile(resolve(root, 'src/settings-sync.ts'), 'utf8')
if (!syncSource.includes("PI_AI_NAMESPACE = 'llm-pi-ai'")) {
  fail('the settings sync must target the llm-pi-ai namespace literal')
}

const built = await readFile(resolve(root, 'lib/index.js'), 'utf8')
if (built.includes('import { settingsNamespace')) {
  fail('host bundle still imports the removed settingsNamespace runtime helper')
}
if (!built.includes('reasoning-ladder')) fail('host bundle does not register the reasoning-ladder plugin')
if (built.includes('__ModuleLoader__')) fail('this plugin must not ship a client bundle')

const patch = await readFile(resolve(root, patchPath), 'utf8')
if (!patch.includes('name: dsh-reasoning-ladder')) fail('bundle patch must register dsh-reasoning-ladder')

if (process.exitCode !== 1) console.log('Package structure is valid.')
