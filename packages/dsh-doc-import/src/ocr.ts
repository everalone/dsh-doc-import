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
import { pushWarning, type DocStore, type DocMeta, type PdfPageRecord } from './store.js'

const OCR_PROMPT =
  '逐字转录这张扫描页的全部文字，保留原有换行与段落结构，按阅读顺序输出。'
  + '若页面上没有任何文字，只回复 [EMPTY]。只输出页面文字本身，不要任何解释、标题或补充。'

interface VisionChoice {
  message?: { content?: string }
  finish_reason?: string
}

interface VisionResponse {
  choices?: VisionChoice[]
}

/** One raw vision-endpoint call: returns the transcription and its finish reason. */
async function requestTranscription(cfg: DocImportConfig, apiKey: string, png: Buffer, signal: AbortSignal, maxTokens: number): Promise<{ text: string; finishReason: string }> {
  const base = cfg.ocrBaseURL.replace(/\/+$/, '')
  const endpoint = `${base}/chat/completions`
  // `thinking` is a DeepSeek extension: sending it to a generic OpenAI-compatible
  // endpoint can 400. Only include it when the target looks like DeepSeek.
  const deepseek = /deepseek/i.test(cfg.ocrBaseURL) || /deepseek/i.test(cfg.ocrModel)
  const payloadBody: Record<string, unknown> = {
    model: cfg.ocrModel,
    max_tokens: maxTokens,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: OCR_PROMPT },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } },
        ],
      },
    ],
  }
  if (deepseek) payloadBody.thinking = { type: 'disabled' }
  const body = JSON.stringify(payloadBody)
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
  return { text: content === '[EMPTY]' ? '' : content, finishReason: payload.choices?.[0]?.finish_reason ?? '' }
}

/**
 * Transcribe one page, guarding against silent truncation: when the output
 * hits the token cap (finish_reason "length"), retry once with a doubled
 * budget before giving up and flagging the page as possibly truncated.
 */
async function transcribePage(cfg: DocImportConfig, apiKey: string, png: Buffer, signal: AbortSignal): Promise<{ text: string; truncated: boolean }> {
  const first = await requestTranscription(cfg, apiKey, png, signal, cfg.ocrMaxOutputTokens)
  if (first.finishReason !== 'length') return { text: first.text, truncated: false }
  const doubled = Math.min(cfg.ocrMaxOutputTokens * 2, 32768)
  const second = await requestTranscription(cfg, apiKey, png, signal, doubled)
  if (second.finishReason !== 'length') return { text: second.text, truncated: false }
  return { text: second.text, truncated: true }
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
  /** Whether a background OCR job is currently running for the document. */
  isRunning(docId: string): boolean
}

export function createOcrRunner(ctx: Context, store: DocStore, getCfg: () => DocImportConfig): OcrRunner {
  const running = new Map<string, Promise<void>>()

  async function run(docId: string): Promise<void> {
    const meta = store.registry.get(docId)
    if (meta === undefined) return
    const cfg = getCfg()
    const pages = await store.readPages(docId)
    if (pages === null) return
    const byN = new Map(pages.map((page) => [page.n, page]))
    // Failed pages (ocrText empty, ocrError set) come back into the todo list,
    // so re-triggering OCR retries them.
    const todo = pages.filter((p) => p.source === 'ocr' && (p.ocrText ?? '').length === 0).map((p) => p.n)
    if (todo.length === 0) {
      meta.ocrTotal = 0
      meta.ocrDone = 0
      await store.writeMeta(meta)
      return
    }
    // Page cap 0 means "unlimited" (as the settings card promises).
    const capped = cfg.ocrPageCap > 0 && todo.length > cfg.ocrPageCap ? todo.slice(0, cfg.ocrPageCap) : todo
    if (capped.length < todo.length) {
      meta.ocrSkipped = todo.length - capped.length
      pushWarning(meta, `OCR 页数超过 ${cfg.ocrPageCap} 页上限，跳过 ${meta.ocrSkipped} 页`)
      for (const n of todo.slice(capped.length)) {
        const page = byN.get(n)
        if (page !== undefined) page.ocrText = `【第 ${n} 页 · OCR 超出页数上限已跳过】`
      }
    }
    meta.ocrTotal = capped.length
    meta.ocrDone = 0
    await store.writeMeta(meta)
    if (capped.length === 0) return

    try {
      let apiKey: string
      try {
        apiKey = await resolveApiKey(ctx, cfg)
      } catch (error) {
        pushWarning(meta, `OCR 未执行：${(error as Error).message}`)
        for (const n of capped) {
          const page = byN.get(n)
          if (page !== undefined) page.ocrError = '未配置 API Key'
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
          const page = byN.get(n)
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
              const result = await transcribePage(cfg, apiKey, png, controller.signal)
              page.ocrText = result.text.length === 0 ? '（空白页）' : result.text
              if (result.truncated) {
                page.ocrText += '\n\n【OCR 输出达到 token 上限，可能截断】'
                pushWarning(meta, `第 ${n} 页 OCR 输出达到 token 上限，可能截断`)
              }
              page.ocrError = undefined
              done = true
            } catch (error) {
              lastError = error
            } finally {
              clearTimeout(timer)
            }
          }
          if (!done) {
            // Retryable failure: keep ocrText empty + record ocrError so the
            // page re-enters the todo list on the next OCR trigger.
            page.ocrError = String((lastError as Error)?.message ?? lastError).slice(0, 200)
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
      const failedCount = capped.filter((n) => byN.get(n)?.ocrError !== undefined).length
      if (failedCount > 0) {
        pushWarning(finalMeta, `OCR 失败 ${failedCount} 页，重新发送 OCR 请求可重试失败页`)
      }
      await store.writeMeta(finalMeta)
    } catch (error) {
      // Fatal job error (storage failure, unexpected throw): settle the meta so
      // the status route reaches a terminal state instead of hanging clients —
      // failed pages stay retryable through the next /doc-import/ocr POST.
      const message = ((error as Error)?.message ?? String(error)).slice(0, 200)
      for (const n of capped) {
        const page = byN.get(n)
        if (page !== undefined && (page.ocrText ?? '').length === 0) page.ocrError = message
      }
      meta.ocrDone = meta.ocrTotal
      pushWarning(meta, `OCR 中断：${message}`)
      await store.writePages(docId, pages).catch(() => {})
      await store.writeText(docId, assemblePdfText(pages, (n) => `【第 ${n} 页 · 扫描页文本待 OCR】`), meta).catch(() => {})
    }
  }

  return {
    start(docId) {
      if (running.has(docId)) return
      const job = run(docId)
        .catch((error) => {
          const meta = store.registry.get(docId)
          if (meta !== undefined) {
            pushWarning(meta, `OCR 失败：${(error as Error)?.message ?? String(error)}`)
            void store.writeMeta(meta).catch(() => {})
          }
        })
        .finally(() => {
          running.delete(docId)
        })
      running.set(docId, job)
    },
    isRunning(docId) {
      return running.has(docId)
    },
  }
}
