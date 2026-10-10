import type { ApplyResult, Adapter, TargetSnapshot } from './types.ts'
import type { CodeEdit, CodeOp, PackageFileTarget, Patch, SourceFile } from '../spec/types.ts'

/**
 * The third target layer: a file inside an installed package.
 *
 * Nothing here writes. The reason is not caution, it is that the host cannot
 * win three fights at once:
 *
 * - The plugin manager installs and prunes through pnpm, and a prune pass
 *   ("Packages: +1 -46" in its operation logs) removes anything its manifest
 *   does not vouch for. A hand-edited file is exactly that.
 * - Installed files are hard links into pnpm's content-addressed store. An
 *   in-place write reaches through the link and mutates the shared copy, so
 *   the damage outlives the plugin that caused it.
 * - The plugin manager holds its own lock around the install. A second writer
 *   that does not take it produces the kind of half-installed profile that is
 *   painful to diagnose and easy to prevent.
 *
 * So the host reads the file, works out whether the edit would apply cleanly,
 * and says drifted. The write is `scripts/apply-code-patch.mjs`, a separate
 * process that does the whole pnpm-patch dance — extract, edit, syntax-check,
 * commit the patch file, register it in pnpm-workspace.yaml — and refuses to
 * do any of it unless it is the patch the spec named.
 *
 * A file a code op declares changes nothing about that. It is the same
 * question asked about a path that may not exist yet: is what is installed
 * byte-for-byte what this patch would write? The host still only reads, and
 * the same script still does the writing, under the same lock, for the same
 * reasons.
 */
export interface PackageFilePort {
  /** Installed version of a package, or undefined when it is not installed. */
  version(pkg: string): string | undefined
  /** Absolute path of a file inside an installed package, or undefined. */
  locate(pkg: string, path: string): string | undefined
  readFile(file: string): string
  /**
   * Contents of a file in *this* plugin's own package, addressed by a
   * SourceFile `source` ref: relative to this package root, under patches/.
   *
   * Kept apart from readFile because the two reach opposite sides of the
   * fence. readFile is handed an absolute path inside a package this plugin
   * has already vetted; readSource is handed a spec-supplied relative ref
   * inside this plugin's own tree. The adapter needs the second to know what
   * a declared file should look like, and a port that can only read the first
   * cannot answer it.
   */
  readSource(ref: string): string
}

/** The message of a throw, whatever it was. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Occurrences of `needle`, or -1 for the empty needle that matches everywhere. */
function countOf(text: string, needle: string): number {
  if (needle === '') return -1
  let at = text.indexOf(needle)
  let count = 0
  while (at >= 0) {
    count++
    at = text.indexOf(needle, at + needle.length)
  }
  return count
}

export type EditProblem =
  | { kind: 'no-match'; edit: CodeEdit }
  | { kind: 'many-matches'; edit: CodeEdit; count: number }
  | { kind: 'empty-find'; edit: CodeEdit }

export type EditVerdict =
  | { kind: 'applicable' }
  | { kind: 'already-applied' }
  | { kind: 'partial'; applied: number; total: number }
  | EditProblem

/**
 * What these edits would do to this text.
 *
 * The interesting case is the one a naive implementation gets wrong. Once a
 * patch has been applied, the text it looked for is gone — the file no longer
 * contains it anywhere. Reporting that as "the package is not the one the spec
 * targeted" would make an applied patch look broken forever, so a find that
 * misses while its replacement is present counts as already done.
 *
 * Half the edits landing and half not is neither. It is the state where
 * re-running the command would rewrite the ones that are not, so it gets its
 * own answer rather than being quietly finished.
 *
 * The match count is pinned at one on purpose. A replace that hits zero times
 * is a typo or a package that moved on; a replace that hits forty times is a
 * `String.replace` with no count argument, which is a bug in whoever wrote
 * the spec and not something to paper over by taking the first.
 */
/** Ascending [start, end) intervals of every occurrence, or [] for the empty needle. */
function spansOf(text: string, needle: string): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  if (needle === '') return spans
  let at = text.indexOf(needle)
  while (at >= 0) {
    spans.push([at, at + needle.length])
    at = text.indexOf(needle, at + needle.length)
  }
  return spans
}

