import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  applyEdits,
  assessEdits,
  cliCommand,
  describeProblem,
  editProblems,
  fileVerdict,
  packageFileAdapter,
  type PackageFilePort,
} from '../src/adapters/package-file.ts'
import type { CodeEdit, CodeOp, Patch, SourceFile } from '../src/spec/types.ts'

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

/**
 * The content a code op declares, as it lives in this plugin's own package.
 *
 * Non-ASCII on purpose: 36 characters, 48 bytes, so a detail that counted
 * code units instead of bytes cannot pass for one that did not.
 */
const EXTRA = "export const extra = () => '需要一个补丁'\n"

/** The one file the tests below declare. */
const EXTRA_FILE: SourceFile = { path: 'lib/extra.js', source: 'patches/demo/extra.js' }

/** Where each package-relative path would live once installed. */
const INSTALLED_AT: Record<string, string> = {
  'index.js': '/demo/index.js',
  'lib/extra.js': '/demo/lib/extra.js',
}

/** What those paths hold, with the declared file already written. */
const INSTALLED: Record<string, string> = {
  '/demo/index.js': SOURCE,
  '/demo/lib/extra.js': EXTRA,
}

function port(over: Partial<PackageFilePort> = {}): PackageFilePort {
  return {
    version: () => '1.0.0',
    locate: () => '/demo/index.js',
    readFile: () => SOURCE,
    readSource: () => EXTRA,
    ...over,
  }
}

/** What an older, hand-edited copy of the declared file holds. */
const STALE = 'const stale = 1\n'

/** A port that knows the target file and the one file a code op declares. */
function filesPort(over: Partial<PackageFilePort> = {}): PackageFilePort {
  return port({
    readSource: () => EXTRA,
    locate: (_pkg, path) => INSTALLED_AT[path],
    readFile: (file) => INSTALLED[file],
    ...over,
  })
}

function codePatch(edits: readonly CodeEdit[] = [edit()], files: SourceFile[] = [EXTRA_FILE]): Patch {
  return patch({ op: { kind: 'code', edits: [...edits], files } })
}

/**
 * A code op from before ops could add files: the key is absent, not empty.
 *
 * The schema defaults it, but a spec that was typed, stored and read back
 * before the key existed never went through that schema, and the host reads
 * what is stored.
 */
