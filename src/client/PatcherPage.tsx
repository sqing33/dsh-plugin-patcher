/** The settings page: what is bound, what is wrong, and what can still be bound. */

import { useCallback, useMemo, useState } from 'react'
import type { Patch, Target } from '../spec/types.ts'
import { refreshPatcherState, usePatcherState, type SpecForm } from './usePatcherState.ts'
import { PatchEditor } from './PatchEditor.tsx'
import { TargetCard } from './TargetCard.tsx'
import {
  bumpedNonce,
  groupTargets,
  patchesOf,
  specOf,
  validateDraft,
  withEnabled,
  writeOps,
  type TargetGroup,
} from './spec-io.ts'
import { formatSpecText, parseSpecText } from './spec-text.ts'
import type { PatcherState } from '../host/state.ts'
import type { T } from './ns.ts'

/** One thing the page can aim at, as the editor wants it. */
interface InventoryTarget {
  key: string
  target: Target
  label: string
  pkg?: string
  rowEnabled?: boolean
  version?: string
}

/**
 * Every namespace, row and bundle, labelled the way the card will label it.
 *
 * The page cannot name these from memory, and neither should the operator: an
 * inventory that lists only what already has a patch is a list of the past.
 */
function inventoryTargets(state: PatcherState): InventoryTarget[] {
  const rows = [...state.inventory.rows].sort((a, b) => a.rowId.localeCompare(b.rowId))
  return [
    ...[...state.inventory.settings].sort().map((namespace) => ({
      key: `settings:${namespace}`,
      target: { kind: 'settings', namespace } as Target,
      label: namespace,
    })),
    ...rows.map((row) => ({
      key: `patch-row:${row.rowId}`,
      target: {
        kind: 'patch-row',
        rowId: row.rowId,
        ...(row.name === undefined ? {} : { name: row.name }),
      } as Target,
      label: row.name ?? row.rowId,
      rowEnabled: row.enabled,
    })),
    ...[...state.inventory.bundles]
      .sort((a, b) => a.pkg.localeCompare(b.pkg))
      .map((bundle) => ({
        key: `package-file:${bundle.pkg}`,
        target: { kind: 'package-file', pkg: bundle.pkg, path: '' } as Target,
        label: bundle.pkg,
        pkg: bundle.pkg,
        version: bundle.version,
      })),
  ]
}

export interface PatcherPageProps {
  /** Injected by the locale face; the page never imports the dictionary itself. */
  t: T
  /** The write face of this plugin's own settings namespace. */
  form: SpecForm
}

interface EditorState {
  initial: Patch | undefined
  seed: Target | undefined
}