/**
 * Whether this edit's work is already in the file.
 *
 * A find that is simply missing is the easy case, and the naive test for it
 * breaks the moment an edit *inserts* instead of replacing: an insertion is
 * written as "find this anchor, replace it with the anchor plus the new lines",
 * so after it lands the find is still there, sitting inside its own
 * replacement. Reporting that as applicable would send the operator back to the
 * CLI, which would insert the block a second time.
 *
 * So the test is containment, not absence: every occurrence of the find has to
 * lie inside an occurrence of the replace. A find present somewhere else — a
 * coincidental repeat of a short line — is not covered, and the edit still
 * counts as work to do, which is the direction that errs towards doing
 * something the operator asked for rather than towards silently skipping it.
 */
function isApplied(text: string, edit: CodeEdit): boolean {
  if (edit.replace === '') return false
  const replaces = spansOf(text, edit.replace)
  if (replaces.length === 0) return false
  return spansOf(text, edit.find).every(([start, end]) =>
    replaces.some(([from, to]) => start >= from && end <= to),
  )
}

export function assessEdits(text: string, edits: readonly CodeEdit[]): EditVerdict {
  if (edits.length === 0) return { kind: 'already-applied' }
  let applied = 0
  for (const edit of edits) {
    const found = countOf(text, edit.find)
    if (found === -1) return { kind: 'empty-find', edit }
    if (isApplied(text, edit)) {
      applied++
      continue
    }
    if (found === 0) return { kind: 'no-match', edit }
    if (found > 1) return { kind: 'many-matches', edit, count: found }
  }
  if (applied === 0) return { kind: 'applicable' }
  if (applied === edits.length) return { kind: 'already-applied' }
  return { kind: 'partial', applied, total: edits.length }
}

/** Why these edits would not do what they say, or an empty list when they would. */
export function editProblems(text: string, edits: readonly CodeEdit[]): EditProblem[] {
  const verdict = assessEdits(text, edits)
  return verdict.kind === 'applicable' || verdict.kind === 'already-applied' ? [] : [verdict]
}

function firstLine(text: string): string {
  const line = text.split('\n')[0] ?? ''
  return '"' + (line.length > 60 ? line.slice(0, 57) + '..."' : line) + '"'
}

/**
 * A file the op declares could not be read, as opposed to not matching.
 *
 * These are failures rather than drifts because the CLI cannot do anything
 * with them either: it copies the same source into the same place, so a spec
 * pointing at a source that is not there, or a destination that cannot be
 * read, is a problem to fix in the spec rather than a command to run.
 */
export type FileProblem =
  | { kind: 'unreadable-source'; ref: string; reason: string }
  | { kind: 'unreadable-file'; path: string; reason: string }

export function describeProblem(problem: EditVerdict | FileProblem): string {
  if (problem.kind === 'empty-find') {
    return 'an edit has an empty find, which would match everywhere'
  }
  if (problem.kind === 'no-match') {
    return (
      firstLine(problem.edit.find) +
      ' does not appear in the file, and neither does its replacement, so this package is not the build the spec was written against'
    )
  }
  if (problem.kind === 'many-matches') {
    return (
      firstLine(problem.edit.find) +
      ' appears ' +
      problem.count +
      ' times; this patch replaces exactly one occurrence, so the spec has to say which one rather than letting the first win'
    )
  }
  if (problem.kind === 'partial') {
    return (
      'only ' +
      problem.applied +
      ' of ' +
      problem.total +
      ' edits are already in the file. Re-running would rewrite the ones that are not; apply the rest by hand'
    )
  }
  if (problem.kind === 'unreadable-source') {
    return 'cannot read the source file ' + problem.ref + ': ' + problem.reason
  }
  if (problem.kind === 'unreadable-file') {
    return 'cannot read ' + problem.path + ' in the package: ' + problem.reason
  }
  return 'the change is not needed here'
}

