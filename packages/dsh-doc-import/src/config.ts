/**
 * Settings schema and defaults for the doc-import plugin. The schema doubles
 * as the settings section the web GUI's built-in plugin config page renders
 * (Settings → 插件配置 → doc-import).
 * @module dsh-doc-import/config
 */

import z from 'schemastery'

/** Settings namespace used by the built-in plugin config page. */
export const DOC_IMPORT_SETTINGS_NAMESPACE = 'doc-import'

/** Runtime configuration shape (all defaults widened to primitives). */
export interface DocImportConfig {
  /** Inline cap in characters: longer documents are truncated in the message. */
  inlineCap: number
  /** Reserved field (ADR 0002): no inline cost notice exists in the reference-only flow. */
  costNoticeThreshold: number
  /** Upload byte bound for one document. */
  maxUploadBytes: number
  /** Hard page bound: PDFs beyond this are rejected. */
  maxPdfPages: number
  /** CSV row count above which a "use read_document paging" warning is emitted; the full table is always stored. */
  maxInlineTableRows: number
  /** OCR switches on automatically for pages without a text layer. */
  ocrEnabled: boolean
  /** OCR page cap per document; further scanned pages are skipped with a warning. */
  ocrPageCap: number
  /** Page-level OCR concurrency. */
  ocrConcurrency: number
  /** A PDF page with fewer characters than this is treated as a scanned page. */
  ocrBlankThreshold: number
  /** Vision model id used for OCR. */
  ocrModel: string
  /** OpenAI-compatible endpoint root; /chat/completions is appended. */
  ocrBaseURL: string
  /** Inline API key; empty means resolve ocrApiKeyEnv through the credential seam. */
  ocrApiKey: string
  /** Credential reference (environment variable name) for the API key. */
  ocrApiKeyEnv: string
  /** Per-page OCR request timeout in milliseconds. */
  ocrTimeoutMs: number
  /** Output token cap sent to the vision model per page. */
  ocrMaxOutputTokens: number
  /** Render scale for page rasterization (1.5 ≈ 108 DPI at 72 DPI source). */
  ocrImageScale: number
  /** CNY per 1M tokens — official DeepSeek pricing, editable in settings. */
  pricePeakInputPerMTok: number
  priceOffPeakInputPerMTok: number
  pricePeakOutputPerMTok: number
  priceOffPeakOutputPerMTok: number
  priceOcrPeakInputPerMTok: number
  priceOcrOffPeakInputPerMTok: number
  priceOcrPeakOutputPerMTok: number
  priceOcrOffPeakOutputPerMTok: number
  /** DeepSeek caps one image at 384 tokens (auto-scaled to ≈800×800). */
  ocrImageTokensPerPage: number
}

/** Defaults applied when the plugin is mounted without configuration. */
export const DEFAULTS: DocImportConfig = {
  inlineCap: 1_000_000,
  costNoticeThreshold: 50_000,
  maxUploadBytes: 100 * 1024 * 1024,
  maxPdfPages: 2_000,
  maxInlineTableRows: 1_000,
  ocrEnabled: true,
  ocrPageCap: 100,
  ocrConcurrency: 3,
  ocrBlankThreshold: 30,
  ocrModel: 'deepseek-v4-flash-vision-exp',
  ocrBaseURL: 'https://api.deepseek.com',
  ocrApiKey: '',
  ocrApiKeyEnv: 'DEEPSEEK_API_KEY',
  ocrTimeoutMs: 120_000,
  ocrMaxOutputTokens: 4_096,
  ocrImageScale: 1.5,
  pricePeakInputPerMTok: 9,
  priceOffPeakInputPerMTok: 4.5,
  pricePeakOutputPerMTok: 27,
  priceOffPeakOutputPerMTok: 13.5,
  priceOcrPeakInputPerMTok: 3,
  priceOcrOffPeakInputPerMTok: 1.5,
  priceOcrPeakOutputPerMTok: 9,
  priceOcrOffPeakOutputPerMTok: 4.5,
  ocrImageTokensPerPage: 384,
}

/** Schemastery schema: the settings section schema and validation. */
export const Config: z<DocImportConfig> = z.object({
  inlineCap: z.number().step(1).min(1_000).default(DEFAULTS.inlineCap),
  costNoticeThreshold: z.number().step(1).min(100).default(DEFAULTS.costNoticeThreshold),
  maxUploadBytes: z.number().step(1).min(1).default(DEFAULTS.maxUploadBytes),
  maxPdfPages: z.number().step(1).min(1).default(DEFAULTS.maxPdfPages),
  maxInlineTableRows: z.number().step(1).min(1).default(DEFAULTS.maxInlineTableRows),
  ocrEnabled: z.boolean().default(DEFAULTS.ocrEnabled),
  ocrPageCap: z.number().step(1).min(0).default(DEFAULTS.ocrPageCap),
  ocrConcurrency: z.number().step(1).min(1).max(8).default(DEFAULTS.ocrConcurrency),
  ocrBlankThreshold: z.number().step(1).min(1).default(DEFAULTS.ocrBlankThreshold),
  ocrModel: z.string().default(DEFAULTS.ocrModel),
  ocrBaseURL: z.string().default(DEFAULTS.ocrBaseURL),
  ocrApiKey: z.string().role('secret').default(DEFAULTS.ocrApiKey),
  ocrApiKeyEnv: z.string().role('credential-ref').default(DEFAULTS.ocrApiKeyEnv),
  ocrTimeoutMs: z.number().step(1).min(1_000).default(DEFAULTS.ocrTimeoutMs),
  ocrMaxOutputTokens: z.number().step(1).min(1).default(DEFAULTS.ocrMaxOutputTokens),
  ocrImageScale: z.number().min(0.5).max(3).default(DEFAULTS.ocrImageScale),
  pricePeakInputPerMTok: z.number().min(0).default(DEFAULTS.pricePeakInputPerMTok),
  priceOffPeakInputPerMTok: z.number().min(0).default(DEFAULTS.priceOffPeakInputPerMTok),
  pricePeakOutputPerMTok: z.number().min(0).default(DEFAULTS.pricePeakOutputPerMTok),
  priceOffPeakOutputPerMTok: z.number().min(0).default(DEFAULTS.priceOffPeakOutputPerMTok),
  priceOcrPeakInputPerMTok: z.number().min(0).default(DEFAULTS.priceOcrPeakInputPerMTok),
  priceOcrOffPeakInputPerMTok: z.number().min(0).default(DEFAULTS.priceOcrOffPeakInputPerMTok),
  priceOcrPeakOutputPerMTok: z.number().min(0).default(DEFAULTS.priceOcrPeakOutputPerMTok),
  priceOcrOffPeakOutputPerMTok: z.number().min(0).default(DEFAULTS.priceOcrOffPeakOutputPerMTok),
  ocrImageTokensPerPage: z.number().step(1).min(1).default(DEFAULTS.ocrImageTokensPerPage),
})

/** Merge a (possibly partial) settings value over the defaults. */
export function resolveConfig(value?: Partial<DocImportConfig> | null): DocImportConfig {
  return { ...DEFAULTS, ...(value ?? {}) }
}
