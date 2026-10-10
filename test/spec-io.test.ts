import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { PatcherStatus, PatchState } from '../src/adapters/types.ts'
import type { PatcherState } from '../src/host/state.ts'
import { loadSpec } from '../src/spec/resolve.ts'
import { PATCH_ID_PATTERN, type Op, type Patch, type PatcherConfig, type Target } from '../src/spec/types.ts'
import {
  bumpedNonce,
  describeTargetBrief,
  groupTargets,
  newPatchId,
  opKindsFor,
  patchesOf,
  specOf,
  statusOf,
  TARGET_KINDS,
  targetKey,
  toneOf,
  validateDraft,
  withEnabled,
  withPatch,
  withoutPatch,
  writeOps,
  type DraftPatch,
} from '../src/client/spec-io.ts'

const NS = 'llm-pi-ai'
const ROW = 'dsh-plan-build-switch'
const PKG = 'dsh-plan-build-switch'
const STAMP = '2024-01-01T00:00:00.000Z'

/** The host's window, with the fields under test left empty. */
function stateOf(extra: Partial<PatcherState> = {}): PatcherState {
  return {
    namespace: 'dsh-plugin-patcher',
    version: 3,
    writable: true,
    profileDir: '/profile',
    journalPath: '/profile/patcher/journal.jsonl',
    spec: undefined,
    diagnostics: [],
    rejected: [],
    contestedRows: [],
    generators: [],
    inventory: { settings: [], rows: [], bundles: [] },
    statuses: [],
    tally: {} as PatcherState['tally'],
    reconciledAt: STAMP,
    error: undefined,
    ...extra,
  }
}

function configOf(patches: Patch[], reconcileNonce = 0): PatcherConfig {
  return { patches, reconcileNonce }
}

function settingsPatch(id: string, extra: Partial<Patch> = {}): Patch {
  return {
    id,
    enabled: true,
    reason: 'why ' + id,
    target: { kind: 'settings', namespace: NS },
    op: { kind: 'set', path: ['providers'], value: { openai: {} } },
    ...extra,
  }
}

function rowPatch(id: string, extra: Partial<Patch> = {}): Patch {
  return {
    id,
    enabled: true,
    reason: 'why ' + id,
    target: { kind: 'patch-row', rowId: ROW },
    op: { kind: 'merge-config', config: { retries: 2 } },
    ...extra,
  }
}

function packagePatch(id: string, extra: Partial<Patch> = {}): Patch {
  return {
    id,
    enabled: true,
    reason: 'why ' + id,
    target: { kind: 'package-file', pkg: PKG, version: '0.2.2', path: 'lib/client.js' },
    op: { kind: 'code', edits: [{ find: 'a', replace: 'b', count: 1 }] },
    ...extra,
  }
}

function statusFor(patchId: string, state: PatchState, extra: Partial<PatcherStatus> = {}): PatcherStatus {
  return {
    patchId,
    state,
    kind: 'settings',
    targetLabel: NS,
    reason: 'why ' + patchId,
    detail: '',
    enabled: true,
    updatedAt: STAMP,
    ...extra,
  }
}

/** One well-formed target and op of every kind, for the pairing checks. */
const TARGETS: Record<Target['kind'], Target> = {
  settings: { kind: 'settings', namespace: NS },
  'patch-row': { kind: 'patch-row', rowId: ROW },
  'package-file': { kind: 'package-file', pkg: PKG, version: '0.2.2', path: 'lib/client.js' },
}

const OPS: Record<Op['kind'], Op> = {
  set: { kind: 'set', path: ['providers'], value: { openai: {} } },
  unset: { kind: 'unset', path: ['providers'] },
  'merge-config': { kind: 'merge-config', config: { retries: 2 } },
  'set-enabled': { kind: 'set-enabled', enabled: true },
  code: { kind: 'code', edits: [{ find: 'a', replace: 'b', count: 1 }] },
  'verify-only': { kind: 'verify-only' },
}

