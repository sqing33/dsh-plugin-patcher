/** The one form that creates or changes a patch. */

import { useMemo, useState } from 'react'
import type { Op, Patch, Target } from '../spec/types.ts'
import type { PatcherState } from '../host/state.ts'
import { newPatchId, opKindsFor, validateDraft, type DraftPatch } from './spec-io.ts'
import type { T } from './ns.ts'

export interface EditorProps {
  t: T
  state: PatcherState
  /** The patch being changed, or undefined for a new one. */
  initial?: Patch
  /** A target picked from the inventory, so binding a new one needs no typing. */
  seed?: Target
  onSave: (patch: Patch) => void
  onCancel: () => void
}

interface Draft {
  id: string
  enabled: boolean
  reason: string
  kind: Target['kind']
  namespace: string
  rowId: string
  rowName: string
  pkg: string
  version: string
  /** A path inside the package; a regex, not a glob, as the host will treat it. */
  filePath: string
  opKind: Op['kind']
  /** Comma separated, because a path is a list of keys and typing brackets is worse. */
  valuePath: string
  valueText: string
  configText: string
  rowEnabled: boolean
  edits: Array<{ find: string; replace: string }>
  /**
   * Files to add inside the target package, each a path and a reference into
   * this plugin's own patches/ directory. The form edits the reference, not the
   * content: content that lives in a settings text box is a file nobody can
   * open, diff or lint, which is the whole reason this list exists.
   */
  files: Array<{ path: string; source: string }>
}

function emptyDraft(state: PatcherState, seed?: Target): Draft {
  const kind = seed?.kind ?? 'settings'
  return {
    id: newPatchId(state.spec?.patches ?? []),
    enabled: true,
    reason: '',
    kind,
    namespace: seed?.kind === 'settings' ? seed.namespace : '',
    rowId: seed?.kind === 'patch-row' ? seed.rowId : '',
    rowName: seed?.kind === 'patch-row' ? (seed.name ?? '') : '',
    pkg: seed?.kind === 'package-file' ? seed.pkg : '',
    version: seed?.kind === 'package-file' ? (seed.version ?? '') : '',
    filePath: seed?.kind === 'package-file' ? seed.path : '',
    opKind: opKindsFor(kind)[0] ?? 'verify-only',
    valuePath: '',
    valueText: 'true',
    configText: '{}',
    rowEnabled: true,
    edits: [{ find: '', replace: '' }],
    files: [],
  }
}

function draftOf(patch: Patch): Draft {
  const draft = emptyDraft
  const base: Draft = {
    id: patch.id,
    enabled: patch.enabled,
    reason: patch.reason,
    kind: patch.target.kind,
    namespace: '',
    rowId: '',
    rowName: '',
    pkg: '',
    version: '',
    filePath: '',
    opKind: patch.op.kind,
    valuePath: '',
    valueText: 'true',
    configText: '{}',
    rowEnabled: true,
    edits: [],
    files: [],
  }
  if (patch.target.kind === 'settings') base.namespace = patch.target.namespace
  if (patch.target.kind === 'patch-row') {
    base.rowId = patch.target.rowId
    base.rowName = patch.target.name ?? ''
  }
  if (patch.target.kind === 'package-file') {
    base.pkg = patch.target.pkg
    base.version = patch.target.version ?? ''
    base.filePath = patch.target.path
  }
  const op = patch.op
  if (op.kind === 'set') {
    base.valuePath = op.path.join(',')
    base.valueText = JSON.stringify(op.value, null, 2)
  }
  if (op.kind === 'unset') base.valuePath = op.path.join(',')
  if (op.kind === 'merge-config') base.configText = JSON.stringify(op.config, null, 2)
  if (op.kind === 'set-enabled') base.rowEnabled = op.enabled
  if (op.kind === 'code') {
    base.edits = op.edits.map((edit) => ({ find: edit.find, replace: edit.replace }))
    // A spec that predates the files field, or one an operator hand-edited, has
    // no such array. Reading it defensively is what keeps this form able to open
    // that patch and save it back rather than throwing inside a render.
    base.files = (Array.isArray(op.files) ? op.files : []).map((file) => ({ path: file.path, source: file.source }))
  }
  void draft
  return base
}

