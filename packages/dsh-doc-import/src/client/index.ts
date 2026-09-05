/**
 * Browser half of the dsh-doc-import plugin. Declarative composer surface:
 * the import button (conversation.input.left) and the document chip dock
 * (conversation.input.dock), plus document-level drop/paste listeners, the
 * send-time inline hook, and the settings card. The settings card is
 * registered twice: under the official keyed slot `settings.plugin.item`
 * (the built-in plugin config page pairs cards with the host-registered
 * namespace automatically) and under the community bridge slot
 * `web-ui.plugin.item` (the dsh-web family's web-ui-settings package, kept
 * for users who install that bundle). No DOM hacks: everything rides the
 * slots the shell declares. Failure policy: wiring failures are logged,
 * never thrown — the web shell fails the whole boot when a plugin apply
 * throws.
 * @module dsh-doc-import/client
 */

import { dictionaries, NS, setDocImportLanguage } from './locales.js'
import { installConversationDocPreview } from './preview.js'
import { installSendHook } from './send-hook.js'
import { createDocImportSettingsCard, type DocImportSettingsScope } from './settings-card.js'
import { installDropPaste, DocDock, ImportButton } from './ui.js'

export { NS } from './locales.js'

/** Minimal structural faces of the services this plugin consumes. */
interface SlotsRegistry {
  inject(slotName: string, callback: () => void): void
  register(
    options: { name: string; id?: string; key?: string; order?: number; locale?: string; inject?: () => () => void },
    component: unknown,
  ): () => void
}

interface LocaleService {
  register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void
}

interface SettingsScopeBinder {
  bind<T>(spec: { namespace: string }): T
}

interface ClientContext {
  inject(names: string | readonly string[], callback: (ctx: ClientContext) => void): void
  effect(fn: () => void | (() => void), label?: string): void
  get<T = unknown>(name: string): T
  slots: SlotsRegistry
  locale: LocaleService
  conversation: unknown
  settingsScope?: SettingsScopeBinder
  webUiSettings?: SettingsScopeBinder
}

export const name = 'doc-import'
export const inject = ['slots', 'conversation', 'settingsScope', 'locale']

export function apply(ctx: ClientContext): void {
  // Defensive fence: a client plugin apply throw fails the whole web boot.
  try {
    applyImpl(ctx)
  } catch (error) {
    console.error('[doc-import] client apply failed:', error)
  }
}

function applyImpl(ctx: ClientContext): void {
  ctx.effect(() => {
    try {
      return ctx.locale.register(NS, dictionaries as Record<string, Record<string, string>>)
    } catch {
      return () => {}
    }
  }, 'doc-import: dictionaries')

  ctx.effect(() => {
    const sync = (): void => {
      const lang = document.documentElement.lang
      setDocImportLanguage(lang === 'zh' || lang.startsWith('zh-') ? 'zh' : 'en')
    }
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
    return () => observer.disconnect()
  }, 'doc-import: language mirror')

  ctx.inject(['slots', 'conversation'], (scope) => {
    try {
      installSendHook(scope.conversation)
    } catch (error) {
      console.warn('[doc-import] send hook install failed:', error)
    }
    ctx.effect(() => {
      const disposeDrop = installDropPaste()
      return disposeDrop
    }, 'doc-import: drop/paste listeners')
    ctx.effect(() => {
      try {
        const preview = installConversationDocPreview()
        return () => preview.dispose()
      } catch (error) {
        console.warn('[doc-import] transcript preview install failed:', error)
        return () => {}
      }
    }, 'doc-import: transcript file chips')
    try {
      scope.slots.inject('conversation.input.left', () =>
        scope.slots.register({ name: 'conversation.input.left', id: 'doc-import', order: 5, locale: NS }, ImportButton),
      )
      scope.slots.inject('conversation.input.dock', () =>
        scope.slots.register({ name: 'conversation.input.dock', id: 'doc-import', order: 5, locale: NS }, DocDock),
      )
    } catch (error) {
      console.warn('[doc-import] composer surface install failed:', error)
    }

    // Settings card: bind the namespace scope once, then hand the same card
    // to both surfaces — the official plugin config page (keyed slot, pairs
    // with the host-registered namespace automatically) and the dsh-web
    // family's web-ui-settings bridge (kept for bundle users). Each
    // registration is individually failure-tolerant.
    ctx.inject(['settingsScope'], (settingsCtx) => {
      try {
        const binder = settingsCtx.get<SettingsScopeBinder>('webUiSettings') ?? settingsCtx.settingsScope
        if (binder === undefined) return
        const bound = binder.bind<DocImportSettingsScope>({ namespace: NS })
        // Normalize to stable closures: the official SettingsScopeController
        // uses class methods, so detached references (useSyncExternalStore
        // calls getSnapshot without a receiver) would run with `this`
        // undefined. The community bridge already returned closures; wrapping
        // is a no-op for it and mandatory for the official service.
        const settingsScope: DocImportSettingsScope = {
          getSnapshot: () => bound.getSnapshot(),
          subscribe: (listener) => bound.subscribe(listener),
          set: (field, value) => bound.set(field, value),
          unset: (field) => bound.unset(field),
        }
        const makeCard = () => createDocImportSettingsCard(settingsScope)
        try {
          scope.slots.inject('settings.plugin.item', () => {
            const Card = makeCard()
            return scope.slots.register({ name: 'settings.plugin.item', key: NS, locale: NS }, Card)
          })
        } catch (error) {
          console.warn('[doc-import] official settings card install failed:', error)
        }
        try {
          scope.slots.inject('web-ui.plugin.item', () => {
            const Card = makeCard()
            return scope.slots.register({ name: 'web-ui.plugin.item', id: 'doc-import', order: 115, locale: NS }, Card)
          })
        } catch (error) {
          console.warn('[doc-import] community settings card install failed:', error)
        }
      } catch (error) {
        console.warn('[doc-import] settings card install failed:', error)
      }
    })
  })
}
