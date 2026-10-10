/**
 * Editing a row in the profile's cordis.patch.yml.
 *
 * Two things make this file different from everything else the patcher writes,
 * and both are reasons this module does text surgery instead of parsing and
 * re-emitting.
 *
 * **Other people own it.** That file is the profile's own configuration, and
 * three separate things write to it: the operator by hand, the plugin manager
 * on every enable/disable, and other plugins that declare loader patches. A
 * parse-then-dump round trip would silently reflow every comment in the file
 * and could reorder keys, which turns "the patcher added a line" into "the
 * patcher rewrote my profile". So this module only ever replaces the bytes
 * between its own markers; every other byte of the file is copied verbatim.
 *
 * **The manager owns the `disabled:` line.** `ctx.pluginManager.setPluginEnabled`
 * does not touch settings.yaml — it calls `writePluginEnabled(patchPath, ...)`,
 * which parses the document, flips the key and rewrites the whole file. If this
 * adapter also rewrote `disabled:` by hand, the two writers would race and one
 * would win silently. So `set-enabled` goes through the official API, always,
 * and this module only reads the key back to decide whether there is drift.
 *
 * What the markers mean, and why they sit under `config:`:
 *
 *   - id: some-plugin
 *     name: dsh-some-plugin
 *     config:
 *       aKey: 1
 *       # dsh-plugin-patcher begin managed for my-patch
 *       myKey: myValue
 *       # dsh-plugin-patcher end managed for my-patch
 *
 * The block has to live under `config:` because YAML forbids a mapping from
 * carrying the same key twice, and a second top-level `config:` would leave the
 * file unparseable. The patch id is inside the marker so a block left behind by
 * a renamed or deleted patch is recognisable as somebody else's, rather than
 * being silently adopted and then "rolled back" to a value nobody chose.
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs'

import type { ApplyResult, Adapter, TargetSnapshot } from './types.ts'
import { parse, stringify } from 'yaml'

import type { Json, Patch, PatchRowTarget } from '../spec/types.ts'
import { fingerprintOf } from '../engine/fingerprint.ts'

/**
 * Everything this adapter needs from the host, and nothing else.
 *
 * The file is read as text rather than parsed, and enablement is delegated
 * rather than reimplemented, so the tests here need a directory and a one-line
 * fake — not a cordis context.
 */
export interface PatchRowPort {
  /** The profile's cordis.patch.yml, as UTF-8 text. */
  readPatchText(): string
  /** Replace the file. Implementations must not leave a truncated file behind. */
  writePatchText(text: string): void
  /**
   * Persist a row's enablement through the plugin manager and let it reconcile.
   *
   * Rejects with a `ManagementFailure` carrying a `code` of
   * 'unknown-plugin' | 'unaddressable' | 'management-required' |
   * 'incompatible-version' when the row cannot be driven that way.
   */
  setRowEnabled(rowId: string, enabled: boolean): Promise<void>
}

const BEGIN = '# dsh-plugin-patcher begin managed for '
const END = '# dsh-plugin-patcher end managed for '

/** ManagementFailure codes meaning "this row is not addressable", not "it broke". */
const UNADDRESSABLE = new Set([
  'unknown-plugin',
  'unaddressable',
  'management-required',
  'incompatible-version',
])

const indentOf = (line: string): number => line.length - line.replace(/^[ \t]*/, '').length
const isSkippable = (line: string): boolean => line.trim() === '' || line.trimStart().startsWith('#')

/** A located row: the line that opens it, the line past its last, and its shape. */
interface RowSpan {
  start: number
  /** Exclusive. */
  end: number
  /** Indent of the row's own keys, e.g. 2 for "- id: x" followed by "  name: y". */
  keyIndent: number
  /** Indent of the row's `config:` children. */
  childIndent: number
}

/**
 * The one row a loader patch entry with this id actually applies to.
 *
 * Two rules, both taken from the profile boot contract rather than invented
 * here. Only the file's top level counts: an `- insert:` row's nested entries
 * are insertions into a bundle layer, and the plugin manager's own writer walks
 * the top-level sequence only, so following a nested `- id:` would address a
 * row nothing else here can drive. And when a file declares the same id twice
 * the later row wins — the manager scans with `findLast`, so taking the first
 * match would make the patcher report drift against a row that is not in effect.
 */
