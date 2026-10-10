/**
 * The patch spec, as a client would type it into the settings form.
 *
 * Everything here is plain JSON on purpose: the spec is stored in this
 * plugin's own settings namespace, so it round-trips through dsh-settings,
 * through a profile patch file, and through a YAML import/export without any
 * bespoke serialisation. Keep it that way.
 */

/** A value that is already JSON, or a request for a bundled generator. */
export interface GeneratorRequest {
  /** Id of a generator registered in src/generators/registry.ts. */
  $gen: string
  /** Generator-specific arguments; see the generator's own schema. */
  args?: Record<string, unknown>
}

/** The value an op writes. Discriminated by the presence of a `$gen` key. */
export type Value = GeneratorRequest | Json

export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json }

/** One exact-string substitution inside a package file. */
export interface CodeEdit {
  /** The exact text to find. Treated as a literal, never as a pattern. */
  find: string
  /** Replacement text. */
  replace: string
  /**
   * How many occurrences `find` must match. Always 1: a patch that is about
   * to rewrite a line of someone else's shipped bundle must fail loudly
   * rather than silently replace every occurrence.
   */
  count: 1
}

/** Rewrite one namespace of another plugin's settings. */
export interface SettingsTarget {
  kind: 'settings'
  /** The target plugin's profile entry id, i.e. its settings namespace. */
  namespace: string
}

/** Rewrite one row of the profile's cordis.patch.yml. */
export interface PatchRowTarget {
  kind: 'patch-row'
  /** The `- id:` value of the row to edit. */
  rowId: string
  /** Optional `name:` guard: refuse to edit the row unless it also matches. */
  name?: string
}

/**
 * Rewrite a file inside another plugin's installed package.
 *
 * The host only ever reads this target. Applying an edit needs pnpm, which
 * owns the node_modules tree, so scripts/apply-code-patch.mjs does it in its
 * own process.
 */
export interface PackageFileTarget {
  kind: 'package-file'
  /** The package name as it appears in the profile's dependencies. */
  pkg: string
  /** Exact installed version. A mismatch is `unsupported`, never `drifted`. */
  version?: string
  /**
   * Package-relative file path. The pattern rejects absolute paths; the
   * `..` check is `hasTraversal`, because a regex over a whole path cannot
   * say "no segment is .." without also forbidding dots inside names.
   */
  path: string
}

/**
 * A whole new file inside another plugin's package.
 *
 * Edits can only rewrite text that already exists, and secondary development
 * is mostly new code. Inlining that code in the spec would mean eighty lines
 * of JavaScript escaped into a settings row: unreadable, unlintable, and
 * impossible to review in a diff. So a code patch may also add files, with
 * the content living as a real source file inside this plugin's own package.
 *
 * This is what makes the patcher a replacement for a fork rather than a
 * recording of one: the code you write is a file in this repository, versioned
 * and reviewable like any other, and the spec is the small thing that says
 * where it goes.
 */
export interface SourceFile {
  /** Package-relative destination, with the same rules as PackageFileTarget.path. */
  path: string
  /**
   * Where the content lives, relative to this plugin's package root and
   * required to sit under `patches/`. The prefix is enforced because this
   * plugin's own source is on the other side of it.
   */
  source: string
}

/** Rewrite another plugin's package: substitute in place, and add what is new. */
export interface CodeOp {
  kind: 'code'
  /** Exact-string edits to files that already exist. May be empty. */
  edits: CodeEdit[]
  /** Whole files to add or refresh. May be empty. */
  files: SourceFile[]
}

export type Target = SettingsTarget | PatchRowTarget | PackageFileTarget

export type Op =
  /** Write a value (or a generated value) at a path. */
  | { kind: 'set'; path: string[]; value: Value }
  /** Remove a path. */
  | { kind: 'unset'; path: string[] }
  /** Merge keys into a patch row's `config:` block. */
  | { kind: 'merge-config'; config: Record<string, Json> }
  /** Enable or disable a patch row, through the plugin manager's own API. */
  | { kind: 'set-enabled'; enabled: boolean }
  /** Apply code edits to an installed package. */
  | CodeOp
  /** Assert a target's current shape without writing anything. */
  | { kind: 'verify-only' }

export interface Patch {
  /** Stable id, unique within the spec; the journal is keyed by it. */
  id: string
  /** false = roll this patch back instead of applying it. */
  enabled: boolean
  /** Why this patch exists. Required, and shown verbatim in the settings page. */
  reason: string
  target: Target
  op: Op
}

export interface PatcherConfig {
  patches: Patch[]
  /**
   * Bumped by the settings page to force a full re-reconcile. The host treats
   * any change as "recompute everything from scratch", so a client needs no
   * separate control channel.
   */
  reconcileNonce: number
  /**
   * Whether anyone has ever decided what this namespace should contain.
   *
   * A fresh install and an operator who deleted every patch look identical in
   * `patches` — both are an empty list — and only one of them means "back to
   * the defaults". This flag is the difference, and it is durable: once the
   * host has seeded the built-in defaults it never seeds again, so emptying
   * the list is a decision rather than an accident. Nothing else reads it,
   * and the settings page never writes it.
   */
  initialized: boolean
}

export const PATCH_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/
export const PACKAGE_PATH_PATTERN = /^[^/\\][^\\\0]*$/
/** Where a SourceFile's content lives: inside this plugin, under patches/. */
export const SOURCE_PATTERN = /^patches\/[^/\\][^\\\0]*$/

/**
 * Whether a relative path climbs out of the directory it is resolved against.
 *
 * The patterns above reject absolute paths and backslashes but happily accept
 * `..` and `a/../b`, which is why this is a separate check rather than
 * another regex: "no segment equals .." is a property of the segments, and a
 * pattern over the joined string cannot express it without also forbidding
 * dots inside ordinary file names.
 */
export function hasTraversal(path: string): boolean {
  return path.split('/').some((segment) => segment === '..')
}

/** The ops that address a sub-path of their target. */
export function opPath(op: Op): string[] | undefined {
  return 'path' in op ? op.path : undefined
}
