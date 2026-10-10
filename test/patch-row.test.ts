import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { patchRowAdapter, patchRowFilePort, type PatchRowPort } from '../src/adapters/patch-row.ts'
import type { Json, Patch, PatchRowTarget } from '../src/spec/types.ts'

/**
 * A cut-down copy of the shape the real profile file has: a human comment
 * header, a top-level sequence, a row that appears twice, an `- insert:` row
 * with nested entries, and a `!!js` value. Fixtures that drop the awkward
 * parts of a file are how a text-surgery bug survives to production.
 */
const REALISTIC = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
#
# 2026-09-23: 禁用单装 dsh-better-sidebar 的挂载行（id: better-sidebar）。
# 仅禁用、不卸载；settings.yaml 里的 subagent-library.entries 保留不删。
- id: subagent-roles
  disabled: false
- id: ui-settings-general
  name: "@deepseek-ai/dsh-client-ui-settings-general"
  config:
    welcomeNoticeVersion: 2026-08-13.1
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      nas:
        models:
          - id: gpt-6-astra
            reasoningEfforts:
              off: off
              medium: medium
- id: subagent-roles
  disabled: true
- id: sysmon
  name: dsh-sysmon
  config:
    dock: !!js/function "() => 1"

# 之后生效，同 id 会把 dsh-sysmon 那一行改名成 dsh-sysmon。
- insert:
    - id: sysmon-dock
      name: dsh-plugin-sysmon