/**
 * How one declared file compares with the source it is copied from.
 *
 * Byte-for-byte and nothing softer. A declared file has no upstream to diff
 * against and no other patcher is expected to be editing it, so the only
 * question worth answering is whether running the patch again would change a
 * single byte — and a trailing-newline or line-ending difference is exactly
 * as real as a rewritten function.
 */
export function fileVerdict(installed: string | undefined, source: string): 'present' | 'missing' | 'differs' {
  if (installed === void 0) return 'missing'
  return installed === source ? 'present' : 'differs'
}

/**
 * The content behind a SourceFile ref.
 *
 * The check is for a port that cannot answer the question at all, which is a
 * host that has not been given the ability to see its own files. Saying that
 * in a status detail beats letting a bare TypeError out into one, because the
 * detail is the only thing the operator is shown.
 */
function readSourceText(port: PackageFilePort, ref: string): string {
  if (typeof port.readSource !== 'function') {
    throw new Error('this host cannot read its own source files, so ' + ref + ' is out of reach')
  }
  return port.readSource(ref)
}

/**
 * What the declared files would do, judged without writing anything.
 *
 * `differs` is drifted and never a conflict, and that is the point of the
 * whole `files` feature. A declared file belongs to this patch: the spec
 * names its destination and its content lives in this repository under
 * patches/. So "what is installed is not what I wrote" is the ordinary state
 * of a patch that has not been run yet, and of the iteration where the author
 * edits the source and runs it again. Calling that a conflict would report a
 * third-party hand intervention on every pass of the normal loop, and refuse
 * to leave the operator any way to say it was them. Overwriting is the right
 * move in both cases; the honest answer to "is this in sync" is no.
 *
 * The same reasoning does not extend to the edits, where a find that misses
 * means the installed build is not the one the spec was written against, and
 * rewriting the wrong file is worse than refusing to.
 */
function assessFiles(
  port: PackageFilePort,
  target: PackageFileTarget,
  declared: readonly SourceFile[],
): { problem: FileProblem } | { drift: string[]; matched: string[] } {
  const drift: string[] = []
  const matched: string[] = []
  for (const file of declared) {
    let source: string
    try {
      source = readSourceText(port, file.source)
    } catch (error) {
      return { problem: { kind: 'unreadable-source', ref: file.source, reason: messageOf(error) } }
    }
    const at = port.locate(target.pkg, file.path)
    if (at === void 0) {
      drift.push(file.path + ' is not in the package yet')
      continue
    }
    let contents: string
    try {
      contents = port.readFile(at)
    } catch (error) {
      return { problem: { kind: 'unreadable-file', path: file.path, reason: messageOf(error) } }
    }
    if (fileVerdict(contents, source) === 'present') {
      matched.push(file.path)
      continue
    }
    // Both sizes, so the overwrite is visible rather than implied. "It
    // differs" reads like a rounding error; 120 bytes against 4 200 is a
    // different file, and the operator is the one who has to decide that is
    // what they meant.
    drift.push(
      file.path +
        ' does not match ' +
        file.source +
        ': ' +
        Buffer.byteLength(contents, 'utf8') +
        ' bytes installed, ' +
        Buffer.byteLength(source, 'utf8') +
        ' bytes in the source',
    )
  }
  return { drift, matched }
}

/** What to say when there is nothing left for the operator to do. */
function inSyncDetail(matched: readonly string[]): string {
  if (matched.length === 0) return 'the file already carries this change'
  if (matched.length === 1) return 'the file already carries this change, and ' + matched[0] + ' matches its source'
  return 'the file already carries this change, and all ' + matched.length + ' added files match their sources'
}

/** The text the edits would produce, or undefined when they do not apply. */
export function applyEdits(text: string, edits: readonly CodeEdit[]): string | undefined {
  if (assessEdits(text, edits).kind !== 'applicable') return undefined
  let out = text
  for (const edit of edits) {
    const at = out.indexOf(edit.find)
    out = out.slice(0, at) + edit.replace + out.slice(at + edit.find.length)
  }
  return out
}

function targetOf(patch: Patch): PackageFileTarget {
  if (patch.target.kind !== 'package-file') throw new Error('not a package-file target: ' + patch.target.kind)
  return patch.target
}

