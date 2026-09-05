/**
 * Token and cost estimation for inlined document text and OCR pages.
 * Prices default to the official DeepSeek pricing table (CNY per 1M tokens,
 * peak/off-peak split; peak = Beijing workdays 9:00–12:00 / 14:00–18:00) and
 * are editable in the settings section. Estimates are deliberately
 * conservative (cache-miss input pricing, CJK ≈ 1 token per char).
 * @module dsh-doc-import/cost
 */

import type { DocImportConfig } from './config.js'

/** Whether Beijing time right now is in the peak window. */
export function isPeakBeijing(now: Date = new Date()): boolean {
  const bj = new Date(now.getTime() + 8 * 3_600_000)
  const day = bj.getUTCDay()
  if (day === 0 || day === 6) return false
  const h = bj.getUTCHours() + bj.getUTCMinutes() / 60
  return (h >= 9 && h < 12) || (h >= 14 && h < 18)
}

/** Rough token estimate: CJK ≈ 1 token/char, everything else ≈ 1 token/4 chars. */
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/g) ?? []).length
  const other = text.length - cjk
  return Math.ceil(cjk + other / 4)
}

export interface InlineCost {
  tokens: number
  /** Estimated cost right now (peak or off-peak input price, cache miss). */
  cny: number
  cnyOffPeak: number
  cnyPeak: number
  isPeak: boolean
}

/** Cost of inlining `text` into a user message (input pricing, cache miss). */
export function inlineCost(text: string, cfg: DocImportConfig, now: Date = new Date()): InlineCost {
  const tokens = estimateTokens(text)
  const peak = isPeakBeijing(now)
  const cnyPeak = tokens / 1e6 * cfg.pricePeakInputPerMTok
  const cnyOffPeak = tokens / 1e6 * cfg.priceOffPeakInputPerMTok
  return { tokens, cnyPeak, cnyOffPeak, isPeak: peak, cny: peak ? cnyPeak : cnyOffPeak }
}

export interface OcrPageCost {
  inputTokens: number
  outputTokens: number
  cny: number
  cnyOffPeak: number
  cnyPeak: number
  isPeak: boolean
}

/**
 * Cost of OCR for one page: the page image (≤384 tokens by DeepSeek's rule)
 * plus an assumed output of `approxOutputChars` characters.
 */
export function ocrPageCost(cfg: DocImportConfig, approxOutputChars = 800, now: Date = new Date()): OcrPageCost {
  const peak = isPeakBeijing(now)
  const outputTokens = estimateTokens(' '.repeat(approxOutputChars))
  const inputTokens = cfg.ocrImageTokensPerPage
  const cnyPeak = (inputTokens / 1e6) * cfg.priceOcrPeakInputPerMTok + (outputTokens / 1e6) * cfg.priceOcrPeakOutputPerMTok
  const cnyOffPeak = (inputTokens / 1e6) * cfg.priceOcrOffPeakInputPerMTok + (outputTokens / 1e6) * cfg.priceOcrOffPeakOutputPerMTok
  return { inputTokens, outputTokens, cnyPeak, cnyOffPeak, isPeak: peak, cny: peak ? cnyPeak : cnyOffPeak }
}

/** Format a CNY amount for display. */
export function formatCny(cny: number): string {
  if (cny < 0.01) return `¥${cny.toFixed(4)}`
  return `¥${cny.toFixed(2)}`
}

/**
 * The one cost shape every route response and the client agree on — defined
 * here (dependency-free) so host routes and the browser half share the type
 * instead of hand-writing it per file.
 */
export interface CostView {
  tokens: number
  cny: number
  ocrCny: number
  label: string
}
