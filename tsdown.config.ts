import { defineConfig, type UserConfig } from 'tsdown'

const hostConfig: UserConfig = {
  name: 'dsh-reasoning-ladder',
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

export default defineConfig([hostConfig])
