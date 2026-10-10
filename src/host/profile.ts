/**
 * Where this plugin's own files live inside a DSH profile.
 *
 * The host does not hand a third-party plugin its profile directory, but the
 * install layout is not a secret: a bundle sits at
 * <profile>/node_modules/<name>/ and nothing else in that path is meaningful.
 * So the profile directory is derived from where this very module was loaded
 * from, and **not guessed** when the layout is unrecognised — every caller
 * turns undefined into a disabled capability with a readable reason, because
 * writing into a path we merely believe is the profile is exactly the failure
 * mode this plugin exists to prevent.
 */

import { join } from 'node:path'

/**
 * Walk up from a loaded module's file URL to the directory that contains the
 * node_modules it was installed into.
 *
 * @returns the profile directory, or undefined when the module was not loaded
 * from a node_modules tree (a bundled or linked development checkout).
 */
export function profileDirFrom(moduleUrl: string): string | undefined {
  let path = moduleUrl
  if (path.startsWith('file://')) {
    try {
      path = decodeURIComponent(path.slice('file://'.length))
    } catch {
      // A malformed escape tells us nothing useful; the scan below still runs
      // on the raw text and either matches or does not.
    }
  }
  // A Windows path is not a posix path. Guessing one would produce a path
  // that looks plausible and addresses the wrong filesystem, so refuse it.
  if (path.includes('\\') || /^\/[A-Za-z]:/.test(path)) return undefined
  const parts = path.split('/')
  const at = parts.lastIndexOf('node_modules')
  if (at < 1) return undefined
  return parts.slice(0, at).join('/')
}

/** The profile patch file every third-party row and settings namespace lands in. */
export function patchPathOf(profileDir: string | undefined): string | undefined {
  return profileDir === undefined ? undefined : join(profileDir, 'cordis.patch.yml')
}

/** Where the before/after journal is kept, beside the patch file it guards. */
export function journalPathOf(profileDir: string | undefined): string | undefined {
  return profileDir === undefined ? undefined : join(profileDir, 'plugin-patcher', 'journal.jsonl')
}
