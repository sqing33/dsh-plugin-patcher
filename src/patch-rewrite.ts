/**
 * Force the reasoning ladder into the active profile patch.
 *
 * A settings write alone cannot beat a loader patch: when the model list is
 * declared in the profile's cordis.patch.yml, that file is the source of truth
 * and the settings layer stays invisible. This module rewrites the patch
 * itself, so the ladder applies no matter what the file already says.
 *
 * Hardened relative to the reference implementation: the rewrite goes to a
 * temporary file and is renamed into place, and the untouched original is kept
 * as a one-time backup. A partial write here would truncate a user-authored
 * profile configuration.
 */

import { copyFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { defaultEffortsFor, mergeEfforts } from './ladder.ts'
import { recordError, recordPatchWrite } from './status.ts'
import type { Efforts, LadderConfig } from './reasoning-settings.ts'

const PATCH_ENTRY_ID = 'llm-pi-ai'
const LOG_PREFIX = '[dsh-reasoning-ladder]'

const indentOf = (line: string): number => line.length - line.replace(/^ +/, '').length

function renderEffortBlock(efforts: Efforts, rungIndent: number): string {
  const key = ' '.repeat(rungIndent)
  const value = ' '.repeat(rungIndent + 2)
  return [
    key + 'reasoningEfforts:',
    ...Object.keys(efforts).map((name) => value + name + ': ' + efforts[name]),
  ].join('\n')
}

/**
 * Rewrite one provider's model list, in place.
 *
 * `modelsAt` points at the `models:` key; the list runs from there to the
 * first line indented less than the `- id:` items. Returns the number of
 * model entries touched.
 */
function rewriteModelBlock(
  lines: string[],
  modelsAt: number,
  entryEnd: number,
  efforts: Efforts,
): number {
  const dash = indentOf(lines[modelsAt + 1] ?? '')
  if (dash === 0) return 0

  let stop = entryEnd
  for (let i = modelsAt + 1; i < entryEnd; i++) {
    if (lines[i]!.trim() === '') continue
    if (indentOf(lines[i]!) < dash) {
      stop = i
      break
    }
  }

  const dashRe = new RegExp('^ {' + dash + '}- id: ')
  const starts: number[] = []
  for (let i = modelsAt + 1; i < stop; i++) {
    if (dashRe.test(lines[i]!)) starts.push(i)
  }
  if (starts.length === 0) return 0

  // Walk back to front so the splices below never invalidate a later index.
  for (let k = starts.length - 1; k >= 0; k--) {
    const from = starts[k]!
    const until = k + 1 < starts.length ? starts[k + 1]! : stop

    const rungIndent = dash + 2
    const rungRe = new RegExp('^ {' + rungIndent + '}reasoningEfforts:\\s*$')
    const valueRe = new RegExp('^ {' + (rungIndent + 2) + ',}\\S')

    let cutAt = -1
    let cutTo = -1
    for (let i = from; i < until; i++) {
      if (rungRe.test(lines[i]!)) {
        cutAt = i
        cutTo = i + 1
        while (cutTo < until && valueRe.test(lines[cutTo]!)) cutTo++
        break
      }
    }

    let insertAt = until
    while (insertAt - 1 > from && lines[insertAt - 1]!.trim() === '') insertAt--

    if (cutAt >= 0) {
      lines.splice(cutAt, cutTo - cutAt)
      insertAt -= cutTo - cutAt
    }
    lines.splice(insertAt, 0, ...renderEffortBlock(efforts, rungIndent).split('\n'))
  }

  return starts.length
}

/**
 * Replace every declared model's reasoningEfforts with the forced ladder.
 * Returns the input unchanged when the layout is not recognized.
 *
 * A patch entry can declare several providers, each with its own `models:`
 * list. Every one of them is rewritten — stopping after the first would leave
 * the remaining providers on whatever ladder the file already had.
 */
export function normalizePatchModels(raw: string, efforts: Efforts): string {
  const lines = raw.split('\n')

  const start = lines.indexOf('- id: ' + PATCH_ENTRY_ID)
  if (start < 0) return raw

  let entryEnd = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^- id: /.test(lines[i]!)) {
      entryEnd = i
      break
    }
  }

  const modelsAt: number[] = []
  for (let i = start; i < entryEnd; i++) {
    if (/^\s+models:\s*$/.test(lines[i]!)) modelsAt.push(i)
  }
  if (modelsAt.length === 0) return raw

  for (let k = modelsAt.length - 1; k >= 0; k--) {
    rewriteModelBlock(lines, modelsAt[k]!, entryEnd, efforts)
  }

  return lines.join('\n')
}

