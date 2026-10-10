/** The textarea boundary: a spec has to be able to leave the page and come back. */

import assert from 'node:assert/strict'
import test from 'node:test'
import { formatSpecText, parseSpecText } from '../src/client/spec-text.ts'
import type { PatcherState } from '../src/host/state.ts'
import type { PatcherConfig, Patch } from '../src/spec/types.ts'

const NS = 'llm-pi-ai'

function stateOf(config?: PatcherConfig): PatcherState {
  return {
    namespace: 'dsh-plugin-patcher',
    version: 1,
    writable: true,
    profileDir: '/p',
    journalPath: '/p/journal.jsonl',
    spec: config,
    diagnostics: [],
    rejected: [],
    contestedRows: [],
    inventory: { settings: [NS], rows: [], bundles: [] },
    statuses: [],
    tally: {} as PatcherState['tally'],
    reconciledAt: undefined,
    error: undefined,
  } as PatcherState
}

function patch(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    enabled: true,
    reason: 'because ' + id,
    target: { kind: 'settings', namespace: NS },
    op: { kind: 'set', path: ['providers', 'openai'], value: 1 },
    ...extra,
  }
}

function textOf(...patches: Record<string, unknown>[]): string {
  return JSON.stringify({ patches, reconcileNonce: 3 })
}

test('round-trips a spec through text without changing it', () => {
  const config = { patches: [patch('a'), patch('b')] as Patch[], reconcileNonce: 7 }
  const parsed = parseSpecText(formatSpecText(config), stateOf())
  assert.equal(parsed.error, undefined)
  assert.deepEqual(parsed.config, config)
})

test('an empty spec is a spec, not an error', () => {
  const parsed = parseSpecText('{"patches":[],"reconcileNonce":0}', stateOf())
  assert.equal(parsed.error, undefined)
  assert.deepEqual(parsed.config?.patches, [])
})

test('formatting an absent spec yields something that can be imported back', () => {
  const parsed = parseSpecText(formatSpecText(undefined), stateOf())
  assert.equal(parsed.error, undefined)
  assert.deepEqual(parsed.config?.patches, [])
})

test('refuses text that is not JSON, and says why', () => {
  const parsed = parseSpecText('{patches: []}', stateOf())
  assert.equal(parsed.config, undefined)
  assert.match(parsed.error ?? '', /not JSON/)
})

test('refuses a spec that is not an object with a patches array', () => {
  for (const bad of ['[]', '"x"', 'null', '{}']) {
    const parsed = parseSpecText(bad, stateOf())
    assert.equal(parsed.config, undefined, bad)
    assert.ok(parsed.error !== undefined, bad)
  }
})

test('refuses an empty paste rather than clearing the spec by accident', () => {
  const parsed = parseSpecText('   \n  ', stateOf())
  assert.equal(parsed.config, undefined)
  assert.match(parsed.error ?? '', /nothing to import/)
})

test('holds the whole paste to the form rules and names the patch that failed', () => {
  const parsed = parseSpecText(textOf(patch('good'), patch('bad', { reason: '  ' })), stateOf())
  assert.equal(parsed.config, undefined)
  assert.match(parsed.error ?? '', /^bad: reason is required/)
})

test('a duplicate id inside one paste is refused, like it is in the editor', () => {
  const parsed = parseSpecText(textOf(patch('same'), patch('same')), stateOf())
  assert.equal(parsed.config, undefined)
  assert.match(parsed.error ?? '', /^same: id is already used/)
})

test('an op that cannot address its target is refused before it reaches the host', () => {
  const parsed = parseSpecText(
    textOf(patch('wrong', { op: { kind: 'merge-config', config: { a: 1 } } })),
    stateOf(),
  )
  assert.equal(parsed.config, undefined)
  assert.match(parsed.error ?? '', /cannot address/)
})

test('a malformed nonce is dropped rather than written through', () => {
  const parsed = parseSpecText('{"patches":[],"reconcileNonce":"soon"}', stateOf())
  assert.equal(parsed.config?.reconcileNonce, 0)
})

test('a missing enabled flag means enabled, the same default the schema has', () => {
  const parsed = parseSpecText(
    JSON.stringify({ patches: [{ ...patch('a'), enabled: undefined }] }),
    stateOf(),
  )
  assert.equal(parsed.error, undefined)
  assert.equal(parsed.config?.patches[0]?.enabled, true)
})
