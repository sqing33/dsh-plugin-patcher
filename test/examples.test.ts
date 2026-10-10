
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { describe, it } from 'node:test'

import { cliCommand } from '../src/adapters/package-file.ts'
import { loadSpec } from '../src/spec/resolve.ts'
import type { Patch } from '../src/spec/types.ts'

// The examples are the shipped form of "this profile has three hand-edits on
// it". They are pasted into the page, so a malformed one is not a build
// failure but a confusing runtime rejection — the only place they are checked
// is here.
const DIR = new URL('../examples/', import.meta.url)
const files = readdirSync(DIR).filter((name) => name.endsWith('.json')).sort()

describe('the shipped examples', () => {
  it('exist', () => {
    assert.deepEqual(
      files,
      [
        'plan-build-switch-command-arity.json',
        'subagent-roles-configforms.json',
        'think-translate-icons-and-seat.json',
      ],
    )
  })

  for (const name of files) {
    describe(name, () => {
      const spec = loadSpec(JSON.parse(readFileSync(new URL(name, DIR), 'utf8')), new Map())

      it('loads with nothing to complain about', () => {
        assert.deepEqual(spec.diagnostics, [])
        assert.notEqual(spec.config, undefined)
        assert.equal(spec.rejected.size, 0)
        assert.equal(spec.contestedRows.size, 0)
        assert.equal(spec.contestedSlots.size, 0)
      })

      it('is a single enabled code patch on a version-pinned file', () => {
        const patches = spec.config?.patches ?? []
        assert.equal(patches.length, 1)
        for (const patch of patches) {
          assert.equal(patch.enabled, true)
          assert.equal(patch.target.kind, 'package-file')
          assert.equal(patch.op.kind, 'code')
          assert.notEqual(patch.target.kind === 'package-file' ? patch.target.version : '', '')
          // The reason is the only place the operator gets to say why, so an
          // empty one means the example teaches nothing.
          assert.ok(patch.reason.length > 80, 'the reason should explain the fix')
        }
      })

      it('names a command that lands on this patch', () => {
        const patch = spec.config?.patches?.[0] as Patch
        assert.equal(cliCommand(patch, patch.target), 'node scripts/apply-code-patch.mjs --patch-id ' + patch.id + ' --pkg ' + (patch.target.kind === 'package-file' ? patch.target.pkg : ''))
      })

      it('has no empty find, which would match everywhere', () => {
        const patch = spec.config?.patches?.[0] as Patch
        for (const edit of patch.op.kind === 'code' ? patch.op.edits : []) {
          assert.notEqual(edit.find, '')
          assert.equal(edit.count, 1)
        }
      })
    })
  }
})
