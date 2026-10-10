
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
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

/** The repository root, for the checks that shell out. */
const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** The path an added file's ref resolves to inside this repository. */
function fileAt(ref: string): string {
  return fileURLToPath(new URL('../' + ref, import.meta.url))
}

describe('the shipped examples', () => {
  it('exist', () => {
    assert.deepEqual(
      files,
      [
        'plan-build-switch-command-arity.json',
        'reasoning-effort-force-effort-tiers.json',
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

      it('points every added file at a real one that parses', () => {
        const patch = spec.config?.patches?.[0] as Patch
        if (patch.op.kind !== 'code') return
        for (const file of patch.op.files) {
          // The spec names a file, never the code itself. That only holds up if
          // the file is really there: a ref to something missing reports as a
          // missing target package rather than as a broken shipped example.
          const source = readFileSync(new URL('../' + file.source, import.meta.url), 'utf8')
          assert.notEqual(source.trim(), '', file.source + ' is empty')
          const check = spawnSync(process.execPath, ['--check', fileAt(file.source)], { encoding: 'utf8' })
          assert.equal(check.status, 0, file.source + ': ' + check.stderr)
        }
      })

      it('points at a file the repository would actually commit', () => {
        const patch = spec.config?.patches?.[0] as Patch
        if (patch.op.kind !== 'code') return
        for (const file of patch.op.files) {
          // A file that exists in the working tree and is ignored by git is not
          // shipped at all, and the spec then fails on somebody else's plugin
          // instead of here. The unanchored `lib` that did this was a real bug,
          // so the check asks git rather than trusting that it cannot recur.
          const inside = spawnSync('git', ['-C', ROOT, 'check-ignore', file.source], { encoding: 'utf8' })
          if (inside.error !== undefined && 'code' in inside.error && inside.error.code === 'ENOENT') continue
          if (inside.error !== undefined) continue
          assert.equal(inside.status, 1, file.source + ' is gitignored: ' + inside.stdout)
        }
      })
    })
  }
})