function findRow(lines: string[], rowId: string): RowSpan | undefined {
  const first = lines.find((line) => /^[ \t]*- /.test(line))
  if (first === undefined) return void 0
  const topIndent = indentOf(first)

  let start = -1
  for (let i = 0; i < lines.length; i++) {
    const match = /^([ \t]*)- id:[ \t]*(.*)$/.exec(lines[i]!)
    if (match === null || match[1]!.length !== topIndent) continue
    if (unquote(match[2]!.trim()) !== rowId) continue
    start = i
  }
  if (start < 0) return void 0

  // Two passes, and the order matters. Finding the row's end is a scan that
  // runs to the next top-level row; finding its key indent is a question about
  // the first key inside that range. Doing both in one loop meant the first key
  // line ended the scan, the row ran to the end of the file, and a `disabled:`
  // key from a later row answered for this one.
  const dashIndent = topIndent
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (isSkippable(lines[i]!)) continue
    if (indentOf(lines[i]!) <= dashIndent) {
      end = i
      break
    }
  }

  let keyIndent = dashIndent + 2
  for (let i = start + 1; i < end; i++) {
    if (isSkippable(lines[i]!)) continue
    keyIndent = indentOf(lines[i]!)
    break
  }

  const step = Math.max(keyIndent - dashIndent, 2)
  return { start, end, keyIndent, childIndent: keyIndent + step }
}