function codeOf(patch: Patch): CodeOp {
  if (patch.op.kind === 'code') return patch.op
  throw new Error('"' + patch.op.kind + '" is not a package-file operation')
}

/**
 * The command an operator runs to carry this patch out.
 *
 * It goes in the status detail because the page cannot run it: the host is
 * deliberately not the writer here, and a button that quietly did nothing
 * would be worse than an error the reader can act on.
 */
export function cliCommand(patch: Patch, target: PackageFileTarget): string {
  return 'node scripts/apply-code-patch.mjs --patch-id ' + patch.id + ' --pkg ' + target.pkg
}

function readPackageFile(port: PackageFilePort, patch: Patch): TargetSnapshot {
  const target = targetOf(patch)
  let op: CodeOp
  try {
    op = codeOf(patch)
  } catch (error) {
    return { state: 'failed', value: void 0, detail: messageOf(error) }
  }

  const installed = port.version(target.pkg)
  if (installed === void 0) {
    return { state: 'absent', value: void 0, detail: target.pkg + ' is not installed in this profile' }
  }
  // A version that does not match is a different situation from a file that
  // drifted, and the difference matters to whoever reads the page: nothing has
  // been tampered with, the spec is simply aimed at another build.
  if (installed !== target.version) {
    return {
      state: 'unsupported',
      value: void 0,
      detail: target.pkg + ' is at ' + installed + ', not the ' + target.version + ' this spec was written against',
    }
  }

  const file = port.locate(target.pkg, target.path)
  if (file === void 0) {
    return { state: 'absent', value: void 0, detail: target.pkg + ' has no file at ' + target.path }
  }

  let text: string
  try {
    text = port.readFile(file)
  } catch (error) {
    return { state: 'failed', value: void 0, detail: messageOf(error) }
  }

  const verdict = assessEdits(text, op.edits)

  // A conflict is the only answer the operator has to fix by hand, and it is
  // about the edits. So it is also the one that is given the detail to itself:
  // until the find matches, there is no honest comparison to make of the
  // declared files, and a detail carrying both would bury the first problem
  // under the second.
  if (verdict.kind === 'empty-find' || verdict.kind === 'many-matches' || verdict.kind === 'partial') {
    return { state: 'conflict', value: void 0, detail: describeProblem(verdict) }
  }

  // `files` is required by the type and defaulted by the schema, but a spec
  // stored before code ops could add files has no such key at all, and stored
  // specs outlive the schema that validates them.
  const declared: readonly SourceFile[] = op.files ?? []
  const files = assessFiles(port, target, declared)
  if ('problem' in files) {
    return { state: 'failed', value: void 0, detail: describeProblem(files.problem) }
  }

  const reasons: string[] = []
  if (verdict.kind === 'applicable') {
    reasons.push('the file does not carry this change yet')
  } else if (verdict.kind === 'no-match') {
    // Deliberately not followed by a command: the script refuses an edit that
    // matches zero times, so pointing at it would only make the operator run
    // something that reports the same sentence back at them.
    reasons.push(describeProblem(verdict))
  }
  reasons.push(...files.drift)

  if (reasons.length === 0) {
    return { state: 'in-sync', value: void 0, detail: inSyncDetail(files.matched) }
  }
  return {
    state: 'drifted',
    value: void 0,
    detail: reasons.join('; ') + (verdict.kind === 'no-match' ? '' : '; run ' + cliCommand(patch, target)),
  }
}

export const packageFileAdapter: Adapter<PackageFilePort, PackageFileTarget> = {
  kind: 'package-file',
  read: readPackageFile,

  async apply(_port, patch): Promise<ApplyResult> {
    return {
      state: 'unsupported',
      detail:
        'the host neither rewrites nor adds files inside an installed package; run ' +
        cliCommand(patch, targetOf(patch)) +
        ' to apply it',
      before: void 0,
    }
  },

  async rollback(_port, patch): Promise<ApplyResult> {
    return {
      state: 'unsupported',
      detail:
        'the host neither rewrites nor adds files inside an installed package; undoing this one is ' +
        cliCommand(patch, targetOf(patch)),
    }
  },
}