describe('specOf', () => {
  it('hands back the spec the host resolved, as it is', () => {
    const spec = configOf([settingsPatch('a')])
    assert.equal(specOf(stateOf({ spec })), spec)
  })

  it('stands in an empty spec when the host has none', () => {
    assert.deepEqual(specOf(stateOf()), { patches: [], reconcileNonce: 0 })
    assert.deepEqual(specOf(stateOf({ spec: undefined })), { patches: [], reconcileNonce: 0 })
  })

  it('builds a fresh stand-in per call, so two components cannot share one', () => {
    const first = specOf(stateOf())
    const second = specOf(stateOf())
    assert.notEqual(first, second)
    first.patches.push(settingsPatch('a'))
    assert.deepEqual(second.patches, [])
  })
})

describe('patchesOf', () => {
  it('returns the list the config carries', () => {
    const patches = [settingsPatch('a'), rowPatch('b')]
    assert.equal(patchesOf(configOf(patches)), patches)
  })

  it('reads a missing or non-array list as an empty spec', () => {
    assert.deepEqual(patchesOf({} as PatcherConfig), [])
    assert.deepEqual(patchesOf({ patches: 'nope', reconcileNonce: 0 } as unknown as PatcherConfig), [])
  })
})

describe('statusOf', () => {
  it('finds the status of a named patch', () => {
    const wanted = statusFor('b', 'drifted')
    assert.equal(statusOf([statusFor('a', 'in-sync'), wanted], 'b'), wanted)
  })

  it('has nothing to say about a patch the host has not reported', () => {
    assert.equal(statusOf([statusFor('a', 'failed')], 'b'), undefined)
    assert.equal(statusOf([], 'a'), undefined)
  })
})

describe('targetKey', () => {
  it('keeps the three kinds in separate namespaces', () => {
    const keys = [TARGETS.settings, TARGETS['patch-row'], TARGETS['package-file']].map(targetKey)
    assert.equal(new Set(keys).size, 3)
    assert.match(keys[0] ?? '', /^settings:/)
    assert.match(keys[1] ?? '', /^patch-row:/)
    assert.match(keys[2] ?? '', /^package-file:/)
  })

  it('gives two files of one package the same key', () => {
    const a = packagePatch('a')
    const b = packagePatch('b', { target: { ...TARGETS['package-file'], path: 'lib/other.js' } })
    assert.equal(targetKey(a.target), targetKey(b.target))
  })

  it("does not let a row's name guard split one row in two", () => {
    const guarded = rowPatch('a', { target: { kind: 'patch-row', rowId: ROW, name: 'dsh-plan-build-switch' } })
    assert.equal(targetKey(guarded.target), targetKey(rowPatch('b').target))
  })

  it('separates two rows of the same file', () => {
    const a = rowPatch('a')
    const b = rowPatch('b', { target: { kind: 'patch-row', rowId: 'dsh-web-ui' } })
    assert.notEqual(targetKey(a.target), targetKey(b.target))
  })
})

describe('describeTargetBrief', () => {
  it('names a namespace, a row and a pinned package', () => {
    assert.equal(describeTargetBrief(TARGETS.settings), NS)
    assert.equal(describeTargetBrief(TARGETS['patch-row']), ROW)
    assert.equal(describeTargetBrief(TARGETS['package-file']), PKG + '@0.2.2')
  })

  it('drops the pin from a package that never named a version', () => {
    assert.equal(describeTargetBrief({ kind: 'package-file', pkg: PKG, path: 'lib/client.js' }), PKG)
  })
})

