import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { countPatchModels, normalizePatchModels } from '../src/patch-rewrite.ts'

const LADDER = { off: 'off', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' }
const UPSTREAM_LADDER = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' }

function render(efforts: Record<string, string>, key = '            '): string[] {
  return [key + 'reasoningEfforts:', ...Object.keys(efforts).map((k) => ' '.repeat(key.length + 2) + k + ': ' + efforts[k])]
}

const PATCH = [
  '- id: some-other-plugin',
  '  config:',
  '    foo: bar',
  '- id: llm-pi-ai',
  '  config:',
  '    providers:',
  '      alpha:',
  '        models:',
  '          - id: a1',
  '            name: A1',
  ...render(UPSTREAM_LADDER),
  '          - id: a2',
  '            name: A2',
  '          - id: a3',
  '            name: A3',
  ...render(UPSTREAM_LADDER),
  '      beta:',
  '        models:',
  '          - id: b1',
  '  extra: kept',
  '',
].join('\n')

describe('normalizePatchModels', () => {
  it('replaces every declared ladder inside the llm-pi-ai entry', () => {
    const out = normalizePatchModels(PATCH, LADDER)
    assert.ok(!out.includes('low: low'), 'the low rung must be gone')
    // a1, a2, a3 under alpha and b1 under beta.
    assert.equal(out.split('            reasoningEfforts:').length - 1, 4)
  })

  it('rewrites the model list of every provider, not just the first', () => {
    const beta = normalizePatchModels(PATCH, LADDER).split('\n')
    const from = beta.findIndex((l) => l.includes('beta:'))
    assert.ok(beta.slice(from).join('\n').includes('              off: off'))
  })

  it('counts every model entry the entry declares', () => {
    assert.equal(countPatchModels(PATCH), 4)
    assert.equal(countPatchModels(normalizePatchModels(PATCH, LADDER)), 4)
  })

  it('counts nothing when the entry is absent', () => {
    assert.equal(countPatchModels('- id: other\n'), 0)
    assert.equal(countPatchModels('- id: llm-pi-ai\n  config: {}\n'), 0)
  })

  it('follows the declared indentation instead of assuming twelve spaces', () => {
    const deeper = [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      alpha:',
      '        group:',
      '          models:',
      '            - id: a1',
      '              name: A1',
      ...render(UPSTREAM_LADDER, '              '),
      '            - id: a2',
      '',
    ].join('\n')
    const out = normalizePatchModels(deeper, LADDER)
    assert.ok(!out.includes('low: low'), 'the low rung must be gone')
    assert.equal(out.split('              reasoningEfforts:').length - 1, 2)
    assert.ok(out.includes('                off: off'))
    assert.equal(countPatchModels(out), 2)
  })

  it('leaves other patch entries untouched', () => {
    const out = normalizePatchModels(PATCH, LADDER)
    assert.ok(out.startsWith('- id: some-other-plugin\n  config:\n    foo: bar'))
  })

  it('preserves the trailing sibling key', () => {
    assert.ok(normalizePatchModels(PATCH, LADDER).includes('  extra: kept'))
  })

  it('is idempotent', () => {
    const once = normalizePatchModels(PATCH, LADDER)
    assert.equal(normalizePatchModels(once, LADDER), once)
  })

  it('keeps the model list itself byte-identical apart from the ladder', () => {
    const strip = (s: string) =>
      s
        .split('\n')
        .filter((l) => !/^\s+(reasoningEfforts:|\w+: \w+$)/.test(l))
        .join('\n')
    assert.equal(strip(normalizePatchModels(PATCH, LADDER)), strip(PATCH))
  })

  it('returns the input unchanged when the llm-pi-ai entry is absent', () => {
    const other = '- id: something-else\n  config: {}\n'
    assert.equal(normalizePatchModels(other, LADDER), other)
  })

  it('returns the input unchanged when the entry declares no models', () => {
    const noModels = '- id: llm-pi-ai\n  config:\n    providers: {}\n'
    assert.equal(normalizePatchModels(noModels, LADDER), noModels)
  })

  it('stops at the next top-level entry instead of bleeding into it', () => {
    const two = PATCH + '- id: trailing-plugin\n  config:\n    models:\n      - id: z1\n'
    const out = normalizePatchModels(two, LADDER)
    assert.equal(out.split('            reasoningEfforts:').length - 1, 4)
    assert.ok(!out.includes('off: off\n- id: trailing-plugin'))
  })
})