/** How many model entries the llm-pi-ai patch entry declares in total. */
export function countPatchModels(raw: string): number {
  const lines = raw.split('\n')
  const start = lines.indexOf('- id: ' + PATCH_ENTRY_ID)
  if (start < 0) return 0

  let entryEnd = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^- id: /.test(lines[i]!)) {
      entryEnd = i
      break
    }
  }

  let total = 0
  for (let i = start; i < entryEnd; i++) {
    if (!/^\s+models:\s*$/.test(lines[i]!)) continue
    const dash = indentOf(lines[i + 1] ?? '')
    if (dash === 0) continue
    const dashRe = new RegExp('^ {' + dash + '}- id: ')
    for (let j = i + 1; j < entryEnd; j++) {
      if (lines[j]!.trim() === '') continue
      if (indentOf(lines[j]!) < dash) break
      if (dashRe.test(lines[j]!)) total += 1
    }
  }
  return total
}

/** Absolute path of the profile patch this plugin owns. */
export function resolvePatchFile(moduleUrl: string): string {
  const here = dirname(fileURLToPath(moduleUrl))
  return resolve(here, '..', '..', '..', 'cordis.patch.yml')
}

function atomicWrite(target: string, content: string): void {
  const temp = target + '.ladder-tmp'
  try {
    writeFileSync(temp, content, 'utf8')
    renameSync(temp, target)
  } catch (error) {
    if (existsSync(temp)) {
      try {
        unlinkSync(temp)
      } catch {
        // Best-effort cleanup: the original failure is the one worth reporting,
        // and a failed rename usually means the target itself is gone.
      }
    }
    throw error
  }
}

/**
 * Rewrite the profile patch so every declared model offers the forced ladder.
 * Returns the number of model entries rewritten, or 0 when there was nothing
 * to do. Never throws: a failure is logged and recorded in the status.
 */
export function forcePatchEffortTiers(ctx: Context, config: LadderConfig = {}): number {
  if (config.force === false) return 0

  let patchFile: string
  try {
    patchFile = resolvePatchFile(import.meta.url)
  } catch (error) {
    ctx.logger?.warn?.(LOG_PREFIX + ' could not resolve the profile patch path')
    ctx.logger?.warn?.(recordError(error, 'could not resolve the profile patch path'))
    return 0
  }
  if (!existsSync(patchFile)) return 0

  try {
    const efforts = mergeEfforts(defaultEffortsFor(config.defaults?.api), config.defaults?.efforts)
    const before = readFileSync(patchFile, 'utf8')
    const after = normalizePatchModels(before, efforts)
    if (after === before) return 0

    const backupFile = patchFile + '.ladder-backup'
    if (!existsSync(backupFile)) copyFileSync(patchFile, backupFile)
    atomicWrite(patchFile, after)

    const rewritten = countPatchModels(after)
    recordPatchWrite(patchFile, backupFile, rewritten)
    ctx.logger?.info?.(
      '%s forced %d reasoning tier(s) onto %d model(s) in %s',
      LOG_PREFIX,
      Object.keys(efforts).length,
      rewritten,
      patchFile,
    )
    return rewritten
  } catch (error) {
    ctx.logger?.warn?.(LOG_PREFIX + ' could not force effort tiers into the profile patch')
    ctx.logger?.warn?.(recordError(error, 'could not rewrite the profile patch'))
    return 0
  }
}
