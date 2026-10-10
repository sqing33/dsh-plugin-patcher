import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  applyEdits,
  assessEdits,
  cliCommand,
  describeProblem,
  editProblems,
  packageFileAdapter,
  type PackageFilePort,
} from '../src/adapters/package-file.ts'
import type { CodeEdit, Patch } from '../src/spec/types.ts'

const SOURCE = [
  "'use strict';",
  '',
  "const LABEL = 'expected a number';",
  'const SIZE = 42;',
  "throw new TypeError(LABEL);",
  '',
].join('\n')

const PATCHED = SOURCE.replace('expected a number', '需要一个数字')

function edit(over: Partial<CodeEdit> = {}): CodeEdit {
  return { find: "expected a number", replace: '需要一个数字', count: 1, ...over }
}

function patch(over: Partial<Patch> = {}): Patch {
  return {
    id: 'demo',
    enabled: true,
    reason: 'demo patch',
    target: { kind: 'package-file', pkg: 'demo', version: '1.0.0', path: 'index.js' },
    op: { kind: 'code', edits: [edit()] },
    ...over,
  } as Patch
}

function port(over: Partial<PackageFilePort> = {}): PackageFilePort {
  return {
    version: () => '1.0.0',
    locate: () => '/demo/index.js',
    readFile: () => SOURCE,
    ...over,
  }
}

describe('assessEdits', () => {
  it('calls an edit that matches once applicable', () => {
    assert.equal(assessEdits(SOURCE, [edit()]).kind, 'applicable')
  })

  it('refuses an edit that matches more than once', () => {
    const verdict = assessEdits(SOURCE, [edit({ find: 'const' })])
    assert.equal(verdict.kind, 'many-matches')
    assert.equal((verdict as { count: number }).count, 2)
  })

  it('refuses an empty find before anything else', () => {
    const verdict = assessEdits(SOURCE, [edit({ find: '' })])
    assert.equal(verdict.kind, 'empty-find')
  })

  it('reports a miss as no-match when the replacement is absent too', () => {
    assert.equal(assessEdits(SOURCE, [edit({ find: 'nowhere at all' })]).kind, 'no-match')
  })

  it('calls a find that is gone but whose replacement is present already applied', () => {
    assert.equal(assessEdits(PATCHED, [edit()]).kind, 'already-applied')
  })

  it('does not mistake a replacement that never appears for an applied edit', () => {
    const verdict = assessEdits(SOURCE, [edit({ find: 'nowhere at all' })])
    assert.equal(verdict.kind, 'no-match')
  })

  it('calls a half-applied set partial rather than finishing it', () => {
    const edits = [edit(), edit({ find: 'const SIZE = 42;' })]
    const verdict = assessEdits(PATCHED, edits)
    assert.equal(verdict.kind, 'partial')
    assert.deepEqual(verdict, { kind: 'partial', applied: 1, total: 2 })
  })

  it('treats no edits as already applied', () => {
    assert.equal(assessEdits(SOURCE, []).kind, 'already-applied')
  })

  it('does not let an empty replacement satisfy the already-applied test', () => {
    assert.equal(assessEdits(SOURCE, [edit({ replace: '' })]).kind, 'applicable')
  })
})

describe('applyEdits', () => {
  it('replaces exactly one occurrence', () => {
    assert.equal(applyEdits(SOURCE, [edit()]), PATCHED)
  })

  it('returns undefined rather than a guess when the edit does not apply', () => {
    assert.equal(applyEdits(SOURCE, [edit({ find: 'nowhere at all' })]), undefined)
  })

  it('applies several edits in order', () => {
    const edits = [edit(), edit({ find: 'const SIZE = 42;', replace: 'const SIZE = 43;' })]
    assert.equal(applyEdits(SOURCE, edits), SOURCE.replace('42', '43').replace('expected a number', '需要一个数字'))
  })
})

