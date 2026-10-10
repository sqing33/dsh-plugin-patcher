import type { ApplyResult, Adapter, TargetSnapshot } from './types.ts'
import type { CodeEdit, PackageFileTarget, Patch } from '../spec/types.ts'

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
 */
export interface PackageFilePort {
  /** Installed version of a package, or undefined when it is not installed. */
  version(pkg: string): string | undefined
  /** Absolute path of a file inside an installed package, or undefined. */
  locate(pkg: string, path: string): string | undefined
  readFile(file: string): string
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
export function assessEdits(text: string, edits: readonly CodeEdit[]): EditVerdict {
  if (edits.length === 0) return { kind: 'already-applied' }
  let applied = 0
  for (const edit of edits) {
    const found = countOf(text, edit.find)
    if (found === -1) return { kind: 'empty-find', edit }
    if (found === 0) {
      if (edit.replace !== '' && countOf(text, edit.replace) > 0) {
        applied++
        continue
      }
      return { kind: 'no-match', edit }
    }
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

export function describeProblem(problem: EditVerdict): string {
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
  return (
    'only ' +
    problem.applied +
    ' of ' +
    problem.total +
    ' edits are already in the file. Re-running would rewrite the ones that are not; apply the rest by hand'
  )
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

function editsOf(patch: Patch): readonly CodeEdit[] {
  if (patch.op.kind === 'code') return patch.op.edits
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
  let edits: readonly CodeEdit[]
  try {
    edits = editsOf(patch)
  } catch (error) {
    return { state: 'failed', value: void 0, detail: error instanceof Error ? error.message : String(error) }
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
    return { state: 'failed', value: void 0, detail: error instanceof Error ? error.message : String(error) }
  }

  const verdict = assessEdits(text, edits)
  if (verdict.kind === 'already-applied') {
    return { state: 'in-sync', value: void 0, detail: 'the file already carries this change' }
  }
  if (verdict.kind === 'applicable') {
    return {
      state: 'drifted',
      value: void 0,
      detail: 'the file does not carry this change yet; run ' + cliCommand(patch, target),
    }
  }
  if (verdict.kind === 'partial') {
    return { state: 'conflict', value: void 0, detail: describeProblem(verdict) }
  }
  return {
    state: verdict.kind === 'no-match' ? 'drifted' : 'conflict',
    value: void 0,
    detail: describeProblem(verdict),
  }
}

export const packageFileAdapter: Adapter<PackageFilePort, PackageFileTarget> = {
  kind: 'package-file',
  read: readPackageFile,

  async apply(_port, patch): Promise<ApplyResult> {
    return {
      state: 'unsupported',
      detail: 'the host never rewrites an installed package; run ' + cliCommand(patch, targetOf(patch)) + ' to apply it',
      before: void 0,
    }
  },

  async rollback(_port, patch): Promise<ApplyResult> {
    return {
      state: 'unsupported',
      detail: 'the host never rewrites an installed package; undoing this one is ' + cliCommand(patch, targetOf(patch)),
    }
  },
}
