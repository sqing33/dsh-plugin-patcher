/**
 * Force the reasoning-effort ladder into the active profile patch.
 *
 * A settings write alone cannot beat a loader patch: when the model list is
 * declared in the profile's cordis.patch.yml, that file is the source of truth
 * and the settings layer stays invisible. This module rewrites the patch
 * itself, so the ladder applies no matter what the file already says.
 *
 * Two things about this file are deliberate, because it arrives inside someone
 * else's package rather than inside their source tree.
 *
 * It defines its own copy of the protocol defaults instead of importing them.
 * In the built bundle they are inlined into lib/index.js and not exported, so
 * an import would have nothing to bind to; and the cost of the duplication is
 * that this file is now independent of upstream's internals, which is the
 * whole point of shipping it as a separate module. A patch that reached into
 * the bundle would break the first time upstream reorganised it.
 *
 * The rewriter is line-based and returns its input untouched when the layout
 * is not the one it recognises. A profile patch a person has rearranged by hand
 * is not ours to rewrite, and the failure mode of trying is a corrupt file that
 * stops the whole profile from loading.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PATCH_ENTRY_ID = 'llm-pi-ai'

/** Mirrors FIVE_LEVEL_EFFORTS in the upstream bundle; see the note above. */
const FIVE_LEVEL_EFFORTS = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
}
const DEFAULT_EFFORTS = { ...FIVE_LEVEL_EFFORTS }

function mergeEfforts(base, override) {
  return override === void 0 ? { ...base } : { ...base, ...override }
}

const indentOf = (line) => line.length - line.replace(/^ +/, '').length

/**
 * Render a `reasoningEfforts:` block for a model entry whose keys sit at `at`.
 *
 * The indent is derived rather than baked in. The ladder is a sibling of the
 * model's own keys, so it has to land exactly one level below the dash: the
 * live profile nests it twelve spaces deep (config > providers > nas > models
 * > `- id:`), but a profile that declares models one level higher would get
 * invalid YAML from a hardcoded twelve.
 */
function renderEffortBlock(efforts, at) {
  return [
    `${' '.repeat(at)}reasoningEfforts:`,
    ...Object.keys(efforts).map((key) => `${' '.repeat(at + 2)}${key}: ${efforts[key]}`),
  ].join('\n')
}

/**
 * Replace every declared model's reasoningEfforts with the forced ladder.
 * Returns the input unchanged when the layout is not recognized.
 */
export function normalizePatchModels(raw, efforts) {
  const lines = raw.split('\n')

  const start = lines.indexOf(`- id: ${PATCH_ENTRY_ID}`)
  if (start < 0) return raw

  let entryEnd = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^- id: /.test(lines[i])) {
      entryEnd = i
      break
    }
  }

  let modelsAt = -1
  for (let i = start; i < entryEnd; i++) {
    if (/^\s+models:\s*$/.test(lines[i])) {
      modelsAt = i
      break
    }
  }
  if (modelsAt < 0) return raw

  const dash = indentOf(lines[modelsAt + 1] ?? '')
  let stop = entryEnd
  for (let i = modelsAt + 1; i < entryEnd; i++) {
    if (lines[i].trim() === '') continue
    if (indentOf(lines[i]) < dash) {
      stop = i
      break
    }
  }

  // A model entry may start with either key: `- id:` or `- name:` (the id
  // can be appended later, at the end of the block). Treating only `- id:` as a
  // start makes the previous entry swallow the `- name:` entry, and the ladder
  // then gets moved into the wrong block, creating a second
  // `reasoningEfforts:` key there and an unparseable patch.
  const dashRe = new RegExp(`^ {${dash}}- (?:id|name): `)
  const starts = []
  for (let i = modelsAt + 1; i < stop; i++) {
    if (dashRe.test(lines[i])) starts.push(i)
  }

  const keyIndent = dash + 2
  const ladderRe = new RegExp(`^ {${keyIndent}}reasoningEfforts:\\s*$`)
  const tierRe = new RegExp(`^ {${keyIndent + 2},}\\S`)

  for (let k = starts.length - 1; k >= 0; k--) {
    const from = starts[k]
    let until = k + 1 < starts.length ? starts[k + 1] : stop

    // Drop every ladder this block already declares. A block can hold more than
    // one when an earlier run moved a neighbour's ladder in, and YAML forbids
    // duplicate mapping keys, so leaving them behind keeps the patch
    // unparseable.
    for (let i = from; i < until; i++) {
      if (!ladderRe.test(lines[i])) continue
      let end = i + 1
      while (end < until && tierRe.test(lines[end])) end++
      lines.splice(i, end - i)
      until -= end - i
      i--
    }

    let insertAt = until
    while (insertAt - 1 > from && lines[insertAt - 1].trim() === '') insertAt--
    lines.splice(insertAt, 0, ...renderEffortBlock(efforts, keyIndent).split('\n'))
  }

  return lines.join('\n')
}

/** Rewrite the profile patch so every declared model offers the forced ladder. */
export function forcePatchEffortTiers(ctx, config) {
  if (config && config.force === false) return

  try {
    // lib/ inside the installed package, so three levels up is the profile
    // directory that owns cordis.patch.yml.
    const here = dirname(fileURLToPath(import.meta.url))
    const patchFile = resolve(here, '..', '..', '..', 'cordis.patch.yml')
    if (!existsSync(patchFile)) return

    const efforts = mergeEfforts(DEFAULT_EFFORTS, config?.defaults?.efforts)
    const before = readFileSync(patchFile, 'utf8')
    const after = normalizePatchModels(before, efforts)
    if (after === before) return

    writeFileSync(patchFile, after, 'utf8')
    ctx.logger?.info?.(
      '[dsh-reasoning-effort] forced %d reasoning tier(s) into %s',
      Object.keys(efforts).length,
      patchFile,
    )
  } catch (error) {
    ctx.logger?.warn?.('[dsh-reasoning-effort] could not force effort tiers into the profile patch')
    ctx.logger?.warn?.(error)
  }
}