function targetOf(draft: Draft): Target {
  if (draft.kind === 'settings') return { kind: 'settings', namespace: draft.namespace.trim() }
  if (draft.kind === 'patch-row') {
    return {
      kind: 'patch-row',
      rowId: draft.rowId.trim(),
      ...(draft.rowName.trim() === '' ? {} : { name: draft.rowName.trim() }),
    }
  }
  return {
    kind: 'package-file',
    pkg: draft.pkg.trim(),
    ...(draft.version.trim() === '' ? {} : { version: draft.version.trim() }),
    path: draft.filePath.trim(),
  }
}

/** The op the form currently describes, or the reason it cannot describe one. */
function opOf(draft: Draft): { op?: Op; error?: string } {
  const path = draft.valuePath.split(',').map((part) => part.trim())
  if (draft.opKind === 'set') {
    let value: unknown
    try {
      value = JSON.parse(draft.valueText)
    } catch (error) {
      return { error: `the value is not JSON: ${error instanceof Error ? error.message : String(error)}` }
    }
    return { op: { kind: 'set', path, value: value as never } }
  }
  if (draft.opKind === 'unset') return { op: { kind: 'unset', path } }
  if (draft.opKind === 'merge-config') {
    let config: unknown
    try {
      config = JSON.parse(draft.configText)
    } catch (error) {
      return { error: `the config is not JSON: ${error instanceof Error ? error.message : String(error)}` }
    }
    if (typeof config !== 'object' || config === null || Array.isArray(config)) {
      return { error: 'the config must be a JSON object' }
    }
    return { op: { kind: 'merge-config', config: config as Record<string, never> } }
  }
  if (draft.opKind === 'set-enabled') return { op: { kind: 'set-enabled', enabled: draft.rowEnabled } }
  if (draft.opKind === 'verify-only') return { op: { kind: 'verify-only' } }
  // A code patch is two lists, and either one alone is a real patch: edits to
  // the target file, and files to add beside it. Only a patch with both empty
  // would rewrite the target for nothing, and that is the one case the host
  // rejects, so the form must not invent an op the host will refuse.
  const edits = draft.edits
    .filter((edit) => edit.find !== '')
    .map((edit) => ({ find: edit.find, replace: edit.replace, count: 1 as const }))
  const files = draft.files
    .filter((file) => file.path !== '' || file.source !== '')
    .map((file) => ({ path: file.path.trim(), source: file.source.trim() }))
  if (edits.length === 0 && files.length === 0) {
    return { error: 'a code patch needs at least one edit or one file' }
  }
  return { op: { kind: 'code', edits, files } }
}