function unquote(value: string): string {
  const quoted = /^(['"])([\s\S]*)\1$/.exec(value)
  return quoted === null ? value : quoted[2]!
}

function scalarAt(lines: string[], span: RowSpan, key: string): string | undefined {
  const re = new RegExp('^ {' + span.keyIndent + '}' + key + ':[ \t]*(.*)$')
  for (let i = span.start + 1; i < span.end; i++) {
    const match = re.exec(lines[i]!)
    if (match !== null) return unquote(match[1]!.trim())
  }
  return void 0
}

/**
 * Whether the row is currently enabled, as the profile file will act on it.
 *
 * A row that says nothing about `disabled:` is enabled, so an absent key is a
 * definite answer rather than an unknown one. Reporting unknown here would make
 * the patcher claim drift on every row nobody ever touched.
 */
function rowEnabled(lines: string[], span: RowSpan): boolean {
  return scalarAt(lines, span, 'disabled') !== 'true'
}

/** Where the row's `config:` mapping starts, and whether it is an empty inline map. */
function configAt(lines: string[], span: RowSpan): { at: number; inline: boolean } | undefined {
  const re = new RegExp('^ {' + span.keyIndent + '}config:[ \t]*(.*)$')
  for (let i = span.start + 1; i < span.end; i++) {
    const match = re.exec(lines[i]!)
    if (match === null) continue
    const rest = match[1]!.trim()
    // A config carrying an inline value the patcher did not write is left
    // alone: rewriting it would be a guess about what the operator meant.
    if (rest !== '' && rest !== '{}' && rest !== 'null') return { at: i, inline: false }
    return { at: i, inline: rest !== '' }
  }
  return void 0
}

/** The managed block this patch owns, as line indices. `end` is exclusive. */
function findBlock(
  lines: string[],
  span: RowSpan,
  patchId: string,
): { start: number; end: number } | undefined | 'malformed' {
  let open = -1
  for (let i = span.start; i < span.end; i++) {
    const line = lines[i]!.trim()
    if (!line.startsWith(BEGIN)) continue
    if (line !== BEGIN + patchId || open >= 0) return 'malformed'
    open = i
  }
  if (open < 0) return void 0
  for (let i = open + 1; i < span.end; i++) {
    if (lines[i]!.trim() === END + patchId) return { start: open, end: i + 1 }
  }
  return 'malformed'
}

function parseBlock(lines: string[], block: { start: number; end: number }, childIndent: number): Json {
  const text = lines.slice(block.start + 1, block.end - 1).map((line) => line.slice(childIndent)).join('\n')
  if (text.trim() === '') return {}
  return parse(text) as Json
}

function renderBlock(config: Json, patchId: string, childIndent: number): string[] {
  const key = ' '.repeat(childIndent)
  const body = stringify(config, { indent: 2, lineWidth: 0 })
    .replace(/\n$/, '')
  return [
    key + BEGIN + patchId,
    ...(body === '' ? [] : body.split('\n').map((line) => key + line)),
    key + END + patchId,
  ]
}

/**
 * The line a new key should be inserted before: just past the row's last real
 * line. Blank lines and comments that trail a row belong to the space around
 * it, not to the row, so a row followed by an explanatory comment gets its
 * block written above the comment rather than below it.
 */
function insertionPoint(lines: string[], span: RowSpan): number {
  let at = span.end
  while (at > span.start + 1 && isSkippable(lines[at - 1]!)) at--
  return at
}

/** Put `config` into this patch's block, creating the block and `config:` if needed. */
function writeBlock(text: string, rowId: string, patchId: string, config: Json): string {
  const lines = text.split('\n')
  const span = findRow(lines, rowId)
  if (span === undefined) throw new Error(`cordis.patch.yml has no row with id "${rowId}"`)

  const block = findBlock(lines, span, patchId)
  if (block === 'malformed') {
    throw new Error(
      `row "${rowId}" already holds a managed block that is malformed or belongs to a different patch`,
    )
  }

  const rendered = renderBlock(config, patchId, span.childIndent)
  if (block !== void 0) {
    lines.splice(block.start, block.end - block.start, ...rendered)
    return lines.join('\n')
  }

  // Not span.end. That index is where the *next* row starts, so a row
  // followed by a comment the operator wrote about it would have the block
  // spliced in below its own comment.
  const at = insertionPoint(lines, span)
  const configKey = configAt(lines, span)
  if (configKey === void 0) {
    lines.splice(at, 0, ' '.repeat(span.keyIndent) + 'config:', ...rendered)
    return lines.join('\n')
  }
  if (configKey.inline) {
    // "config: {}" leaves no room for a block. Opening it up is a one-line
    // change to a key the patcher is about to use anyway.
    lines[configKey.at] = ' '.repeat(span.keyIndent) + 'config:'
    lines.splice(configKey.at + 1, 0, ...rendered)
    return lines.join('\n')
  }
  lines.splice(at, 0, ...rendered)
  return lines.join('\n')
}

/** Take the block out again, leaving the rest of the row exactly as it was. */
function eraseBlock(text: string, rowId: string, patchId: string): string {
  const lines = text.split('\n')
  const span = findRow(lines, rowId)
  if (span === undefined) return text
  const block = findBlock(lines, span, patchId)
  if (block === 'malformed') {
    throw new Error(`row "${rowId}" holds a managed block this patch does not own`)
  }
  if (block === void 0) return text
  lines.splice(block.start, block.end - block.start)
  return lines.join('\n')
}

function stateOfError(error: unknown): { state: 'unsupported' | 'failed'; detail: string } {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code
    : void 0
  if (typeof code === 'string' && UNADDRESSABLE.has(code)) {
    return { state: 'unsupported', detail: `the plugin manager refused this row: ${code}` }
  }
  return { state: 'failed', detail: error instanceof Error ? error.message : String(error) }
}

function targetOf(patch: Patch): PatchRowTarget {
  if (patch.target.kind !== 'patch-row') throw new Error(`not a patch-row target: ${patch.target.kind}`)
  return patch.target
}

function readRow(port: PatchRowPort, patch: Patch): TargetSnapshot {
  const target = targetOf(patch)
  const lines = port.readPatchText().split('\n')
  const span = findRow(lines, target.rowId)
  if (span === undefined) {
    return {
      state: 'absent',
      value: void 0,
      detail: `cordis.patch.yml has no row with id "${target.rowId}"`,
    }
  }

  const named = scalarAt(lines, span, 'name')
  if (target.name !== void 0 && named !== target.name) {
    return {
      state: 'conflict',
      value: void 0,
      detail: `row "${target.rowId}" names ${named === void 0 ? 'nothing' : '"' + named + '"'} rather than "${target.name}"`,
    }
  }

  if (patch.op.kind === 'set-enabled') {
    const enabled = rowEnabled(lines, span)
    return {
      state: enabled === patch.op.enabled ? 'in-sync' : 'drifted',
      value: enabled,
      detail: `the row is currently ${enabled ? 'enabled' : 'disabled'}`,
    }
  }
  if (patch.op.kind !== 'merge-config' && patch.op.kind !== 'verify-only') {
    return { state: 'failed', value: void 0, detail: `"${patch.op.kind}" is not a patch-row operation` }
  }

  const block = findBlock(lines, span, patch.id)
  if (block === 'malformed') {
    return {
      state: 'conflict',
      value: void 0,
      detail: `row "${target.rowId}" holds a managed block for a different patch, or one missing its end marker`,
    }
  }
  if (patch.op.kind === 'verify-only') {
    return {
      state: 'in-sync',
      value: void 0,
      detail: block === void 0 ? 'there is nothing of ours to check' : 'checked without writing',
    }
  }

  const current = block === void 0 ? void 0 : parseBlock(lines, block, span.childIndent)
  // Key order is not a difference worth reporting: two configs that differ only
  // in the order their keys were written are the same config.
  const inSync = fingerprintOf(current ?? {}) === fingerprintOf(patch.op.config)
  return {
    state: inSync ? 'in-sync' : 'drifted',
    value: current,
    detail: block === void 0
      ? 'the patcher has not written this row yet'
      : inSync ? 'the managed block matches the spec' : 'the managed block differs from the spec',
  }
}

export const patchRowAdapter: Adapter<PatchRowPort, PatchRowTarget> = {
  kind: 'patch-row',
  read: readRow,

  async apply(port, patch): Promise<ApplyResult> {
    const target = targetOf(patch)
    const before = readRow(port, patch)

    if (patch.op.kind === 'verify-only') {
      return { state: 'in-sync', detail: 'verify-only never writes', before: before.value }
    }
    if (patch.op.kind === 'set-enabled') {
      try {
        await port.setRowEnabled(target.rowId, patch.op.enabled)
      } catch (error) {
        const mapped = stateOfError(error)
        return { state: mapped.state, detail: mapped.detail, before: before.value }
      }
      const after = readRow(port, patch)
      return {
        state: after.state,
        detail: after.state === 'in-sync'
          ? `the row is now ${patch.op.enabled ? 'enabled' : 'disabled'}`
          : `the plugin manager accepted the change but the row still reads: ${after.detail}`,
        before: before.value,
      }
    }
    if (patch.op.kind !== 'merge-config') {
      return { state: 'failed', detail: `"${patch.op.kind}" is not a patch-row operation`, before: before.value }
    }

    let next: string
    try {
      next = writeBlock(port.readPatchText(), target.rowId, patch.id, patch.op.config)
    } catch (error) {
      // A row holding another patch's block, or a block missing its end marker,
      // is something to report. The host must never see this throw.
      return {
        state: 'failed',
        detail: error instanceof Error ? error.message : String(error),
        before: before.value,
      }
    }
    const text = port.readPatchText()
    if (next === text) return { state: 'in-sync', detail: 'the file already said this', before: before.value }
    try {
      port.writePatchText(next)
    } catch (error) {
      const mapped = stateOfError(error)
      return { state: mapped.state, detail: mapped.detail, before: before.value }
    }
    return { state: 'in-sync', detail: 'the managed block was written', before: before.value }
  },

  async rollback(port, patch, before): Promise<ApplyResult> {
    const target = targetOf(patch)
    if (patch.op.kind === 'set-enabled') {
      if (typeof before !== 'boolean') {
        return { state: 'failed', detail: 'the journal holds no recorded enablement for this row' }
      }
      try {
        await port.setRowEnabled(target.rowId, before)
      } catch (error) {
        const mapped = stateOfError(error)
        return { state: mapped.state, detail: mapped.detail }
      }
      return { state: 'in-sync', detail: `the row was set back to ${before ? 'enabled' : 'disabled'}` }
    }
    if (patch.op.kind !== 'merge-config') {
      return { state: 'failed', detail: `"${patch.op.kind}" cannot be rolled back by this adapter` }
    }

    const text = port.readPatchText()
    let next: string
    try {
      next = before === void 0
        ? eraseBlock(text, target.rowId, patch.id)
        : writeBlock(text, target.rowId, patch.id, before as Json)
    } catch (error) {
      const mapped = stateOfError(error)
      return { state: mapped.state, detail: mapped.detail }
    }
    if (next === text) return { state: 'in-sync', detail: 'the file already said this' }
    port.writePatchText(next)
    return {
      state: 'in-sync',
      detail: before === void 0 ? 'the managed block was removed' : 'the previous managed block was restored',
    }
  },
}

/**
 * The real port, over one file.
 *
 * The write goes to a sibling temporary file and is renamed into place. A
 * half-written profile patch file is not a degraded profile, it is an
 * unbootable one, and rename is the only way to make that impossible here.
 */
export function patchRowFilePort(
  patchPath: string,
  setRowEnabled: (rowId: string, enabled: boolean) => Promise<void>,
): PatchRowPort {
  return {
    readPatchText() {
      return readFileSync(patchPath, 'utf8')
    },
    writePatchText(text) {
      const temporary = patchPath + '.dsh-plugin-patcher.tmp'
      writeFileSync(temporary, text, 'utf8')
      renameSync(temporary, patchPath)
    },
    setRowEnabled,
  }
}