describe('editProblems', () => {
  it('is empty when the edits apply', () => {
    assert.deepEqual(editProblems(SOURCE, [edit()]), [])
  })

  it('is empty when they are already applied', () => {
    assert.deepEqual(editProblems(PATCHED, [edit()]), [])
  })

  it('reports the offending edit', () => {
    const problems = editProblems(SOURCE, [edit({ find: 'nowhere at all' })])
    assert.equal(problems.length, 1)
    assert.equal(problems[0].kind, 'no-match')
  })
})

describe('describeProblem', () => {
  it('names the count when a find matches too often', () => {
    const text = describeProblem(assessEdits(SOURCE, [edit({ find: 'const' })]))
    assert.match(text, /appears 2 times/)
  })

  it('says a miss means the package is not the one the spec targeted', () => {
    const text = describeProblem(assessEdits(SOURCE, [edit({ find: 'nowhere at all' })]))
    assert.match(text, /not the build the spec was written against/)
  })

  it('counts what landed in a partial application', () => {
    const edits = [edit(), edit({ find: 'const SIZE = 42;' })]
    const text = describeProblem(assessEdits(PATCHED, edits))
    assert.match(text, /only 1 of 2 edits/)
  })

  it('says an empty find would match everywhere', () => {
    assert.match(describeProblem(assessEdits(SOURCE, [edit({ find: '' })])), /match everywhere/)
  })

  it('truncates a long find rather than printing a wall of text', () => {
    const long = 'x'.repeat(200)
    const text = describeProblem(assessEdits(SOURCE, [edit({ find: long })]))
    assert.ok(!text.includes(long), 'the whole needle should not be echoed back')
    assert.ok(text.length < 250)
  })
})

describe('read', () => {
  it('says absent when the package is not installed', () => {
    const snapshot = packageFileAdapter.read(port({ version: () => undefined }), patch())
    assert.equal(snapshot.state, 'absent')
    assert.match(String(snapshot.detail), /not installed in this profile/)
  })

  it('says unsupported, not drifted, when the version moved on', () => {
    const snapshot = packageFileAdapter.read(port({ version: () => '1.2.0' }), patch())
    assert.equal(snapshot.state, 'unsupported')
    assert.match(String(snapshot.detail), /is at 1\.2\.0, not the 1\.0\.0/)
  })

  it('says absent when the file is not in the package', () => {
    const snapshot = packageFileAdapter.read(port({ locate: () => undefined }), patch())
    assert.equal(snapshot.state, 'absent')
  })

  it('says drifted and names the command when the edit has not been applied', () => {
    const snapshot = packageFileAdapter.read(port(), patch())
    assert.equal(snapshot.state, 'drifted')
    assert.match(String(snapshot.detail), /node scripts\/apply-code-patch\.mjs --patch-id demo --pkg demo/)
  })

  it('says in-sync once the file carries the change', () => {
    const snapshot = packageFileAdapter.read(port({ readFile: () => PATCHED }), patch())
    assert.equal(snapshot.state, 'in-sync')
  })

  it('says conflict when only some of the edits landed', () => {
    const edits = [edit(), edit({ find: 'const SIZE = 42;' })]
    const snapshot = packageFileAdapter.read(port({ readFile: () => PATCHED }), patch({ op: { kind: 'code', edits } }))
    assert.equal(snapshot.state, 'conflict')
  })

  it('says conflict rather than editing when a find is ambiguous', () => {
    const snapshot = packageFileAdapter.read(port(), patch({ op: { kind: 'code', edits: [edit({ find: 'const' })] } }))
    assert.equal(snapshot.state, 'conflict')
  })

  it('refuses verify-only, which has nothing to look for on a file', () => {
    const snapshot = packageFileAdapter.read(port(), patch({ op: { kind: 'verify-only' } }) as Patch)
    assert.equal(snapshot.state, 'failed')
    assert.match(String(snapshot.detail), /not a package-file operation/)
  })

  it('still checks the version pin on a file that is otherwise fine', () => {
    const snapshot = packageFileAdapter.read(port({ version: () => '1.0.1' }), patch())
    assert.equal(snapshot.state, 'unsupported')
  })

  it('reports a read failure as failed rather than throwing', () => {
    const boom = (() => {
      throw new Error('EACCES')
    }) as PackageFilePort['readFile']
    const snapshot = packageFileAdapter.read(port({ readFile: boom }), patch())
    assert.equal(snapshot.state, 'failed')
    assert.match(String(snapshot.detail), /EACCES/)
  })

  it('refuses an operation that does not belong to this layer', () => {
    const snapshot = packageFileAdapter.read(
      port(),
      patch({ op: { kind: 'set-enabled', enabled: false } }) as unknown as Patch,
    )
    assert.equal(snapshot.state, 'failed')
    assert.match(String(snapshot.detail), /not a package-file operation/)
  })
})