export function PatchEditor({ t, state, initial, seed, onSave, onCancel }: EditorProps): React.ReactElement {
  const [draft, setDraft] = useState<Draft>(() =>
    initial === undefined ? emptyDraft(state, seed) : draftOf(initial),
  )
  const patch = useMemo(() => {
    const built = opOf(draft)
    if (built.op === undefined) return { draft: undefined, error: built.error }
    const value: DraftPatch = {
      id: draft.id.trim(),
      enabled: draft.enabled,
      reason: draft.reason.trim(),
      target: targetOf(draft),
      op: built.op,
    }
    // The id of the patch being edited is already in the spec; that is what
    // makes it an edit, so it must not count as a collision with itself.
    return { draft: value, error: validateDraft(value, state, initial?.id) }
  }, [draft, state])

  const set = <K extends keyof Draft>(key: K, value: Draft[K]): void =>
    setDraft((current) => ({ ...current, [key]: value }))
  const changeKind = (kind: Target['kind']): void =>
    setDraft((current) => ({ ...current, kind, opKind: opKindsFor(kind)[0] ?? 'verify-only' }))
  const options = state.inventory

  return (
    <div className="pp__form">
      <div className="pp__grid">
        <label className="pp__field">
          <span className="pp__label">{t('field.id')}</span>
          <input className="pp__input" value={draft.id} onChange={(event) => set('id', event.target.value)} />
        </label>
        <label className="pp__field">
          <span className="pp__label">{t('field.targetKind')}</span>
          <select
            className="pp__select"
            value={draft.kind}
            onChange={(event) => changeKind(event.target.value as Target['kind'])}
          >
            <option value="settings">{t('kind.settings')}</option>
            <option value="patch-row">{t('kind.patch-row')}</option>
            <option value="package-file">{t('kind.package-file')}</option>
          </select>
        </label>
        {draft.kind === 'settings' && (
          <label className="pp__field">
            <span className="pp__label">{t('field.namespace')}</span>
            <input
              className="pp__input"
              list="pp-settings-namespaces"
              value={draft.namespace}
              onChange={(event) => set('namespace', event.target.value)}
            />
            <datalist id="pp-settings-namespaces">
              {options.settings.map((namespace) => (
                <option key={namespace} value={namespace} />
              ))}
            </datalist>
          </label>
        )}
        {draft.kind === 'patch-row' && (
          <>
            <label className="pp__field">
              <span className="pp__label">{t('field.rowId')}</span>
              <input
                className="pp__input"
                list="pp-row-ids"
                value={draft.rowId}
                onChange={(event) => set('rowId', event.target.value)}
              />
              <datalist id="pp-row-ids">
                {options.rows.map((row) => (
                  <option key={row.rowId} value={row.rowId} />
                ))}
              </datalist>
            </label>
            <label className="pp__field">
              <span className="pp__label">{t('field.rowName')}</span>
              <input className="pp__input" value={draft.rowName} onChange={(event) => set('rowName', event.target.value)} />
            </label>
          </>
        )}
        {draft.kind === 'package-file' && (
          <>
            <label className="pp__field">
              <span className="pp__label">{t('field.pkg')}</span>
              <input
                className="pp__input"
                list="pp-packages"
                value={draft.pkg}
                onChange={(event) => set('pkg', event.target.value)}
              />
              <datalist id="pp-packages">
                {options.bundles.map((bundle) => (
                  <option key={bundle.pkg} value={bundle.pkg} />
                ))}
              </datalist>
            </label>
            <label className="pp__field">
              <span className="pp__label">{t('field.version')}</span>
              <input
                className="pp__input"
                list="pp-versions"
                value={draft.version}
                onChange={(event) => set('version', event.target.value)}
              />
              <datalist id="pp-versions">
                {options.bundles.map((bundle) => (
                  <option key={bundle.pkg} value={bundle.version ?? ''} />
                ))}
              </datalist>
            </label>
            <label className="pp__field">
              <span className="pp__label">{t('field.path')}</span>
              <input className="pp__input" value={draft.filePath} onChange={(event) => set('filePath', event.target.value)} />
            </label>
          </>
        )}
      </div>

      <div className="pp__grid">
        <label className="pp__field">
          <span className="pp__label">{t('field.opKind')}</span>
          <select
            className="pp__select"
            value={draft.opKind}
            onChange={(event) => set('opKind', event.target.value as Op['kind'])}
          >
            {opKindsFor(draft.kind).map((kind) => (
              <option key={kind} value={kind}>
                {t(`op.${kind}`)}
              </option>
            ))}
          </select>
        </label>

        {(draft.opKind === 'set' || draft.opKind === 'unset') && (
          <label className="pp__field">
            <span className="pp__label">{t('field.path')}</span>
            <input
              className="pp__input"
              placeholder="providers,openai"
              value={draft.valuePath}
              onChange={(event) => set('valuePath', event.target.value)}
            />
          </label>
        )}

        {draft.opKind === 'set' && (
          <label className="pp__field">
            <span className="pp__label">{t('field.value')}</span>
            <textarea
              className="pp__area"
              value={draft.valueText}
              onChange={(event) => set('valueText', event.target.value)}
            />
          </label>
        )}

        {draft.opKind === 'merge-config' && (
          <label className="pp__field">
            <span className="pp__label">{t('field.config')}</span>
            <textarea
              className="pp__area"
              value={draft.configText}
              onChange={(event) => set('configText', event.target.value)}
            />
          </label>
        )}

        {draft.opKind === 'set-enabled' && (
          <label className="pp__check">
            <input
              type="checkbox"
              checked={draft.rowEnabled}
              onChange={(event) => set('rowEnabled', event.target.checked)}
            />
            <span>{t('op.set-enabled')}</span>
          </label>
        )}

        {draft.opKind === 'code' && (
          <div className="pp__field">
            <span className="pp__label">{t('op.code')}</span>
            {draft.edits.map((edit, index) => (
              <div className="pp__grid" key={index}>
                <label className="pp__field">
                  <span className="pp__label">{t('field.find')}</span>
                  <textarea
                    className="pp__area"
                    value={edit.find}
                    onChange={(event) =>
                      setDraft((current) => {
                        const edits = [...current.edits]
                        edits[index] = { ...edits[index]!, find: event.target.value }
                        return { ...current, edits }
                      })
                    }
                  />
                </label>
                <label className="pp__field">
                  <span className="pp__label">{t('field.replace')}</span>
                  <textarea
                    className="pp__area"
                    value={edit.replace}
                    onChange={(event) =>
                      setDraft((current) => {
                        const edits = [...current.edits]
                        edits[index] = { ...edits[index]!, replace: event.target.value }
                        return { ...current, edits }
                      })
                    }
                  />
                </label>
              </div>
            ))}
            <button
              type="button"
              className="pp__btn"
              onClick={() => setDraft((current) => ({ ...current, edits: [...current.edits, { find: '', replace: '' }] }))}
            >
              {t('field.addEdit')}
            </button>
            <span className="pp__label">{t('op.codeFiles')}</span>
            <p className="pp__hint">{t('field.codeFilesHint')}</p>
            {draft.files.map((file, index) => (
              <div className="pp__grid" key={index}>
                <label className="pp__field">
                  <span className="pp__label">{t('field.filePath')}</span>
                  <input
                    className="pp__input"
                    placeholder="lib/force-effort-tiers.js"
                    value={file.path}
                    onChange={(event) =>
                      setDraft((current) => {
                        const files = [...current.files]
                        files[index] = { ...files[index]!, path: event.target.value }
                        return { ...current, files }
                      })
                    }
                  />
                </label>
                <label className="pp__field">
                  <span className="pp__label">{t('field.fileSource')}</span>
                  <input
                    className="pp__input"
                    placeholder="patches/dsh-reasoning-effort/lib/force-effort-tiers.js"
                    value={file.source}
                    onChange={(event) =>
                      setDraft((current) => {
                        const files = [...current.files]
                        files[index] = { ...files[index]!, source: event.target.value }
                        return { ...current, files }
                      })
                    }
                  />
                </label>
              </div>
            ))}
            <button
              type="button"
              className="pp__btn"
              onClick={() => setDraft((current) => ({ ...current, files: [...current.files, { path: '', source: '' }] }))}
            >
              {t('field.addFile')}
            </button>
          </div>
        )}
      </div>

      <label className="pp__field">
        <span className="pp__label">{t('field.reason')}</span>
        <input className="pp__input" value={draft.reason} onChange={(event) => set('reason', event.target.value)} />
      </label>
      <label className="pp__check">
        <input type="checkbox" checked={draft.enabled} onChange={(event) => set('enabled', event.target.checked)} />
        <span>{t('field.enabled')}</span>
      </label>

      {patch.error !== undefined && <p className="pp__error">{patch.error}</p>}
      {patch.error === undefined && patch.draft?.reason === '' && <p className="pp__hint">{t('reasonRequired')}</p>}

      <div className="pp__actions">
        <button
          type="button"
          className="pp__btn"
          data-variant="primary"
          disabled={patch.error !== undefined || patch.draft === undefined}
          onClick={() => {
            const value = patch.draft
            if (value === undefined) return
            onSave({
              id: value.id,
              enabled: value.enabled,
              reason: value.reason,
              target: value.target,
              op: value.op,
            })
          }}
        >
          {t('action.save')}
        </button>
        <button type="button" className="pp__btn" onClick={onCancel}>
          {t('action.cancel')}
        </button>
      </div>
    </div>
  )
}