export function PatcherPage({ t, form }: PatcherPageProps): React.ReactElement {
  const { state, error, ready } = usePatcherState()
  const [editor, setEditor] = useState<EditorState | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [text, setText] = useState('')
  const [showText, setShowText] = useState(false)
  const [textError, setTextError] = useState<string | undefined>(undefined)

  const patches = useMemo(() => patchesOf(specOf(state)), [state])
  const groups = useMemo(
    () => (state === undefined ? undefined : groupTargets(state)),
    [state],
  )

  const write = useCallback(
    async (next: Patch[]): Promise<void> => {
      setBusy(true)
      try {
        const accepted = await form.mutate(writeOps({ patches: next, reconcileNonce: bumpedNonce(specOf(state)) }))
        if (!accepted) {
          setNotice(t('saveFailed', { message: t('notWritable') }))
          return
        }
        setNotice(t('saved'))
        setEditor(undefined)
        // The host reconciles on its own debounce; ask right away so the page
        // settles with the answer rather than two seconds after it arrived.
        setTimeout(refreshPatcherState, 200)
      } finally {
        setBusy(false)
      }
    },
    [form, state, t],
  )

  if (!ready || state === undefined) {
    return (
      <div className="pp">
        <p className="pp__hint">{error === undefined ? t('loading') : t('hostError', { message: error })}</p>
      </div>
    )
  }

  const tally = Object.entries(state.tally).filter(([key]) => key !== 'pending' && state.tally[key as keyof typeof state.tally] > 0)

  return (
    <div className="pp">
      <header className="pp__head">
        <h2 className="pp__title">{t('title')}</h2>
        <div className="pp__actions">
          <button
            type="button"
            className="pp__btn"
            data-variant="primary"
            disabled={busy}
            onClick={() => {
              void write(patches)
              setTimeout(refreshPatcherState, 200)
            }}
          >
            {t('reapply')}
          </button>
          <button type="button" className="pp__btn" disabled={busy} onClick={() => setEditor({ initial: undefined, seed: undefined })}>
            {t('addPatch')}
          </button>
          <button
            type="button"
            className="pp__btn"
            onClick={() => {
              setText(formatSpecText(specOf(state)))
              setShowText(true)
            }}
          >
            {t('action.openText')}
          </button>
        </div>
      </header>

      <p className="pp__intro">{t('intro')}</p>

      {!state.writable && <p className="pp__error">{t('notWritable')}</p>}
      {error !== undefined && <p className="pp__error">{t('hostError', { message: error })}</p>}
      {state.error !== undefined && <p className="pp__error">{state.error}</p>}
      {notice !== undefined && <p className="pp__hint">{notice}</p>}

      <section className="pp__summary">
        {tally.length === 0 && <span className="pp__card-sub">{t('overviewEmpty')}</span>}
        {tally.map(([key, count]) => (
          <span className="pp__chip" key={key} data-tone={key === 'in-sync' ? 'ok' : 'warn'}>
            {t(`states.${key}`)} {count}
          </span>
        ))}
        <span className="pp__card-sub">
          {t('lastRun', { at: state.reconciledAt ?? t('never') })}
        </span>
      </section>

      {state.diagnostics.length > 0 && (
        <section className="pp__group">
          <h3 className="pp__group-title">{t('overview')}</h3>
          {state.diagnostics.map((diagnostic) => (
            <p className="pp__error" key={`${diagnostic.path}:${diagnostic.message}`}>
              <code className="pp__pre">{diagnostic.path}</code> {diagnostic.message}
            </p>
          ))}
        </section>
      )}

      {editor !== undefined && (
        <section className="pp__group">
          <h3 className="pp__group-title">
            {editor.initial === undefined ? t('addPatch') : t('editing', { id: editor.initial.id })}
          </h3>
          <PatchEditor
            t={t}
            state={state}
            initial={editor.initial}
            seed={editor.seed}
            onCancel={() => setEditor(undefined)}
            onSave={(patch) => {
              const rest = patches.filter((entry) => entry.id !== patch.id)
              void write([...rest, patch])
            }}
          />
        </section>
      )}

      {showText && (
        <section className="pp__group">
          <h3 className="pp__group-title">{t('textTitle')}</h3>
          <p className="pp__hint">{t('textNote')}</p>
          <textarea
            className="pp__area"
            data-role="spec-text"
            rows={14}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          {textError !== undefined && <p className="pp__error">{textError}</p>}
          <div className="pp__actions">
            <button
              type="button"
              className="pp__btn"
              data-variant="primary"
              disabled={busy || textError !== undefined}
              onClick={() => {
                const parsed = parseSpecText(text, state)
                if (parsed.config === undefined) {
                  setTextError(parsed.error)
                  return
                }
                setTextError(undefined)
                void write(patchesOf(parsed.config))
              }}
            >
              {t('action.import')}
            </button>
            <button
              type="button"
              className="pp__btn"
              onClick={() => {
                setText(formatSpecText(specOf(state)))
                setTextError(undefined)
              }}
            >
              {t('action.export')}
            </button>
            <button type="button" className="pp__btn" onClick={() => setShowText(false)}>
              {t('action.close')}
            </button>
          </div>
        </section>
      )}

      <section className="pp__group">
        <h3 className="pp__group-title">{t('boundTitle')}</h3>
        {groups !== undefined && groups.bound.length === 0 && <p className="pp__hint">{t('emptyBound')}</p>}
        {groups?.bound.map((group: TargetGroup) => (
          <TargetCard
            key={group.key}
            t={t}
            group={group}
            onEdit={(patch) => setEditor({ initial: patch, seed: undefined })}
            onRemove={(patch) => void write(patches.filter((entry) => entry.id !== patch.id))}
            onToggle={(patch) => void write(patches.map((entry) => (entry.id === patch.id ? withEnabled(entry, !entry.enabled) : entry)))}
            onBind={() => setEditor({ initial: undefined, seed: group.target })}
          />
        ))}
      </section>

      {groups !== undefined && groups.unknown.length > 0 && (
        <section className="pp__group">
          <h3 className="pp__group-title">{t('unknownTitle')}</h3>
          <p className="pp__hint">{t('unknownNote')}</p>
          {groups.unknown.map((group) => (
            <TargetCard
              key={group.key}
              t={t}
              group={group}
              onEdit={(patch) => setEditor({ initial: patch, seed: undefined })}
              onRemove={(patch) => void write(patches.filter((entry) => entry.id !== patch.id))}
              onToggle={(patch) => void write(patches.map((entry) => (entry.id === patch.id ? withEnabled(entry, !entry.enabled) : entry)))}
              onBind={() => setEditor({ initial: undefined, seed: group.target })}
            />
          ))}
        </section>
      )}

      <section className="pp__group">
        <h3 className="pp__group-title">{t('inventoryTitle')}</h3>
        <p className="pp__hint">{t('inventoryNote')}</p>
        <div className="pp__inventory">
          {inventoryTargets(state).map((target) => {
            const group: TargetGroup = {
              key: `inventory:${target.key}`,
              target,
              label: target.label,
              pkg: target.pkg,
              rowEnabled: target.rowEnabled,
              version: target.version,
              patches: [],
              unknown: false,
            }
            return (
              <TargetCard
                key={group.key}
                t={t}
                unclaimed
                group={group}
                onEdit={() => undefined}
                onRemove={() => undefined}
                onToggle={() => undefined}
                onBind={() => setEditor({ initial: undefined, seed: target })}
              />
            )
          })}
        </div>
      </section>
    </div>
  )
}
