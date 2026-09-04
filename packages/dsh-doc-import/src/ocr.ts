/**
 * Scanned-page OCR: renders each candidate page to PNG and asks the vision
 * model (deepseek-v4-flash-vision-exp by default) to transcribe it verbatim.
 * Runs as a background job per document: page-level concurrency, one retry,
 * the configured page cap, and progress written into the doc meta on every
 * completed page so the status route can report live progress.
 * @module dsh-doc-import/ocr
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { assemblePdfText } from './parsers.js'
import { renderPagePng } from './pdf.js'
import type { DocImportConfig } from './config.js'
import type { DocStore, DocMeta, PdfPageRecord } from './store.js'

const OCR_PROMPT =
  '逐字转录这张扫描页的全部文字，保留原有换行与段落结构，按阅读顺序输出。'
  + '若页面上没有任何文字，只回复 [EMPTY]。只输出页面文字本身，不要任何解释、标题或补充。'

interface VisionResponse {
  choices?: Array<{ message?: { content?: string } }>
}

async function transcribePage(cfg: DocImportConfig, apiKey: string, png: Buffer, signal: AbortSignal): Promise<string> {
  const base = cfg.ocrBaseURL.replace(/\/+$/, '')
  const endpoint = `${base}/chat/completions`
  const body = JSON.stringify({
    model: cfg.ocrModel,
    max_tokens: cfg.ocrMaxOutputTokens,
    // Transcription needs no chain-of-thought: cut latency and output cost.
    thinking: { type: 'disabled' },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: OCR_PROMPT },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } },
        ],
      },
    ],
  })
  const response = await fetch(endpoint, {
    method: 'POST',
    signal,
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body,
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`OCR 端点返回 ${response.status}${detail ? `：${detail.slice(0, 200)}` : ''}`)
  }
  const payload = (await response.json()) as VisionResponse
  const content = payload.choices?.[0]?.message?.content?.trim() ?? ''
  if (content === '') throw new Error('OCR 端点返回了空内容')
  return content === '[EMPTY]' ? '' : content
}

async function resolveApiKey(ctx: Context, cfg: DocImportConfig): Promise<string> {
  if (cfg.ocrApiKey.trim().length > 0) return cfg.ocrApiKey
  const envName = cfg.ocrApiKeyEnv.trim()
  if (envName.length > 0) {
    const credentials = ctx.get('credentials') as { resolve(ref: ReturnType<typeof credentialRef>): Promise<{ value: string } | undefined> } | undefined
    if (credentials !== undefined) {
      const hit = await credentials.resolve(credentialRef(envName))
      if (hit !== undefined && hit.value.length > 0) return hit.value
    }
    const ambient = process.env[envName]
    if (ambient !== undefined && ambient.length > 0) return ambient
  }
  throw new Error('doc-import OCR：未配置 API Key（设置 ocrApiKey 或在凭证服务中存储 ocrApiKeyEnv）')
}

export interface OcrRunner {
  /** Start the OCR job for a document; no-op when it already ran or is running. */
  start(docId: string): void
}

export function createOcrRunner(ctx: Context, store: DocStore, getCfg: () => DocImportConfig): OcrRunner {
  const running = new Map<string, Promise<void>>()

  async function run(docId: string): Promise<void> {
    const meta = store.registry.get(docId)
    if (meta === undefined) return
    if (meta.ocrTotal > 0 && meta.ocrDone >= meta.ocrTotal) return
    const cfg = getCfg()
    const pages = await store.readPages(docId)
    if (pages === null) return
    const todo = pages.filter((p) => p.source === 'ocr' && (p.ocrText ?? '').length === 0).map((p) => p.n)
    if (todo.length === 0) {
      meta.ocrTotal = 0
      meta.ocrDone = 0
      await store.writeMeta(meta)
      return
    }
    let capped = todo
    if (todo.length > cfg.ocrPageCap) {
      capped = todo.slice(0, cfg.ocrPageCap)
      meta.ocrSkipped = todo.length - cfg.ocrPageCap
      meta.warning = [meta.warning, `OCR 页数超过 ${cfg.ocrPageCap} 页上限，跳过 ${meta.ocrSkipped} 页`].filter(Boolean).join('；')
      for (const n of todo.slice(cfg.ocrPageCap)) {
        const page = pages.find((p) => p.n === n)
        if (page !== undefined) page.ocrText = `【第 ${n} 页 · OCR 超出页数上限已跳过】`
      }
    }
    meta.ocrTotal = capped.length
    meta.ocrDone = 0
    await store.writeMeta(meta)
    if (capped.length === 0) return

    let apiKey: string
    try {
      apiKey = await resolveApiKey(ctx, cfg)
    } catch (error) {
      meta.warning = [meta.warning, `OCR 未执行：${(error as Error).message}`].filter(Boolean).join('；')
      for (const n of capped) {
        const page = pages.find((p) => p.n === n)
        if (page !== undefined) page.ocrText = `【第 ${n} 页 · OCR 未执行】`
      }
      meta.ocrDone = meta.ocrTotal
      await store.writePages(docId, pages)
      await store.writeText(docId, assemblePdfText(pages, (n) => `【第 ${n} 页 · 扫描页文本待 OCR】`), meta)
      return
    }

    let cursor = 0
    const worker = async (): Promise<void> => {
      while (cursor < capped.length) {
        const index = cursor
        cursor += 1
        const n = capped[index]
        const page = pages.find((p) => p.n === n)
        if (page === undefined) {
          meta.ocrDone += 1
          continue
        }
        let lastError: unknown
        let done = false
        for (let attempt = 0; attempt < 2 && !done; attempt += 1) {
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(new Error('OCR 请求超时')), cfg.ocrTimeoutMs)
          try {
            const original = await store.readOriginal(docId)
            const png = await renderPagePng(original, n, cfg.ocrImageScale)
            const text = await transcribePage(cfg, apiKey, png, controller.signal)
            page.ocrText = text.length === 0 ? '（空白页）' : text
            done = true
          } catch (error) {
            lastError = error
          } finally {
            clearTimeout(timer)
          }
        }
        if (!done) {
          page.ocrText = `【第 ${n} 页 · OCR 失败：${(lastError as Error)?.message ?? String(lastError)}】`
        }
        meta.ocrDone += 1
        const updated = { ...meta }
        updated.chars = pages.reduce((sum, p) => sum + ((p.ocrText ?? p.text).length), 0)
        await store.writePages(docId, pages)
        await store.writeText(docId, assemblePdfText(pages, (p) => `【第 ${p} 页 · 扫描页文本待 OCR】`), updated)
      }
    }

    const workers = Array.from({ length: Math.min(cfg.ocrConcurrency, capped.length) }, () => worker())
    await Promise.all(workers)
    const finalMeta = { ...store.registry.get(docId) ?? meta }
    finalMeta.ocrDone = finalMeta.ocrTotal
    finalMeta.chars = pages.reduce((sum, p) => sum + ((p.ocrText ?? p.text).length), 0)
    await store.writeMeta(finalMeta)
  }

  return {
    start(docId) {
      if (running.has(docId)) return
      const job = run(docId)
        .catch((error) => {
          const meta = store.registry.get(docId)
          if (meta !== undefined) {
            meta.warning = [meta.warning, `OCR 失败：${(error as Error)?.message ?? String(error)}`].filter(Boolean).join('；')
            void store.writeMeta(meta).catch(() => {})
          }
        })
        .finally(() => {
          running.delete(docId)
        })
      running.set(docId, job)
    },
  }
}

export { assemblePdfText }
export type { PdfPageRecord, DocMeta }
