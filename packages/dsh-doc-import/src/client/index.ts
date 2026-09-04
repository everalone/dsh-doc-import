/**
 * Browser half of the dsh-doc-import plugin. Declarative composer surface:
 * the import button (conversation.input.left) and the document chip dock
 * (conversation.input.dock), plus document-level drop/paste listeners, the
 * send-time inline hook, and the settings card the built-in plugin config
 * page dispatches through `settings.plugin.item` (spelled
 * `web-ui.plugin.item` by the web-ui-settings bridge). No DOM hacks:
 * everything rides the slots the shell declares. Failure policy: wiring
 * failures are logged, never thrown — the web shell fails the whole boot
 * when a plugin apply throws.
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
    options: { name: string; id?: string; order?: number; locale?: string; inject?: () => () => void },
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

  // Cost-notice threshold, read per send from the settings scope when bound.
  let settingsScopeRef: DocImportSettingsScope | undefined

  ctx.inject(['slots', 'conversation'], (scope) => {
    try {
      installSendHook(scope.conversation, () => {
        const snapshot = settingsScopeRef?.getSnapshot()
        return typeof snapshot?.value?.costNoticeThreshold === 'number' ? snapshot.value.costNoticeThreshold : undefined
      })
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

    // Settings card: bind the namespace scope and hand it to the built-in
    // plugin config page through the web-ui-settings slot bridge.
    ctx.inject(['settingsScope'], (settingsCtx) => {
      try {
        const binder = settingsCtx.get<SettingsScopeBinder>('webUiSettings') ?? settingsCtx.settingsScope
        if (binder === undefined) return
        const settingsScope = binder.bind<DocImportSettingsScope>({ namespace: NS })
        settingsScopeRef = settingsScope
        scope.slots.inject('web-ui.plugin.item', () => {
          const Card = createDocImportSettingsCard(settingsScope)
          return scope.slots.register({ name: 'web-ui.plugin.item', id: 'doc-import', order: 115, locale: NS }, Card)
        })
      } catch (error) {
        console.warn('[doc-import] settings card install failed:', error)
      }
    })
  })
}