describe('groupTargets', () => {
  const inventory = {
    settings: [NS, 'dsh-web-ui'],
    rows: [{ rowId: ROW, name: PKG, enabled: false }],
    bundles: [{ pkg: PKG, version: '0.2.2' }],
  }

  it('puts three patches on two targets, in spec order', () => {
    const state = stateOf({
      spec: configOf([settingsPatch('a'), rowPatch('b'), settingsPatch('c')]),
      statuses: [statusFor('c', 'in-sync')],
      inventory,
    })
    const { bound, unknown } = groupTargets(state)
    assert.equal(bound.length, 2)
    assert.equal(unknown.length, 0)
    const settings = bound.find((group) => group.key === 'settings:' + NS)
    assert.deepEqual(settings?.patches.map((entry) => entry.patch.id), ['a', 'c'])
    assert.equal(settings?.patches[0]?.status, undefined)
    assert.equal(settings?.patches[1]?.status?.state, 'in-sync')
  })

  it('binds a settings target the inventory serves', () => {
    const state = stateOf({ spec: configOf([settingsPatch('a')]), inventory })
    const [group] = groupTargets(state).bound
    assert.equal(group?.key, 'settings:' + NS)
    assert.equal(group?.label, NS)
    assert.equal(group?.unknown, false)
    assert.equal(group?.pkg, undefined)
    assert.equal(group?.version, undefined)
    assert.equal(group?.rowEnabled, undefined)
  })

  it('keeps a namespace the inventory does not serve in the unknown list', () => {
    const gone = settingsPatch('a', { target: { kind: 'settings', namespace: 'dsh-gateway' } })
    const state = stateOf({
      spec: configOf([gone]),
      statuses: [statusFor('a', 'absent')],
      inventory,
    })
    const { bound, unknown } = groupTargets(state)
    assert.deepEqual(bound, [])
    assert.equal(unknown.length, 1)
    assert.equal(unknown[0]?.unknown, true)
    assert.equal(unknown[0]?.label, 'dsh-gateway')
    assert.equal(unknown[0]?.patches.length, 1)
    assert.equal(unknown[0]?.patches[0]?.status?.state, 'absent')
  })

  it('takes a row enablement and the row package name from the inventory', () => {
    const state = stateOf({ spec: configOf([rowPatch('a')]), inventory })
    const [group] = groupTargets(state).bound
    assert.equal(group?.key, 'patch-row:' + ROW)
    assert.equal(group?.rowEnabled, false)
    assert.equal(group?.pkg, PKG)
  })

  it('leaves a row the patch file does not list without an enablement', () => {
    const gone = rowPatch('a', { target: { kind: 'patch-row', rowId: 'dsh-removed' } })
    const [group] = groupTargets(stateOf({ spec: configOf([gone]), inventory })).unknown
    assert.equal(group?.unknown, true)
    assert.equal(group?.rowEnabled, undefined)
    assert.equal(group?.pkg, undefined)
  })

  it('fills the package and the installed version of a bundle', () => {
    const state = stateOf({ spec: configOf([packagePatch('a')]), inventory })
    const [group] = groupTargets(state).bound
    assert.equal(group?.key, 'package-file:' + PKG)
    assert.equal(group?.label, PKG + '@0.2.2')
    assert.equal(group?.pkg, PKG)
    assert.equal(group?.version, '0.2.2')
    assert.equal(group?.unknown, false)
  })

  it('binds a bundle whose installed version it could not read', () => {
    const state = stateOf({
      spec: configOf([packagePatch('a')]),
      inventory: { ...inventory, bundles: [{ pkg: PKG, version: undefined }] },
    })
    const [group] = groupTargets(state).bound
    assert.equal(group?.version, undefined)
  })

  it('reports an uninstalled package as unknown, with no package of its own', () => {
    const gone = packagePatch('a', { target: { kind: 'package-file', pkg: 'dsh-gone', version: '1.0.0', path: 'lib/a.js' } })
    const [group] = groupTargets(stateOf({ spec: configOf([gone]), inventory })).unknown
    assert.equal(group?.unknown, true)
    assert.equal(group?.pkg, undefined)
    assert.equal(group?.version, undefined)
  })

  it('never raises a card for a target no patch claims', () => {
    const state = stateOf({ spec: configOf([settingsPatch('a')]), inventory })
    const { bound, unknown } = groupTargets(state)
    assert.deepEqual(bound.map((group) => group.label), [NS])
    assert.deepEqual(unknown, [])
  })

  it('lists a duplicated patch id once', () => {
    const state = stateOf({ spec: configOf([settingsPatch('a'), settingsPatch('a')]), inventory })
    const [group] = groupTargets(state).bound
    assert.equal(group?.patches.length, 1)
  })

  it('carries the target of the first patch in the group', () => {
    const first = packagePatch('a')
    const second = packagePatch('b', { target: { ...TARGETS['package-file'], path: 'lib/other.js' } })
    const [group] = groupTargets(stateOf({ spec: configOf([first, second]), inventory })).bound
    assert.equal(group?.target, first.target)
    assert.equal(group?.patches.length, 2)
  })

  it('orders both lists by label, whatever order the spec used', () => {
    const state = stateOf({
      spec: configOf([
        settingsPatch('a', { target: { kind: 'settings', namespace: 'zulu' } }),
        settingsPatch('b', { target: { kind: 'settings', namespace: 'alpha' } }),
        settingsPatch('c', { target: { kind: 'settings', namespace: 'yankee' } }),
        settingsPatch('d', { target: { kind: 'settings', namespace: 'bravo' } }),
      ]),
      inventory: { settings: ['alpha', 'bravo', 'yankee', 'zulu'], rows: [], bundles: [] },
    })
    const { bound, unknown } = groupTargets(state)
    assert.deepEqual(bound.map((group) => group.label), ['alpha', 'bravo', 'yankee', 'zulu'])
    assert.deepEqual(unknown, [])
  })

  it('groups a spec-less host into two empty lists', () => {
    assert.deepEqual(groupTargets(stateOf()), { bound: [], unknown: [] })
  })
})

