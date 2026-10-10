/**
 * The other entry point: what the patcher has to say about one plugin.
 *
 * A settings page is where a spec is written. It is not where an operator goes
 * to find out why a plugin they did not configure is behaving oddly, so the
 * same verdict is also shown on the plugin's own detail page. Both render from
 * the same host state, so the two can never disagree.
 */

import { groupTargets, toneOf, type TargetGroup } from './spec-io.ts'
import { usePatcherState } from './usePatcherState.ts'
import type { T } from './ns.ts'

/**
 * The subject the plugin detail slots hand over.
 *
 * Structural on purpose, for the same reason `SpecForm` is: this plugin has no
 * compiler on the page, and naming an upstream type here would turn a rename
 * upstream into a broken bundle. Three kinds, and only the two fields each one
 * carries.
 */
export interface DetailSubject {
  kind: 'bundle' | 'row' | 'item'
  /** The npm package, for a bundle or a row. */
  pkg?: string
  /** The row id, for a row. */
  row?: string
  /** The plugin id, for an item. */
  id?: string
}

export interface DetailProps {
  subject: DetailSubject
  t: T
}

/**
 * The patches that belong to this subject.
 *
 * A detail page is about a package, so a patch counts when it rewrites a file
 * in that package or edits that package's row. Returns an empty list for a
 * subject this plugin has nothing to say about, which is what makes the slot
 * render nothing at all instead of an empty heading.
 */
function groupsFor(subject: DetailSubject, state: ReturnType<typeof usePatcherState>): TargetGroup[] {
  if (state === undefined) return []
  const { bound } = groupTargets(state)
  if (subject.kind === 'item') {
    return bound.filter((group) =>
      (group.target.kind === 'settings' || group.target.kind === 'patch-row') &&
      matchesIdentity(group, subject.id, subject.pkg),
    )
  }
  if (subject.pkg === undefined) return []
  return bound.filter((group) => {
    const target = group.target
    if (target.kind === 'package-file') return target.pkg === subject.pkg
    if (target.kind === 'patch-row') return (group.pkg ?? target.name) === subject.pkg
    // A settings namespace belongs to a plugin, and this page is about a
    // package, so it only matches when the host vouches for the row name.
    return (group.pkg ?? target.namespace) === subject.pkg
  })
}

function matchesIdentity(group: TargetGroup, id: string | undefined, pkg: string | undefined): boolean {
  const target = group.target
  if (target.kind === 'settings') return id === target.namespace || pkg === target.namespace
  if (target.kind === 'patch-row') return id === target.rowId || pkg === target.name
  return false
}

/**
 * The badge on the plugin row: how many patches aim here, and whether any of
 * them is unhappy. Returns null for a subject with no patches, because a zero
 * badge on every plugin in the list is noise, not information.
 */
export function DetailBadge({ subject, t }: DetailProps): React.ReactElement | null {
  const state = usePatcherState()
  const groups = groupsFor(subject, state)
  if (groups.length === 0) return null
  const statuses = groups.flatMap((group) => group.patches.map((entry) => entry.status))
  const worst = statuses.find((status) => status !== undefined && status.state !== 'in-sync')
  const tone = worst === undefined ? 'ok' : toneOf(worst.state)
  return (
    <span className="pp__chip" data-tone={tone} title={worst?.detail}>
      {`${t('hint.bound')} ${groups.reduce((count, group) => count + group.patches.length, 0)}`}
    </span>
  )
}

export function DetailSection({ subject, t }: DetailProps): React.ReactElement | null {
  const state = usePatcherState()
  const groups = groupsFor(subject, state)
  if (groups.length === 0) return null
  return (
    <div className="pp__group">
      <h3 className="pp__group-title">{t('hint.boundTo')}</h3>
      {groups.map((group) => (
        <div className="pp__card" key={group.key}>
          <div className="pp__card-head">
            <span className="pp__card-title">{group.label}</span>
            {group.version !== undefined && <span className="pp__card-sub">{group.version}</span>}
          </div>
          {group.patches.map((entry) => (
            <div className="pp__patch" key={entry.patch.id}>
              <div className="pp__patch-row">
                <code className="pp__patch-id">{entry.patch.id}</code>
                {entry.status !== undefined && (
                  <span className="pp__chip" data-tone={toneOf(entry.status.state)}>
                    {t(`states.${entry.status.state}`)}
                  </span>
                )}
              </div>
              <p className="pp__patch-reason">{entry.patch.reason}</p>
              {entry.status !== undefined && entry.status.detail !== '' && (
                <p className="pp__detail">{entry.status.detail}</p>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
