import { defineConfig, type UserConfig } from 'tsdown'

const hostConfig: UserConfig = {
  name: 'dsh-plugin-patcher',
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2022',
  fixedExtension: false,
  dts: false,
  clean: true,
  deps: {
    neverBundle: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/schemastery',
      '@deepseek-ai/dsh-llm-pi-ai',
      '@deepseek-ai/dsh-settings',
    ],
  },
}

/**
 * The browser half, built as a DSH client-module registration bundle.
 *
 * The hand-written `__ModuleLoader__` wrapper is what the host evaluates to
 * register this module, and `require` inside it resolves react and the slots
 * face from the host's own copies rather than a second copy shipped here. That
 * is also why react is never bundled: two Reacts on one page is a hooks crash
 * with a message that says nothing about the real cause.
 *
 * `clean: false` matters — the host half cleans lib/, and a second clean would
 * delete the client bundle the page is about to ask for.
 */
const clientConfig: UserConfig = {
  name: 'dsh-plugin-patcher/client',
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: ['cjs'],
  platform: 'browser',
  target: 'es2022',
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: [
      'react',
      'react/jsx-runtime',
      '@deepseek-ai/dsh-client-ui-slots',
    ],
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "dsh-plugin-patcher", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default defineConfig([hostConfig, clientConfig])