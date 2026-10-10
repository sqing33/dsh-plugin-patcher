/**
 * The browser half: two entries into the same host state.
 *
 * One is a whole settings section, because a spec is a document and reading it
 * means seeing all of it. The other is a badge and a section on the plugin
 * detail page, because the question an operator actually arrives with is about
 * one plugin. Registering an undeclared slot throws, so every registration is
 * wrapped in the inject that owns it.
 */

import { PatcherPage } from './PatcherPage.tsx'
import { DetailBadge, DetailSection } from './detail.tsx'
import { installStyles } from './styles.ts'
import { zh, en } from './locales.ts'
import { NAMESPACE, SECTION_ORDER, type T } from './ns.ts'

export { PatcherPage } from './PatcherPage.tsx'
export { DetailBadge, DetailSection } from './detail.tsx'

/**
 * The faces this half needs.
 *
 * `configForms` is the write path and `remote` is not optional next to it: the
 * config provider subscribes to settings invalidation forwarded over `remote`,
 * and without that face it holds a namespace that never learns it changed.
 * (The theme plugin injects the same four.)
 */
export const inject = ['slots', 'locale', 'remote', 'configForms']

/** The two write members this half uses, and no more. */
interface FormFace {
  mutate(
    ops: ReadonlyArray<{ op: 'set' | 'unset'; path: readonly string[]; value?: unknown }>,
    revision?: number,
  ): Promise<boolean>
}

/** What apply() actually receives, in the shape this half uses it. */
interface ClientHost {
  effect: (fn: () => unknown, label: string) => () => void
  slots: {
    inject(name: string, register: () => () => void): void
    register(options: Record<string, unknown>, component: React.ComponentType<never>): () => void
  }
  locale: {
    register(namespace: string, dictionaries: { zh: unknown; en: unknown }): () => void
    bind(namespace: string): T
  }
  configForms: { get(entryId: string): FormFace }
}

interface SectionProps {
  t?: T
  close: () => void
}

interface DetailOwnerProps {
  subject: {
    kind: 'bundle' | 'row' | 'item'
    pkg?: string
    row?: string
    id?: string
  }
  t?: T
}

export function apply(ctx: unknown): void {
  const host = ctx as ClientHost
  installStyles()
  // Registered inside an effect: the locale service hands back a disposer, and
  // dropping it on the floor would leak a dictionary per reload.
  host.effect(
    () => host.locale.register(NAMESPACE, { zh, en }),
    'dsh-plugin-patcher: dictionaries',
  )
  const t = host.locale.bind(NAMESPACE)

  // The spec is written through this plugin's own settings namespace, the same
  // string as the profile row id: one config, one reconcile, no second channel.
  const form = host.configForms.get(NAMESPACE)

  host.slots.inject('settings.section', () =>
    host.slots.register(
      {
        name: 'settings.section',
        id: NAMESPACE,
        order: SECTION_ORDER,
        label: () => t('title'),
        locale: NAMESPACE,
      },
      ((props: SectionProps) => <PatcherPage t={props.t ?? t} form={form} />) as never,
    ),
  )

  // Both plugin detail slots are list slots whose owner hands over a subject;
  // each component returns null for a subject this plugin has no patches for,
  // which is what keeps them off every other plugin's page.
  const detail: Array<[string, (props: DetailOwnerProps) => React.ReactElement | null]> = [
    ['plugins.detail.badge', DetailBadge],
    ['plugins.detail.section', DetailSection],
  ]
  for (const [name, component] of detail) {
    host.slots.inject(name, () =>
      host.slots.register(
        { name, locale: NAMESPACE, priority: 0 },
        ((props: DetailOwnerProps) => component({ ...props, t: props.t ?? t })) as never,
      ),
    )
  }
}
