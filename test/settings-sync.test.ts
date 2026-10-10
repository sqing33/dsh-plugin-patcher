import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PI_AI_NAMESPACE, readNamespace } from '../src/settings-sync.ts'

/**
 * The settings-sync regression these tests pin down:
 * DSH 0.1.7's SettingsForms has no per-namespace reader, so a namespace must
 * be located by scanning describe(). The old code called a get() that does not
 * exist and threw a TypeError on every retry.
 */

function descriptor(ns: string, value: unknown) {
  return {
    ns,
    value,
    autoGenerate: true,
    schema: null,
    revision: 1,
    applies: 'live' as const,
  }
}

describe('readNamespace', () => {
  it('finds a namespace by its exact id', () => {
    const found = readNamespace([descriptor('other', {}), descriptor(PI_AI_NAMESPACE, { providers: {} })], PI_AI_NAMESPACE)
    assert.equal(found?.value !== undefined, true)
  })

  it('returns undefined when the namespace is not registered yet', () => {
    assert.equal(readNamespace([descriptor('other', {})], PI_AI_NAMESPACE), undefined)
    assert.equal(readNamespace([], PI_AI_NAMESPACE), undefined)
  })

  it('does not match by prefix, so a similarly named row cannot hijack the lookup', () => {
    assert.equal(readNamespace([descriptor('llm-pi-ai-extra', {})], PI_AI_NAMESPACE), undefined)
  })
})