describe('toneOf', () => {
  const expected: Record<PatchState, 'ok' | 'warn' | 'bad'> = {
    'in-sync': 'ok',
    drifted: 'warn',
    pending: 'warn',
    conflict: 'bad',
    unsupported: 'bad',
    absent: 'bad',
    failed: 'bad',
  }

  it('maps all seven states', () => {
    for (const [state, tone] of Object.entries(expected)) {
      assert.equal(toneOf(state as PatchState), tone, state)
    }
  })

  it('separates a recoverable drift from a request this build cannot honour', () => {
    assert.equal(toneOf('drifted'), 'warn')
    assert.equal(toneOf('unsupported'), 'bad')
  })
})

describe('withPatch', () => {
  it('appends a patch whose id the spec does not have', () => {
    const config = configOf([settingsPatch('a')])
    const next = withPatch(config, rowPatch('b'))
    assert.deepEqual(next.patches.map((patch) => patch.id), ['a', 'b'])
  })

  it('replaces a colliding id in place, keeping its position', () => {
    const config = configOf([settingsPatch('a'), rowPatch('b'), settingsPatch('c')])
    const next = withPatch(config, { ...rowPatch('b'), reason: 'changed' })
    assert.deepEqual(next.patches.map((patch) => patch.id), ['a', 'b', 'c'])
    assert.equal(next.patches[1]?.reason, 'changed')
    assert.equal(next.patches.length, 3)
  })

  it('leaves the config it was given exactly as it was', () => {
    const original = settingsPatch('a')
    const config = configOf([original])
    const snapshot = JSON.stringify(config)
    const next = withPatch(config, { ...original, reason: 'changed' })
    assert.equal(JSON.stringify(config), snapshot)
    assert.equal(original.reason, 'why a')
    assert.notEqual(next, config)
    assert.notEqual(next.patches, config.patches)
  })
})

describe('withoutPatch', () => {
  it('removes the patch holding that id', () => {
    const config = configOf([settingsPatch('a'), rowPatch('b'), settingsPatch('c')])
    const next = withoutPatch(config, 'b')
    assert.deepEqual(next.patches.map((patch) => patch.id), ['a', 'c'])
    assert.equal(config.patches.length, 3)
  })

  it('copies the config even when the id is not there', () => {
    const config = configOf([settingsPatch('a')])
    const next = withoutPatch(config, 'zzz')
    assert.deepEqual(next.patches, config.patches)
    assert.notEqual(next, config)
    assert.notEqual(next.patches, config.patches)
  })
})

describe('withEnabled', () => {
  it('flips one patch and leaves its neighbours alone', () => {
    const config = configOf([settingsPatch('a'), rowPatch('b')])
    const next = withEnabled(config, 'b', false)
    assert.equal(next.patches[0], config.patches[0])
    assert.equal(next.patches[1]?.enabled, false)
    assert.equal(config.patches[1]?.enabled, true)
  })

  it('changes nothing for an id that is not in the spec', () => {
    const config = configOf([settingsPatch('a')])
    const next = withEnabled(config, 'zzz', false)
    assert.deepEqual(next.patches, config.patches)
    assert.equal(next.reconcileNonce, config.reconcileNonce)
  })
})

