/**
 * Host half of the dsh-doc-import plugin: registers the /doc-import/* route
 * family, the read_document tool, and the "doc-import" settings section.
 * Mounted without configuration the plugin works out of the box (defaults +
 * the DEEPSEEK_API_KEY credential seam for OCR).
 * @module dsh-doc-import
 */

import type { Context } from '@deepseek-ai/cordis'
import { Config, DOC_IMPORT_SETTINGS_NAMESPACE, resolveConfig, type DocImportConfig } from './config.js'
import { createOcrRunner } from './ocr.js'
import { registerDocRoutes } from './routes.js'
import { createDocStore } from './store.js'
import { readDocumentTool } from './tool.js'

export const name = 'doc-import'
export const inject = ['tools', 'webServer']

export {
  Config,
  DEFAULTS,
  DOC_IMPORT_SETTINGS_NAMESPACE,
  resolveConfig,
} from './config.js'
export type { DocImportConfig } from './config.js'
export { buildDocumentHeader } from './routes.js'
export { decodeText, detectKind, parseDocument, DOC_KINDS } from './parsers.js'
export { estimateTokens, inlineCost, ocrPageCost, isPeakBeijing, formatCny } from './cost.js'

const APPLIED = Symbol.for('dsh-doc-import.applied')

interface SettingsService {
  installSection(ctx: Context, namespace: string, schema: unknown, value: unknown, handlers: {
    setSource: (source: () => Partial<DocImportConfig>) => void
    onChange: () => void
    validate: (value: Partial<DocImportConfig>) => void
  }): void
}

export function apply(ctx: Context, config: Partial<DocImportConfig> = {}): void {
  // Defensive fence: a failure inside this plugin must never take the whole
  // profile boot down (the web shell fails hard when a plugin apply throws).
  try {
    applyImpl(ctx, config)
  } catch (error) {
    console.error('[doc-import] apply failed:', error)
  }
}

function applyImpl(ctx: Context, config: Partial<DocImportConfig>): void {
  if ((ctx as unknown as Record<symbol, boolean>)[APPLIED] === true) return
  ;(ctx as unknown as Record<symbol, boolean>)[APPLIED] = true

  let current: () => Partial<DocImportConfig> = () => config
  ctx.inject(['settings'], (settingsCtx) => {
    const settings = settingsCtx.get('settings') as SettingsService | undefined
    if (settings === undefined || typeof settings.installSection !== 'function') return
    try {
      settings.installSection(ctx, DOC_IMPORT_SETTINGS_NAMESPACE, Config, config, {
        setSource: (source) => {
          current = source
        },
        onChange: () => {},
        validate: (value) => {
          resolveConfig(value)
        },
      })
    } catch (error) {
      console.warn('[doc-import] settings section install failed:', error)
    }
  })

  const getCfg = (): DocImportConfig => resolveConfig(current())
  const store = createDocStore()
  const ocr = createOcrRunner(ctx, store, getCfg)
  // Capture while the plugin fiber is certainly active; the registration call
  // below runs after the async store init.
  const tools = ctx.tools

  void store
    .init()
    .then(() => {
      registerDocRoutes(ctx, getCfg, store, ocr)
      try {
        tools.register(readDocumentTool(store))
      } catch (error) {
        console.warn('[doc-import] read_document tool registration failed:', error)
      }
    })
    .catch((error) => {
      console.error('[doc-import] storage init failed:', error)
    })
}