describe('apply and rollback', () => {
  it('never writes, and says which command does', async () => {
    const result = await packageFileAdapter.apply(port(), patch())
    assert.equal(result.state, 'unsupported')
    assert.match(String(result.detail), /--patch-id demo --pkg demo/)
  })

  it('rolls back the same way', async () => {
    const result = await packageFileAdapter.rollback(port(), patch(), SOURCE)
    assert.equal(result.state, 'unsupported')
  })

  it('is reachable through the same call signature as the other adapters', () => {
    assert.equal(packageFileAdapter.kind, 'package-file')
    assert.equal(typeof packageFileAdapter.read, 'function')
    assert.equal(typeof packageFileAdapter.apply, 'function')
    assert.equal(typeof packageFileAdapter.rollback, 'function')
  })
})

describe('cliCommand', () => {
  it('names the patch and the package, which is all the operator needs', () => {
    const target = { kind: 'package-file', pkg: 'demo', version: '1.0.0', path: 'index.js' } as const
    assert.equal(cliCommand(patch(), target), 'node scripts/apply-code-patch.mjs --patch-id demo --pkg demo')
  })
})

describe('assessEdits: edits that insert', () => {
  // The shape an insertion takes: the anchor is kept and the new lines are put
  // on top of it. Once it lands, the find is still there — inside its own
  // replacement — which is the case a "find is gone => applied" test reads as
  // work still to do, and re-running would insert the block a second time.
  const ANCHOR = 'function view() {'
  const INSERT = {
    find: ANCHOR,
    replace: 'function helper() {}\n' + ANCHOR,
    count: 1,
  }
  const before = 'x\n' + ANCHOR + '\ny'
  const after = 'x\nfunction helper() {}\n' + ANCHOR + '\ny'

  it('calls an edit applicable while the inserted lines are absent', () => {
    assert.equal(assessEdits(before, [INSERT]).kind, 'applicable')
  })

  it('calls the same edit applied once it has landed', () => {
    assert.equal(assessEdits(after, [INSERT]).kind, 'already-applied')
  })

  it('still applies it when only the inserted lines are there twice over', () => {
    assert.equal(assessEdits(after + '\n' + after, [INSERT]).kind, 'already-applied')
  })

  it('does not mistake a coincidental repeat for a landed edit', () => {
    // Same replacement text somewhere else, the real anchor untouched: the find
    // is not inside the replace, so the edit is still work to do.
    const decoy = 'function helper() {}\n'
    assert.equal(assessEdits(before + '\n' + decoy, [INSERT]).kind, 'applicable')
  })

  it('reports a half-landed insertion instead of finishing it', () => {
    const other = { find: 'const SIZE = 42;', replace: 'const SIZE = 43;', count: 1 }
    const half = 'x\nfunction helper() {}\n' + ANCHOR + '\nconst SIZE = 42;\ny'
    assert.deepEqual(assessEdits(half, [INSERT, other]), {
      kind: 'partial',
      applied: 1,
      total: 2,
    })
  })
})
