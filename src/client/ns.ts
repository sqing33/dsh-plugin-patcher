/**
 * The names the browser half and the host half must agree on.
 *
 * One string serves three roles: the settings namespace holding the spec, the
 * row id in the profile patch file, and the dictionary namespace of this page's
 * copy. scripts/verify-package.mjs asserts the client value equals the host's
 * exported name, because a mismatch here fails silently in the worst way: the
 * host watches a namespace nobody writes, and the page writes one nobody reads.
 */

export const NAMESPACE = 'dsh-plugin-patcher'

/** The order in the settings navigation; the shell owns the sequence, not this page. */
export const SECTION_ORDER = 30

/** A translate function, typed to what the locale face hands a registrant. */
export type T = (key: string, params?: Record<string, string | number>) => string

/** Every state a patch can report, in the order the page shows them. */
export const STATE_ORDER = [
  'in-sync',
  'drifted',
  'conflict',
  'unsupported',
  'absent',
  'failed',
  'pending',
] as const
