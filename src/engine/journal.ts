/**
 * The write-ahead journal.
 *
 * Every write this plugin performs is journalled as one JSON line: the value
 * the target held before the write, and the value it holds after. That pair is
 * the only thing a rollback can ever use, so the file is fsynced before an
 * append resolves — a line still sitting in the page cache when the machine
 * dies is not a record, and a rollback that trusts it would restore nothing.
 *
 * The file is append-only and never rewritten. Corrupt and half-written lines
 * are skipped on read rather than thrown on: the journal is recovery
 * machinery, and a journal that refuses to open is worse than one that opens
 * with a hole in it, because the engine then has to decide the whole history is
 * untrustworthy.
 */

import { mkdir, open, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface JournalEntry {
  patchId: string
  at: string
  phase: 'before' | 'after'
  value: unknown
  reason: string
}

/**
 * What the journal knows about the most recent write of one patch.
 *
 * 'after: undefined' against a present 'before' is the signature of a crashed
 * apply: the line was durable but the write that followed it was not, so the
 * engine has to treat the target as contested rather than as unwritten.
 */
export interface JournalPair {
  before?: unknown
  after?: unknown
}

function renderKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? '.' + key : "['" + key + "']"
}

function fail(what: string, at: string): never {
  throw new TypeError('journal value contains ' + what + ' at ' + at)
}

/**
 * Reject anything JSON would silently change on the way to disk.
 *
 * JSON.stringify drops functions, turns undefined inside an array into null,
 * flattens a Map or a Set to {}, and stringifies a Date. Each of those is a
 * rollback that restores something other than what it captured, so they are
 * refused here, at the call site, naming the path — an error a human can act
 * on beats a journal that reads back clean and lies. An undefined value on a
 * plain object is the one allowed lossy case, and it is the documented
 * behaviour of JSON itself: the key is dropped.
 */
function checkValue(value: unknown, at: string, stack: readonly unknown[]): void {
  if (value === null) return
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return
    case 'number':
      // JSON.stringify turns NaN and +/-Infinity into null, silently. That is
      // the same corruption class as the cases below, so they are named too.
      if (!Number.isFinite(value)) return fail('a non-finite number', at)
      return
    case 'undefined':
      return fail('an undefined', at)
    case 'function':
      return fail('a function', at)
    case 'symbol':
      return fail('a symbol', at)
    case 'bigint':
      return fail('a bigint', at)
    default:
      break
  }
  if (value instanceof Date) return fail('a date', at)
  if (value instanceof Map) return fail('a map', at)
  if (value instanceof Set) return fail('a set', at)
  if (stack.includes(value)) return fail('a cycle', at)
  const inner = stack.concat([value])
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      checkValue(item, at + '[' + index + ']', inner)
    })
    return
  }
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (record[key] === void 0) continue
    checkValue(record[key], at + renderKey(key), inner)
  }
}

function toEntry(line: string): JournalEntry | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return void 0
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return void 0
  const record = parsed as Record<string, unknown>
  if (typeof record.patchId !== 'string' || record.patchId === '') return void 0
  if (record.phase !== 'before' && record.phase !== 'after') return void 0
  if (typeof record.at !== 'string' || typeof record.reason !== 'string') return void 0
  // A missing key means the value was undefined when the line was written.
  // That is not the same as null, and an unset's 'before' is exactly the case
  // it has to survive intact.
  return {
    patchId: record.patchId,
    at: record.at,
    phase: record.phase,
    value: 'value' in record ? record.value : void 0,
    reason: record.reason,
  }
}

function parse(raw: string): JournalEntry[] {
  const lines = raw.split('\n')
  // A crash between the write and the newline leaves the last line
  // unterminated. It was never a record, so it is dropped rather than parsed
  // as a truncated one.
  if (lines.length > 0 && lines[lines.length - 1] !== '') lines.pop()
  const entries: JournalEntry[] = []
  for (const line of lines) {
    if (line.trim() === '') continue
    const entry = toEntry(line)
    if (entry !== void 0) entries.push(entry)
  }
  return entries
}

export class Journal {
  readonly #path: string
  #prepared: Promise<void> | undefined

  constructor(path: string) {
    this.#path = path
  }

  /**
   * Create the parent directory once, and only on the first append.
   *
   * A failed attempt clears the memo so a later append retries instead of
   * replaying a stale rejection forever.
   */
  #prepare(): Promise<void> {
    const pending = this.#prepared
    if (pending !== void 0) return pending
    const attempt: Promise<void> = mkdir(dirname(this.#path), { recursive: true })
      .then(() => void 0)
      .catch((error: unknown) => {
        this.#prepared = void 0
        throw error
      })
    this.#prepared = attempt
    return attempt
  }

  /**
   * Append one line and return the entry as stored, timestamp included.
   *
   * The timestamp is assigned here rather than by the caller so that two
   * applies in the same millisecond are still ordered by their position in the
   * file, which is the only order the journal can honestly claim.
   */
  async append(entry: Omit<JournalEntry, 'at'>): Promise<JournalEntry> {
    if (entry.value !== void 0) checkValue(entry.value, '$', [])
    const stored: JournalEntry = { ...entry, at: new Date().toISOString() }
    const line = JSON.stringify(stored) + '\n'
    await this.#prepare()
    const handle = await open(this.#path, 'a')
    try {
      await handle.write(line)
      await handle.sync()
    } finally {
      await handle.close()
    }
    return stored
  }

  /** Every intact entry, oldest first. Never throws, even on a missing file. */
  async read(): Promise<JournalEntry[]> {
    let raw: string
    try {
      raw = await readFile(this.#path, 'utf8')
    } catch {
      return []
    }
    return parse(raw)
  }

  /** The most recent before/after pair for one patch, or undefined if unknown. */
  async latest(patchId: string): Promise<JournalPair | undefined> {
    return Journal.pairOf(await this.read(), patchId)
  }

  /**
   * The pairing rule, with no disk involved.
   *
   * Scans backwards for the last 'before' and then forwards for the first
   * 'after' that follows it. That asymmetry is the point: an 'after' recorded
   * *before* the last 'before' belongs to an earlier apply and must not be
   * paired with it. No following 'after' means the apply died in between, and
   * saying so is what turns a silent partial write into a reported conflict.
   */
  static pairOf(entries: readonly JournalEntry[], patchId: string): JournalPair | undefined {
    const mine = entries.filter((entry) => entry.patchId === patchId)
    if (mine.length === 0) return void 0
    let beforeIndex = -1
    for (let index = mine.length - 1; index >= 0; index -= 1) {
      if (mine[index]?.phase === 'before') {
        beforeIndex = index
        break
      }
    }
    if (beforeIndex === -1) {
      // A 'before' that never landed. The write itself may still have
      // happened, so hand back the 'after' we do have rather than claiming
      // the patch has never run.
      const after = mine.filter((entry) => entry.phase === 'after').pop()
      return after === void 0 ? void 0 : { before: void 0, after: after.value }
    }
    const before = mine[beforeIndex]?.value
    const after = mine.slice(beforeIndex + 1).find((entry) => entry.phase === 'after')
    return after === void 0 ? { before, after: void 0 } : { before, after: after.value }
  }
}
