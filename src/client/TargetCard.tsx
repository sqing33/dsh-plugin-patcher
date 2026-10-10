/** One target and every patch aimed at it. */

import type { Patch } from '../spec/types.ts'
import type { PatcherStatus } from '../adapters/types.ts'
import { toneOf, type TargetGroup } from './spec-io.ts'
import type { T } from './ns.ts'

export interface TargetCardProps {
  t: T
  group: TargetGroup
  /** True for the list of targets nobody patched yet. */
  unclaimed?: boolean
  onEdit: (patch: Patch) => void
  onRemove: (patch: Patch) => void
  onToggle: (patch: Patch) => void
  onBind: () => void
}

/**
 * The states are the host's vocabulary and the hints are the page's, so the
 * two do not share a key: `drifted` needs a line that says what drifted.
 */
const HINT_KEY: Partial<Record<PatcherStatus['state'], string>> = {
  drifted: 'hint.drift',
  unsupported: 'hint.unsupported',
  absent: 'hint.absent',
  conflict: 'hint.conflict',
  failed: 'hint.failed',
}

function Chip({ t, status }: { t: T; status: PatcherStatus | undefined }): React.ReactElement | null {
  if (status === undefined) return null
  return (
    <span className="pp__chip" data-tone={toneOf(status.state)}>
      {t(`states.${status.state}`)}
    </span>
  )
}

export function TargetCard({ t, group, unclaimed, onEdit, onRemove, onToggle, onBind }: TargetCardProps): React.ReactElement {
  if (unclaimed === true) {
    return (
      <div className="pp__card pp__card--quiet">
        <div className="pp__card-head">
          <span className="pp__card-title">{group.label}</span>
          <span className="pp__card-sub">{group.version ?? t('inventoryNote')}</span>
        </div>
        <div className="pp__actions">
          <button type="button" className="pp__btn" data-variant="primary" onClick={onBind}>
            {t('action.bind')}
          </button>
        </div>
      </div>
    )
  }
  return (
    <div className="pp__card" data-unknown={group.unknown ? 'true' : 'false'}>
      <div className="pp__card-head">
        <span className="pp__card-title">{group.label}</span>
        {group.rowEnabled !== undefined && (
          <span className="pp__card-sub">
            {group.rowEnabled ? t('hint.enabled') : t('hint.disabled')}
          </span>
        )}
        {group.version !== undefined && <span className="pp__card-sub">{group.version}</span>}
        {group.unknown && <span className="pp__chip" data-tone="bad">{t('states.absent')}</span>}
      </div>

      {group.patches.map((entry) => {
        const status = entry.status
        return (
          <div className="pp__patch" key={entry.patch.id}>
            <div className="pp__patch-row">
              <code className="pp__patch-id">{entry.patch.id}</code>
              <Chip t={t} status={status} />
              {!entry.patch.enabled && <span className="pp__card-sub">{t('hint.turnedOff')}</span>}
            </div>
            <p className="pp__patch-reason">{entry.patch.reason}</p>
            <code className="pp__pre">{t(`op.${entry.patch.op.kind}`)}</code>
            {status !== undefined && status.detail !== '' && <p className="pp__hint">{status.detail}</p>}
            {status !== undefined && HINT_KEY[status.state] !== undefined && (
              <p className="pp__hint">
                {t(HINT_KEY[status.state]!)}
                {typeof (status.hint as { command?: unknown } | undefined)?.command === 'string' && (
                  <>
                    {' '}
                    <code className="pp__pre">{String((status.hint as { command: string }).command)}</code>
                  </>
                )}
              </p>
            )}
            <div className="pp__actions">
              <button type="button" className="pp__btn" onClick={() => onEdit(entry.patch)}>
                {t('action.edit')}
              </button>
              <button type="button" className="pp__btn" onClick={() => onToggle(entry.patch)}>
                {entry.patch.enabled ? t('action.turnOff') : t('action.turnOn')}
              </button>
              <button type="button" className="pp__btn" data-variant="danger" onClick={() => onRemove(entry.patch)}>
                {t('action.remove')}
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