describe('bumpedNonce', () => {
  it('adds exactly one', () => {
    assert.equal(bumpedNonce(configOf([], 7)).reconcileNonce, 8)
    assert.equal(bumpedNonce(configOf([], 0)).reconcileNonce, 1)
  })

  it('restarts a nonce that is not a number, rather than writing NaN', () => {
    const broken = { patches: [], reconcileNonce: 'three' } as unknown as PatcherConfig
    assert.equal(bumpedNonce(broken).reconcileNonce, 1)
  })

  it('leaves the config it was given alone', () => {
    const config = configOf([settingsPatch('a')], 2)
    const next = bumpedNonce(config)
    assert.equal(config.reconcileNonce, 2)
    assert.notEqual(next, config)
  })
})

describe('writeOps', () => {
  const config = configOf([settingsPatch('a'), rowPatch('b')], 5)

  it('writes exactly two ops, the whole array first', () => {
    const ops = writeOps(config)
    assert.equal(ops.length, 2)
    assert.deepEqual(ops.map((op) => op.path), [['patches'], ['reconcileNonce']])
    assert.ok(ops.every((op) => op.op === 'set'))
  })

  it('carries the array itself, not a diff of it', () => {
    const ops = writeOps(config)
    assert.equal(ops[0]?.value, config.patches)
    assert.equal(ops[1]?.value, 5)
  })

  it('writes an empty array rather than nothing for a spec that lost its list', () => {
    const broken = { patches: undefined, reconcileNonce: 2 } as unknown as PatcherConfig
    assert.deepEqual(writeOps(broken)[0]?.value, [])
  })
})

describe('newPatchId', () => {
  it('starts at patch-1 for a spec that holds nothing', () => {
    assert.equal(newPatchId([]), 'patch-1')
  })

  it('skips the ids that are taken', () => {
    assert.equal(newPatchId([settingsPatch('patch-1'), settingsPatch('patch-2')]), 'patch-3')
  })

  it('ignores ids outside the series instead of counting past them', () => {
    assert.equal(newPatchId([settingsPatch('custom'), settingsPatch('patch-2')]), 'patch-1')
  })

  it('keeps producing ids the host schema accepts', () => {
    const taken = Array.from({ length: 40 }, (_, index) => settingsPatch('patch-' + (index + 1)))
    for (const id of [newPatchId(taken), newPatchId([...taken, settingsPatch(newPatchId(taken))])]) {
      assert.match(id, PATCH_ID_PATTERN)
    }
    assert.equal(newPatchId(taken), 'patch-41')
  })
})

describe('opKindsFor', () => {
  it('offers the pairing the host enforces', () => {
    assert.deepEqual(opKindsFor('settings'), ['set', 'unset', 'verify-only'])
    assert.deepEqual(opKindsFor('patch-row'), ['merge-config', 'set-enabled', 'verify-only'])
  })

  it('offers a code edit alone for a package file', () => {
    assert.deepEqual(opKindsFor('package-file'), ['code'])
  })

  it('agrees with loadSpec on every pairing', () => {
    for (const kind of TARGET_KINDS) {
      for (const [opKind, op] of Object.entries(OPS)) {
        const spec = loadSpec({ patches: [{ id: 'probe', reason: 'r', target: TARGETS[kind], op }] })
        const offered = opKindsFor(kind).includes(opKind as Op['kind'])
        assert.equal(spec.rejected.size === 0, offered, kind + ' + ' + opKind + ': ' + JSON.stringify(spec.diagnostics))
      }
    }
  })

  it('hands out a copy the page cannot corrupt', () => {
    const first = opKindsFor('settings')
    first.push('code')
    assert.deepEqual(opKindsFor('settings'), ['set', 'unset', 'verify-only'])
  })
})