`

interface Recorder {
  writes: string[]
  enables: [string, boolean][]
  rejectWith?: unknown
}

function fakePort(initial: string, recorder: Recorder = { writes: [], enables: [] }): PatchRowPort & { recorder: Recorder } {
  let text = initial
  return {
    recorder,
    readPatchText: () => text,
    writePatchText(next) {
      recorder.writes.push(next)
      text = next
    },
    async setRowEnabled(rowId, enabled) {
      if (recorder.rejectWith !== void 0) throw recorder.rejectWith
      recorder.enables.push([rowId, enabled])
      const lines = text.split('\n')
      const at = lines.findIndex((line) => line === `- id: ${rowId}`)
      assert.ok(at >= 0, 'the fake port can only flip a row that exists')
      lines.splice(at + 1, 1, `  disabled: ${!enabled}`)
      text = lines.join('\n')
    },
  }
}

function patch(target: PatchRowTarget, op: Patch['op']): Patch {
  return { id: 'p1', enabled: true, reason: 'test', target, op }
}

const row = (rowId: string, extra: Partial<PatchRowTarget> = {}): PatchRowTarget => ({ kind: 'patch-row', rowId, ...extra })

const dirs: string[] = []
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describe('finding the row a patch means', () => {
  it('reports a row that is not in the file as absent, by name', () => {
    const snapshot = patchRowAdapter.read(fakePort(REALISTIC), patch(row('nope'), { kind: 'verify-only' }))
    assert.equal(snapshot.state, 'absent')
    assert.match(snapshot.detail, /no row with id "nope"/)
  })

  it('takes the last of two rows with the same id, because that is the one in effect', () => {
    const port = fakePort(REALISTIC)
    const target = row('subagent-roles')
    // The first occurrence says disabled:false, the second disabled:true.
    const enable = patchRowAdapter.read(port, patch(target, { kind: 'set-enabled', enabled: false }))
    assert.equal(enable.state, 'in-sync')
    const disable = patchRowAdapter.read(port, patch(target, { kind: 'set-enabled', enabled: true }))
    assert.equal(disable.state, 'drifted')
  })

  it('does not follow an id nested inside an insert list', () => {
    const snapshot = patchRowAdapter.read(fakePort(REALISTIC), patch(row('sysmon-dock'), { kind: 'verify-only' }))
    assert.equal(snapshot.state, 'absent')
  })

  it('refuses a row whose name is not the one the spec pinned', () => {
    const snapshot = patchRowAdapter.read(
      fakePort(REALISTIC),
      patch(row('llm-pi-ai', { name: 'dsh-some-other-thing' }), { kind: 'verify-only' }),
    )
    assert.equal(snapshot.state, 'conflict')
    assert.match(snapshot.detail, /dsh-llm-pi-ai/)
  })

  it('accepts a row whose name matches the one the spec pinned', () => {
    const snapshot = patchRowAdapter.read(
      fakePort(REALISTIC),
      patch(row('llm-pi-ai', { name: '@deepseek-ai/dsh-llm-pi-ai' }), { kind: 'verify-only' }),
    )
    assert.equal(snapshot.state, 'in-sync')
  })
})

describe('set-enabled goes through the plugin manager', () => {
  it('reads a row with no disabled: key as enabled', () => {
    const snapshot = patchRowAdapter.read(fakePort(REALISTIC), patch(row('ui-settings-general'), { kind: 'set-enabled', enabled: true }))
    assert.equal(snapshot.state, 'in-sync')
    assert.equal(snapshot.value, true)
  })

  it('never edits the disabled: line itself, because the manager owns it', async () => {
    const recorder: Recorder = { writes: [], enables: [] }
    const port = fakePort(REALISTIC, recorder)
    const result = await patchRowAdapter.apply(port, patch(row('ui-settings-general'), { kind: 'set-enabled', enabled: false }))
    assert.equal(result.state, 'in-sync')
    assert.deepEqual(recorder.writes, [], 'the file was rewritten by hand')
    assert.deepEqual(recorder.enables, [['ui-settings-general', false]])
  })

  it('reports what the manager did not do, rather than claiming success', async () => {
    const port = fakePort(REALISTIC, { writes: [], enables: [], rejectWith: { code: 'unaddressable' } })
    const result = await patchRowAdapter.apply(port, patch(row('ui-settings-general'), { kind: 'set-enabled', enabled: false }))
    assert.equal(result.state, 'unsupported')
    assert.match(result.detail, /unaddressable/)
  })

  it('does not treat an unrelated failure as a refusal to address the row', async () => {
    const port = fakePort(REALISTIC, { writes: [], enables: [], rejectWith: new Error('boom') })
    const result = await patchRowAdapter.apply(port, patch(row('ui-settings-general'), { kind: 'set-enabled', enabled: false }))
    assert.equal(result.state, 'failed')
    assert.match(result.detail, /boom/)
  })

  it('sets the row back to the journaled value on rollback', async () => {
    const recorder: Recorder = { writes: [], enables: [] }
    const port = fakePort(REALISTIC, recorder)
    await patchRowAdapter.apply(port, patch(row('ui-settings-general'), { kind: 'set-enabled', enabled: false }))
    const result = await patchRowAdapter.rollback(port, patch(row('ui-settings-general'), { kind: 'set-enabled', enabled: false }), true)
    assert.equal(result.state, 'in-sync')
    assert.deepEqual(recorder.enables.at(-1), ['ui-settings-general', true])
  })
})

describe('merge-config writes only its own block', () => {
  it('sees a row the patcher has never touched as drifted', () => {
    const snapshot = patchRowAdapter.read(
      fakePort(REALISTIC),
      patch(row('sysmon'), { kind: 'merge-config', config: { dock: { side: 'right' } } }),
    )
    assert.equal(snapshot.state, 'drifted')
    assert.equal(snapshot.value, undefined)
  })

  it('leaves every byte it did not write alone', async () => {
    const port = fakePort(REALISTIC)
    const before = port.readPatchText()
    await patchRowAdapter.apply(port, patch(row('sysmon'), { kind: 'merge-config', config: { dock: { side: 'right' } } }))
    const after = port.readPatchText()

    // Strip the whole managed block, markers included, and compare the rest.
    const kept = (text: string): string[] => {
      const out: string[] = []
      let inside = false
      for (const line of text.split('\n')) {
        if (line.includes('dsh-plugin-patcher begin managed')) { inside = true; continue }
        if (line.includes('dsh-plugin-patcher end managed')) { inside = false; continue }
        if (!inside) out.push(line)
      }
      return out
    }
    assert.deepEqual(kept(after), kept(before))
    assert.ok(after.includes('dock: !!js/function "() => 1"'), 'the row value the operator wrote survived')
    assert.ok(after.includes('仅禁用、不卸载'), 'the comment header survived')
  })

  it('reads its own block back as in-sync, and only when the content matches', async () => {
    const port = fakePort(REALISTIC)
    const spec = patch(row('sysmon'), { kind: 'merge-config', config: { side: 'right', size: 3 } })
    await patchRowAdapter.apply(port, spec)
    assert.equal(patchRowAdapter.read(port, spec).state, 'in-sync')

    const reordered = patch(row('sysmon'), { kind: 'merge-config', config: { size: 3, side: 'right' } })
    assert.equal(patchRowAdapter.read(port, reordered).state, 'in-sync', 'key order is not a difference')

    const changed = patch(row('sysmon'), { kind: 'merge-config', config: { side: 'left', size: 3 } })
    assert.equal(patchRowAdapter.read(port, changed).state, 'drifted')
  })

  it('writes nested values as nested yaml, not as a string', async () => {
    const port = fakePort(REALISTIC)
    const spec = patch(row('sysmon'), {
      kind: 'merge-config',
      config: { dock: { side: 'right', items: ['a', 'b'], deep: { on: true } } },
    })
    await patchRowAdapter.apply(port, spec)
    const text = port.readPatchText()
    assert.match(text, /^ {6}deep:$/m)
    assert.match(text, /^ {8}on: true$/m)
    assert.equal(patchRowAdapter.read(port, spec).state, 'in-sync')
  })

  it('opens up an inline empty config rather than refusing the row', async () => {
    const port = fakePort('- id: p\n  config: {}\n')
    const spec = patch(row('p'), { kind: 'merge-config', config: { a: 1 } })
    await patchRowAdapter.apply(port, spec)
    assert.equal(patchRowAdapter.read(port, spec).state, 'in-sync')
    assert.match(port.readPatchText(), /^ {2}config:$/m)
  })

  it('creates the config key on a row that has none', async () => {
    const port = fakePort('- id: p\n  name: some-pkg\n')
    const spec = patch(row('p'), { kind: 'merge-config', config: { a: 1 } })
    await patchRowAdapter.apply(port, spec)
    assert.equal(patchRowAdapter.read(port, spec).state, 'in-sync')
    assert.match(port.readPatchText(), /^ {2}config:$/m)
    assert.match(port.readPatchText(), /^ {2}name: some-pkg$/m)
  })

  it('does not write when the file already said this', async () => {
    const recorder: Recorder = { writes: [], enables: [] }
    const port = fakePort(REALISTIC, recorder)
    const spec = patch(row('sysmon'), { kind: 'merge-config', config: { a: 1 } })
    await patchRowAdapter.apply(port, spec)
    const result = await patchRowAdapter.apply(port, spec)
    assert.equal(result.state, 'in-sync')
    assert.equal(recorder.writes.length, 1)
  })
})

describe('a block belongs to exactly one patch', () => {
  it('refuses to touch a block another patch wrote', async () => {
    const port = fakePort(REALISTIC)
    await patchRowAdapter.apply(port, patch(row('sysmon'), { kind: 'merge-config', config: { a: 1 } }))
    const intruder = { ...patch(row('sysmon'), { kind: 'merge-config', config: { b: 2 } }), id: 'p2' }
    assert.equal(patchRowAdapter.read(port, intruder).state, 'conflict')
    const result = await patchRowAdapter.apply(port, intruder)
    assert.equal(result.state, 'failed')
    assert.match(result.detail, /belongs to a different patch/)
  })

  it('refuses a block whose end marker went missing', () => {
    // The end marker never made it into the file, the way a half-finished
    // hand edit looks.
    const truncated = REALISTIC.replace(
      '    dock: !!js/function "() => 1"\n',
      '    dock: !!js/function "() => 1"\n    # dsh-plugin-patcher begin managed for p1\n    a: 1\n',
    )
    const snapshot = patchRowAdapter.read(fakePort(truncated), patch(row('sysmon'), { kind: 'verify-only' }))
    assert.equal(snapshot.state, 'conflict')
    assert.match(snapshot.detail, /missing its end marker/)
  })

  it('refuses to start a second block on the same row', async () => {
    const port = fakePort(REALISTIC)
    const spec = patch(row('sysmon'), { kind: 'merge-config', config: { a: 1 } })
    await patchRowAdapter.apply(port, spec)
    const doubled = port.readPatchText().replace(
      /^ {4}# dsh-plugin-patcher begin managed for p1$/m,
      '    # dsh-plugin-patcher begin managed for p1\n    # dsh-plugin-patcher begin managed for p1',
    )
    assert.equal(patchRowAdapter.read(fakePort(doubled), spec).state, 'conflict')
  })
})

describe('rolling back a managed block', () => {
  it('removes the block when the journal recorded no previous one', async () => {
    const port = fakePort(REALISTIC)
    const before = port.readPatchText()
    const spec = patch(row('sysmon'), { kind: 'merge-config', config: { a: 1 } })
    await patchRowAdapter.apply(port, spec)
    const result = await patchRowAdapter.rollback(port, spec, undefined)
    assert.equal(result.state, 'in-sync')
    assert.equal(port.readPatchText(), before, 'the file came back byte for byte')
  })

  it('puts the previous block content back', async () => {
    const port = fakePort(REALISTIC)
    const first = { ...patch(row('sysmon'), { kind: 'merge-config', config: { a: 1 } }) }
    await patchRowAdapter.apply(port, first)
    const after = port.readPatchText()
    const second = { ...patch(row('sysmon'), { kind: 'merge-config', config: { a: 2, b: 3 } }) }
    await patchRowAdapter.apply(port, second)
    assert.notEqual(port.readPatchText(), after)

    const result = await patchRowAdapter.rollback(port, second, { a: 1 } as Json)
    assert.equal(result.state, 'in-sync')
    assert.equal(port.readPatchText(), after)
  })

  it('leaves a config key it opened itself, because an empty mapping is a no-op', async () => {
    const port = fakePort('- id: p\n  name: some-pkg\n')
    const spec = patch(row('p'), { kind: 'merge-config', config: { a: 1 } })
    await patchRowAdapter.apply(port, spec)
    await patchRowAdapter.rollback(port, spec, undefined)
    assert.equal(port.readPatchText(), '- id: p\n  name: some-pkg\n  config:\n')
  })
})

describe('verify-only', () => {
  it('never writes the file and never calls the manager', async () => {
    const recorder: Recorder = { writes: [], enables: [] }
    const port = fakePort(REALISTIC, recorder)
    const result = await patchRowAdapter.apply(port, patch(row('sysmon'), { kind: 'verify-only' }))
    assert.equal(result.state, 'in-sync')
    assert.deepEqual(recorder.writes, [])
    assert.deepEqual(recorder.enables, [])
  })
})

describe('an operation that is not a patch-row operation', () => {
  it('says so instead of guessing', () => {
    const snapshot = patchRowAdapter.read(
      fakePort(REALISTIC),
      patch(row('sysmon'), { kind: 'set', path: ['a'], value: 1 }),
    )
    assert.equal(snapshot.state, 'failed')
    assert.match(snapshot.detail, /not a patch-row operation/)
  })
})

describe('the real file port', () => {
  it('replaces the file atomically and leaves no temporary behind', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'patch-row-'))
    dirs.push(dir)
    const path = join(dir, 'cordis.patch.yml')
    writeFileSync(path, REALISTIC, 'utf8')

    const port = patchRowFilePort(path, async () => {})
    const spec = patch(row('sysmon'), { kind: 'merge-config', config: { a: 1 } })
    const written = patchRowAdapter.apply(port, spec)
    assert.equal((await written).state, 'in-sync')

    assert.ok(readFileSync(path, 'utf8').includes('dsh-plugin-patcher begin managed'))
    assert.deepEqual(readdirSync(dir), ['cordis.patch.yml'])
  })
})