function legacyPatch(over: Partial<Patch> = {}): Patch {
  return patch({ op: { kind: 'code', edits: [edit()] } as CodeOp, ...over })
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

  it('names the source ref when a declared file has nothing to copy from', () => {
    const text = describeProblem({ kind: 'unreadable-source', ref: 'patches/demo/extra.js', reason: 'ENOENT' })
    assert.match(text, /cannot read the source file patches\/demo\/extra\.js: ENOENT/)
  })

  it('names the destination when a declared file cannot be read', () => {
    const text = describeProblem({ kind: 'unreadable-file', path: 'lib/extra.js', reason: 'EISDIR' })
    assert.match(text, /cannot read lib\/extra\.js in the package: EISDIR/)
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

describe('fileVerdict', () => {
  it('calls a file that is not installed missing', () => {
    assert.equal(fileVerdict(undefined, EXTRA), 'missing')
  })

  it('calls identical contents present, two empty ones included', () => {
    assert.equal(fileVerdict(EXTRA, EXTRA), 'present')
    assert.equal(fileVerdict('', ''), 'present')
  })

  it('calls everything else differs, down to one trailing newline', () => {
    assert.equal(fileVerdict(EXTRA + '\n', EXTRA), 'differs')
    assert.equal(fileVerdict(EXTRA.trim(), EXTRA), 'differs')
  })
})

describe('read: files a code op adds', () => {
  it('says in-sync once the edits landed and every declared file matches', () => {
    const snapshot = packageFileAdapter.read(
      filesPort({ readFile: (file) => (file === '/demo/index.js' ? PATCHED : INSTALLED[file]) }),
      codePatch(),
    )
    assert.equal(snapshot.state, 'in-sync')
    assert.match(String(snapshot.detail), /lib\/extra\.js matches its source/)
  })

  it('is still drifted when every file matches but the edits have not landed', () => {
    const snapshot = packageFileAdapter.read(filesPort(), codePatch())
    assert.equal(snapshot.state, 'drifted')
    assert.match(String(snapshot.detail), /does not carry this change yet/)
    assert.match(String(snapshot.detail), /--patch-id demo --pkg demo/)
    assert.ok(!String(snapshot.detail).includes('lib/extra.js'), 'a file that matched is not part of the drift')
  })

  it('says drifted, and which file, when a declared file is not installed yet', () => {
    const snapshot = packageFileAdapter.read(
      filesPort({ locate: (_pkg, path) => (path === 'lib/extra.js' ? undefined : INSTALLED_AT[path]) }),
      codePatch(),
    )
    assert.equal(snapshot.state, 'drifted')
    assert.match(String(snapshot.detail), /lib\/extra\.js is not in the package yet/)
    assert.match(String(snapshot.detail), /apply-code-patch\.mjs/)
  })

  it('says drifted rather than conflict when an installed file is not what the source says', () => {
    // The file is this patch's own: the spec names where it goes and the
    // content lives in this repository. Divergence is the ordinary state of a
    // patch that has not been run yet, or of an author who edited the source
    // and is about to run it again. A conflict here would report a third-party
    // hand edit on every pass of that loop, and give the operator no way to
    // say it was them.
    const snapshot = packageFileAdapter.read(
      filesPort({ readFile: (file) => (file === '/demo/lib/extra.js' ? STALE : INSTALLED[file]) }),
      codePatch(),
    )
    assert.equal(snapshot.state, 'drifted')
    const detail = String(snapshot.detail)
    assert.match(detail, /lib\/extra\.js does not match patches\/demo\/extra\.js/)
    assert.match(detail, /--patch-id demo --pkg demo/)
  })

  it('gives both byte counts, so the overwrite is visible before it happens', () => {
    const snapshot = packageFileAdapter.read(
      filesPort({ readFile: (file) => (file === '/demo/lib/extra.js' ? STALE : INSTALLED[file]) }),
      codePatch(),
    )
    // 16 bytes installed against 48 in the source. The source is 36 characters
    // long, so a detail counting code units would say 36 and fail here.
    assert.match(String(snapshot.detail), /16 bytes installed, 48 bytes in the source/)
  })

  it('reports an unreadable source as failed, naming the ref', () => {
    const boom = (() => {
      throw new Error('ENOENT')
    }) as PackageFilePort['readSource']
    const snapshot = packageFileAdapter.read(filesPort({ readSource: boom }), codePatch())
    assert.equal(snapshot.state, 'failed')
    assert.match(String(snapshot.detail), /cannot read the source file patches\/demo\/extra\.js/)
    assert.match(String(snapshot.detail), /ENOENT/)
  })

  it('reports a declared file that cannot be read as failed, naming the path', () => {
    // Running the CLI would not help: it copies into the same place, so this
    // is a spec to fix rather than a command to print.
    const snapshot = packageFileAdapter.read(
      filesPort({
        readFile: (file) => {
          if (file === '/demo/lib/extra.js') throw new Error('EISDIR')
          return INSTALLED[file]
        },
      }),
      codePatch(),
    )
    assert.equal(snapshot.state, 'failed')
    assert.match(String(snapshot.detail), /cannot read lib\/extra\.js in the package: EISDIR/)
  })

  it('answers with the conflict alone, whatever the declared files say', () => {
    // The edits conflict, so that is the one thing the operator has to fix by
    // hand, and it gets the detail to itself: two problems in one sentence
    // bury the first. The files are not judged at all — there is no honest
    // comparison to make while the find does not match — which the readSource
    // below asserts, since it throws if it is ever reached.
    const edits = [edit(), edit({ find: 'const SIZE = 42;' })]
    const snapshot = packageFileAdapter.read(
      filesPort({
        readFile: (file) => (file === '/demo/index.js' ? PATCHED : STALE),
        readSource: () => {
          throw new Error('the declared files should never be consulted')
        },
      }),
      codePatch(edits),
    )
    assert.equal(snapshot.state, 'conflict')
    assert.match(String(snapshot.detail), /only 1 of 2 edits/)
    assert.ok(!String(snapshot.detail).includes('lib/extra.js'))
  })

  it('judges the files for an op that declares no edits at all', () => {
    const snapshot = packageFileAdapter.read(filesPort(), codePatch([]))
    assert.equal(snapshot.state, 'in-sync')
    assert.match(String(snapshot.detail), /lib\/extra\.js matches its source/)
  })
})

describe('read: ops written before files existed', () => {
  it('is in-sync with the same detail it always had', () => {
    const snapshot = packageFileAdapter.read(port({ readFile: () => PATCHED }), legacyPatch())
    assert.equal(snapshot.state, 'in-sync')
    assert.equal(snapshot.detail, 'the file already carries this change')
  })

  it('is drifted with the same detail it always had, command and all', () => {
    const snapshot = packageFileAdapter.read(port(), legacyPatch())
    assert.equal(snapshot.state, 'drifted')
    assert.equal(
      snapshot.detail,
      'the file does not carry this change yet; run node scripts/apply-code-patch.mjs --patch-id demo --pkg demo',
    )
  })

  it('conflicts exactly as it did, without looking for a source', () => {
    const snapshot = packageFileAdapter.read(
      port({
        readSource: () => {
          throw new Error('no source should be read')
        },
      }),
      legacyPatch({ op: { kind: 'code', edits: [edit({ find: 'const' })] } as CodeOp }),
    )
    assert.equal(snapshot.state, 'conflict')
    assert.match(String(snapshot.detail), /appears 2 times/)
  })

  it('reads the same as an op that spells out files: []', () => {
    assert.equal(
      packageFileAdapter.read(port(), codePatch([edit()], [])).detail,
      packageFileAdapter.read(port(), legacyPatch()).detail,
    )
  })
})

describe('read: the early exits ignore the declared files', () => {
  // Each of these says something about the package the *target* names, and a
  // file the op adds says nothing about it. The readSource that throws if it
  // is reached is the assertion: these states are settled before any declared
  // file is looked at, so an op that adds a file nobody can read is still
  // reported for what it is.
  const unreadable = (() => {
    throw new Error('the declared files should never be consulted')
  }) as PackageFilePort['readSource']

  it('still says absent when the package is not installed', () => {
    const snapshot = packageFileAdapter.read(filesPort({ version: () => undefined, readSource: unreadable }), codePatch())
    assert.equal(snapshot.state, 'absent')
    assert.match(String(snapshot.detail), /not installed in this profile/)
  })

  it('still says unsupported when the version moved on', () => {
    const snapshot = packageFileAdapter.read(filesPort({ version: () => '1.2.0', readSource: unreadable }), codePatch())
    assert.equal(snapshot.state, 'unsupported')
    assert.match(String(snapshot.detail), /is at 1\.2\.0, not the 1\.0\.0/)
  })

  it('still says absent when the target file is not in the package', () => {
    const snapshot = packageFileAdapter.read(filesPort({ locate: () => undefined, readSource: unreadable }), codePatch())
    assert.equal(snapshot.state, 'absent')
    assert.match(String(snapshot.detail), /has no file at index\.js/)
  })
})

describe('read: a find that misses beside a file that differs', () => {
  it('reports both problems, and no command, because the script would refuse one too', () => {
    const snapshot = packageFileAdapter.read(
      filesPort({ readFile: (file) => (file === '/demo/index.js' ? 'nothing here' : STALE) }),
      codePatch([edit({ find: 'nowhere at all' })]),
    )
    assert.equal(snapshot.state, 'drifted')
    const detail = String(snapshot.detail)
    assert.match(detail, /not the build the spec was written against/)
    assert.match(detail, /lib\/extra\.js does not match/)
    assert.ok(!detail.includes('apply-code-patch.mjs'), 'the script refuses an edit that matches nothing')
  })
})