describe('validateDraft', () => {
  function draft(override: Partial<DraftPatch> = {}): DraftPatch {
    return { id: 'patch-9', enabled: true, reason: 'why', target: TARGETS.settings, op: OPS.set, ...override }
  }

  /** A spec already holding patch-1, so a draft claiming that id collides. */
  const usedState = stateOf({ spec: configOf([settingsPatch('patch-1')]) })

  function rejects(override: Partial<DraftPatch>, field: string): string {
    const message = validateDraft(draft(override), usedState)
    assert.ok(message, 'expected a rejection about ' + field)
    assert.ok(message.includes(field), message)
    return message
  }

  it('accepts a complete draft for every target kind', () => {
    assert.equal(validateDraft(draft(), usedState), undefined)
    assert.equal(validateDraft(draft({ target: TARGETS['patch-row'], op: OPS['merge-config'] }), usedState), undefined)
    assert.equal(validateDraft(draft({ target: TARGETS['package-file'], op: OPS.code }), usedState), undefined)
    assert.equal(validateDraft(draft({ op: OPS['verify-only'] }), stateOf()), undefined)
  })

  it('refuses an id the host schema would reject', () => {
    assert.match(rejects({ id: 'Bad Id' }, 'id'), /\^\[a-z0-9\]/)
  })

  it('refuses an id another patch already holds', () => {
    assert.equal(rejects({ id: 'patch-1' }, 'id'), 'id is already used by another patch in the spec')
  })

  it('accepts the id of the patch being edited, and only that one', () => {
    // Saving an edit that changed nothing must not be impossible, but naming a
    // different patch must not become a way to take its id.
    assert.equal(validateDraft(draft({ id: 'patch-1' }), usedState, 'patch-1'), undefined)
    assert.equal(
      validateDraft(draft({ id: 'patch-1' }), usedState, 'patch-2'),
      'id is already used by another patch in the spec',
    )
  })

  it('refuses a missing reason, including one that is only whitespace', () => {
    rejects({ reason: '' }, 'reason')
    rejects({ reason: '   ' }, 'reason')
  })

  it('refuses an op the target kind cannot carry', () => {
    assert.match(rejects({ op: OPS.code }, 'op.kind'), /cannot address a "settings" target/)
    assert.match(rejects({ target: TARGETS['package-file'], op: OPS['verify-only'] }, 'op.kind'), /expected "code"/)
  })

  it('refuses a set or an unset with no path', () => {
    rejects({ op: { kind: 'set', path: [], value: 1 } }, 'op.path')
    rejects({ op: { kind: 'unset', path: [] } }, 'op.path')
  })

  it('refuses a merge with nothing to merge', () => {
    rejects({ target: TARGETS['patch-row'], op: { kind: 'merge-config', config: {} } }, 'op.config')
  })

  it('refuses a code patch with no edits', () => {
    rejects({ target: TARGETS['package-file'], op: { kind: 'code', edits: [] } }, 'op.edits')
  })

  it('refuses a package-file patch that pinned no version', () => {
    const unpinned = { kind: 'package-file', pkg: PKG, path: 'lib/client.js' } as Target
    rejects({ target: unpinned, op: OPS.code }, 'target.version')
  })

  it('reports the first problem, in the order the form is filled in', () => {
    const message = validateDraft(draft({ id: 'Bad Id', reason: '', op: OPS.code }), usedState)
    assert.equal(message, 'id must match /^[a-z0-9][a-z0-9-]*$/ (lowercase letters, digits, dashes)')
  })

  it('keeps every message short and about the field it names', () => {
    const cases: Array<[string, Partial<DraftPatch>]> = [
      ['id', { id: 'Bad Id' }],
      ['id', { id: 'patch-1' }],
      ['reason', { reason: '' }],
      ['op.kind', { op: OPS.code }],
      ['op.kind', { target: TARGETS['package-file'], op: OPS['verify-only'] }],
      ['op.path', { op: { kind: 'set', path: [], value: 1 } }],
      ['op.path', { op: { kind: 'unset', path: [] } }],
      ['op.config', { target: TARGETS['patch-row'], op: { kind: 'merge-config', config: {} } }],
      ['op.edits', { target: TARGETS['package-file'], op: { kind: 'code', edits: [] } }],
      ['target.version', { target: { kind: 'package-file', pkg: PKG, path: 'lib/client.js' }, op: OPS.code }],
    ]
    for (const [field, override] of cases) {
      const message = validateDraft(draft(override), usedState) ?? ''
      assert.ok(message.includes(field), message)
      assert.ok(message.length < 90, message.length + ' characters: ' + message)
    }
  })

  it('reads neither the draft nor the spec', () => {
    const before = JSON.stringify(draft({ op: { kind: 'unset', path: [] } }))
    const specBefore = JSON.stringify(specOf(usedState))
    validateDraft(draft({ op: { kind: 'unset', path: [] } }), usedState)
    assert.equal(JSON.stringify(draft({ op: { kind: 'unset', path: [] } })), before)
    assert.equal(JSON.stringify(specOf(usedState)), specBefore)
  })
})
