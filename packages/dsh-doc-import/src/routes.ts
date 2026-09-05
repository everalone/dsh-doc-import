/**
 * Browser-to-host route family under /doc-import/*:
 * - POST /doc-import/attach — upload one document (base64 JSON), parse it,
 *   store it, and return the inline text + header + cost estimate. Scanned
 *   PDF pages are scheduled for OCR automatically when enabled.
 * - POST /doc-import/ocr     — start (or resume) the OCR job for one doc.
 * - GET  /doc-import/status  — live progress; carries the final inline text
 *   once the document is ready.
 * All routes sit behind the loopback trust fence.
 * @module dsh-doc-import/routes
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { formatCny, inlineCost, ocrPageCost, type CostView } from './cost.js'
import { isLoopbackRequest, readJsonBody, writeJson } from './http.js'
import type { DocImportConfig } from './config.js'
import { estimateOcrBudgetMs, type OcrRunner } from './ocr.js'
import { detectKind, parseDocument, DOC_KINDS, EXTRACTOR_VERSION, KIND_LABELS, type DocKind } from './parsers.js'
import { docIdFor, pushWarning, pagesByNumber, ocrPageCount, type DocMeta, type DocStore } from './store.js'

interface AttachPayload {
  data: string
  mediaType: string
  name: string
}

function decodeBase64(data: string): Buffer | undefined {
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(data)) return undefined
  try {
    return Buffer.from(data, 'base64')
  } catch {
    return undefined
  }
}

/** Cap the assembled text at the inline limit, keeping the cut point on a character. */
function capText(text: string, cap: number): { text: string; truncated: boolean } {
  if (text.length <= cap) return { text, truncated: false }
  return { text: text.slice(0, cap) + '\n\n…（已截断）', truncated: true }
}

// --- OCR (re)start policy ---------------------------------------------------

/** Futile job settles before a repeatedly failing job is declared fatal. */
const SELF_HEAL_MAX_ATTEMPTS = 3
const SELF_HEAL_BACKOFF_MS = 30_000

/**
 * In-memory pacing only (one heal attempt per backoff window). Correctness —
 * the budget itself — lives in `DocMeta.ocrRestarts`, persisted, so a host
 * restart cannot reset the guard and resume paid restart loops; the memory
 * map only decides *when* the next attempt may fire.
 */
const healPacing = new Map<string, number>()

/**
 * Settle accounting for one OCR job. The budget resets ONLY when the document
 * actually converged — every candidate page has text and the assembled text
 * is fresh. Any other settle (pending pages, stale text) increments the
 * persisted counter. Resetting on every settle instead made the cap dead
 * code: in-process jobs always settle one way or another, so attempts never
 * passed 1 and `ocrFatal` was unreachable.
 */
function monitorOcrJob(store: DocStore, id: string, job: Promise<void>): void {
  void job.then(async () => {
    const meta = store.registry.get(id)
    if (meta === undefined) return
    const pages = await store.readPages(id)
    const healthy = meta.textStale !== true
      && pages !== null
      && !pages.some((page) => page.source === 'ocr' && (page.ocrText ?? '').length === 0)
    if (healthy) {
      if (meta.ocrFatal !== undefined || meta.ocrRestarts !== undefined) {
        delete meta.ocrFatal
        meta.ocrRestarts = 0
        await store.writeMeta(meta).catch(() => {})
      }
      return
    }
    meta.ocrRestarts = (meta.ocrRestarts ?? 0) + 1
    await store.writeMeta(meta).catch(() => {})
  })
}

/**
 * Explicit (re)start from attach or the manual OCR route. Clears the fatal
 * marker and the restart budget and persists that BEFORE kicking the job off
 * — clearing only in memory left a fatal flag on disk that a mid-job crash
 * would resurrect as a stuck `error` document nothing self-heals.
 */
async function startOcr(ocr: OcrRunner, store: DocStore, id: string): Promise<void> {
  const meta = store.registry.get(id)
  if (meta !== undefined) {
    delete meta.ocrFatal
    meta.ocrRestarts = 0
    healPacing.delete(id)
    await store.writeMeta(meta).catch(() => {})
  }
  const job = ocr.start(id)
  if (job !== undefined) monitorOcrJob(store, id, job)
}

/**
 * Self-healing restart for stalled jobs, with a persisted, capped, backed-off
 * retry budget. Unguarded, every status poll (700 ms client / 2 s preview) of
 * a job that keeps dying launched a fresh paid OCR run — the hang the
 * self-heal was meant to remove, resurrected as an infinite billing loop.
 * Past the budget the doc settles into the terminal `error` phase; an
 * explicit re-import or manual OCR call resets the budget.
 */
async function ensureOcrStarted(store: DocStore, cfg: DocImportConfig, ocr: OcrRunner, id: string): Promise<void> {
  const meta = store.registry.get(id)
  if (meta === undefined || !cfg.ocrEnabled || meta.ocrFatal !== undefined) return
  const converged = meta.ocrTotal === 0 || meta.ocrDone >= meta.ocrTotal
  // A converged doc with stale text still needs a (free, no-API) regen pass.
  if (converged && meta.textStale !== true) return
  const restarts = meta.ocrRestarts ?? 0
  if (restarts >= SELF_HEAL_MAX_ATTEMPTS) {
    const message = `OCR 作业连续 ${restarts} 次未能收敛（可能存储异常），已停止自动重启；重新发送该文档或手动重试可恢复`
    meta.ocrFatal = { message, attempts: restarts, at: Date.now() }
    pushWarning(meta, message)
    await store.writeMeta(meta).catch(() => {})
    return
  }
  const backoff = restarts === 0 ? 0 : Math.min(SELF_HEAL_BACKOFF_MS * 2 ** (restarts - 1), 300_000)
  const lastAt = healPacing.get(id) ?? 0
  if (Date.now() - lastAt < backoff) return
  healPacing.set(id, Date.now())
  const job = ocr.start(id)
  if (job !== undefined) monitorOcrJob(store, id, job)
}

/** The `[document …]` header the client inlines above the text. */
export function buildDocumentHeader(meta: DocMeta, cfg: DocImportConfig): string {
  const parts: string[] = [meta.name, KIND_LABELS[meta.kind] ?? meta.kind]
  if (meta.pages > 0) parts.push(`${meta.pages} 页`)
  parts.push(`${meta.chars} 字符`)
  parts.push(`id: ${meta.id}`)
  const header = `[document ${parts.join(', ')}]`
  // The id is opaque. A model that misses the read_document tool description
  // has been observed to treat it as a file path and grep the whole disk for
  // it (freezing the session) — state the read path right in the message.
  return header + '\n（如需全文，调用 read_document 工具并传入上面的 id；id 不是文件路径，在磁盘上搜不到。）'
}

async function handleAttach(ctx: Context, cfg: DocImportConfig, store: DocStore, ocr: OcrRunner, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const bodyCap = Math.ceil(cfg.maxUploadBytes / 3) * 4 + 4096
  const body = await readJsonBody(req, bodyCap)
  if (body === null) {
    writeJson(res, 400, { ok: false, error: { code: 'rejected', message: '请求体必须是 JSON 且不超过上传上限' } })
    return
  }
  const record = body as Record<string, unknown>
  const { data, mediaType, name } = record
  if (typeof data !== 'string' || data.length === 0) {
    writeJson(res, 422, { ok: false, error: { code: 'rejected', message: 'data 必须是非空 base64 字符串' } })
    return
  }
  if (typeof mediaType !== 'string' || typeof name !== 'string' || name.length === 0) {
    writeJson(res, 422, { ok: false, error: { code: 'rejected', message: 'mediaType 与 name 必填' } })
    return
  }
  const bytes = decodeBase64(data)
  if (bytes === undefined || bytes.length === 0) {
    writeJson(res, 422, { ok: false, error: { code: 'rejected', message: 'data 不是有效的 base64' } })
    return
  }
  if (bytes.length > cfg.maxUploadBytes) {
    writeJson(res, 422, { ok: false, error: { code: 'rejected', message: `文件 ${bytes.length} 字节，超过 ${cfg.maxUploadBytes} 字节上限` } })
    return
  }
  const kind = detectKind(name, mediaType)
  if (kind === undefined) {
    writeJson(res, 422, { ok: false, error: { code: 'rejected', message: `不支持的文档类型（支持 ${DOC_KINDS.map((k) => `.${k}`).join(' / ')}）` } })
    return
  }
  try {
    const parsed = await parseDocument(bytes, name, mediaType, cfg)
    const id = docIdFor(bytes)
    const existing = store.registry.get(id)
    // Same content, same kind, same extractor: serve the stored text. But
    // never strand scanned pages — a doc imported while OCR was disabled or
    // interrupted mid-job still has candidate pages without OCR text, and
    // gets its OCR (re)started here. The trigger is "a candidate page has no
    // OCR text": `ocrTotal === 0` was a wrong proxy that re-launched empty
    // jobs on every re-import of a finished document.
    if (existing !== undefined && existing.kind === kind && existing.extractor === EXTRACTOR_VERSION) {
      const storedPages = await store.readPages(id)
      const hasPendingOcr = storedPages !== null
        && storedPages.some((page) => page.source === 'ocr' && (page.ocrText ?? '').length === 0)
      if (cfg.ocrEnabled && existing.ocrPages.length > 0 && (hasPendingOcr || existing.textStale === true)) {
        if (existing.ocrTotal === 0) existing.ocrTotal = existing.ocrPages.length
        await startOcr(ocr, store, id)
      }
      const text = await store.readText(id)
      const capped = capText(text, cfg.inlineCap)
      writeJson(res, 200, { ok: true, doc: attachView(cfg, existing, capped.text, capped.truncated) })
      return
    }
    // Fresh parse, or a stored document whose text predates the current
    // extraction pipeline: re-extract now, preserving OCR page results by
    // page number so upgrading never re-spends OCR money. Old failure/
    // skip markers (【…】) are not results: leaving them uncopied lets the
    // retryable OCR path re-run those pages under the current scheme.
    if (existing !== undefined && existing.kind === kind) {
      const oldPages = await store.readPages(id)
      if (parsed.pages !== undefined && oldPages !== null) {
        const oldByN = pagesByNumber(oldPages)
        for (const page of parsed.pages) {
          const old = oldByN.get(page.n)
          if (page.source === 'ocr' && old?.ocrText !== undefined && old.ocrText.length > 0 && !old.ocrText.startsWith('【')) page.ocrText = old.ocrText
        }
      }
    }
    const prior = existing !== undefined && existing.kind === kind ? existing : undefined
    const savedMeta: DocMeta = {
      id,
      name,
      kind,
      mediaType,
      bytes: bytes.length,
      chars: parsed.text.length,
      pages: parsed.pages?.length ?? 0,
      ocrPages: parsed.ocrCandidates,
      ocrDone: 0,
      ocrTotal: 0,
      ocrSkipped: 0,
      warning: parsed.warnings.join('；'),
      createdAt: prior?.createdAt ?? Date.now(),
      extractor: EXTRACTOR_VERSION,
    }
    await store.save(savedMeta, bytes, parsed.text, parsed.pages)
    if (parsed.ocrCandidates.length > 0 && cfg.ocrEnabled) {
      savedMeta.ocrTotal = parsed.ocrCandidates.length
      await store.writeMeta(savedMeta)
      await startOcr(ocr, store, id)
    } else if (parsed.ocrCandidates.length > 0) {
      pushWarning(savedMeta, `OCR 已禁用，${parsed.ocrCandidates.length} 个扫描页无文本内容`)
      await store.writeMeta(savedMeta)
    }
    const text = await store.readText(id)
    const capped = capText(text, cfg.inlineCap)
    writeJson(res, 200, { ok: true, doc: attachView(cfg, savedMeta, capped.text, capped.truncated) })
  } catch (error) {
    writeJson(res, 422, { ok: false, error: { code: 'rejected', message: (error as Error).message } })
  }
}

/** The one cost shape every route and the client agree on (type lives in cost.ts). */
function costView(cfg: DocImportConfig, meta: DocMeta, text: string): CostView {
  const inline = inlineCost(text, cfg)
  const ocrCost = ocrPageCount(meta) > 0 ? ocrPageCost(cfg) : undefined
  return {
    tokens: inline.tokens,
    cny: inline.cny,
    ocrCny: ocrCost?.cny ?? 0,
    label: `≈ ${inline.tokens} tokens ≈ ${formatCny(inline.cny)}${ocrCost ? `（OCR ≈ ${formatCny(ocrCost.cny)}）` : ''}`,
  }
}

function attachView(cfg: DocImportConfig, meta: DocMeta, text: string, truncated: boolean) {
  const ocrNeeded = meta.ocrPages.length > 0 && meta.ocrTotal > 0
  return {
    id: meta.id,
    name: meta.name,
    kind: meta.kind,
    bytes: meta.bytes,
    chars: meta.chars,
    pages: meta.pages,
    ocrNeeded,
    ocrCount: ocrPageCount(meta),
    header: buildDocumentHeader(meta, cfg),
    text,
    truncated,
    warning: meta.warning.length > 0 ? meta.warning : undefined,
    cost: costView(cfg, meta, text),
  }
}

/** Public status of one document for the browser half. */
export interface DocStatus {
  id: string
  name: string
  kind: DocKind
  phase: 'parsing' | 'ocr' | 'ready' | 'error'
  chars: number
  ocrDone: number
  ocrTotal: number
  text?: string
  truncated?: boolean
  warning?: string
  /** Host-computed poll budget (shared math with the OCR runner); present while OCR is pending. */
  ocrBudgetMs?: number
}

async function handleStatus(store: DocStore, cfg: DocImportConfig, ocr: OcrRunner, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x')
  const id = url.searchParams.get('id') ?? ''
  const meta = store.registry.get(id)
  if (meta === undefined) {
    writeJson(res, 404, { ok: false, error: { code: 'missing', message: '文档不存在或已被清理' } })
    return
  }
  const done = meta.ocrTotal > 0 && meta.ocrDone >= meta.ocrTotal
  // Self-healing: pending pages with no live job means a previous job was lost
  // (host restart, killed worker). Restart it — capped and backed off — so the
  // status always converges to a terminal phase instead of polling forever.
  await ensureOcrStarted(store, cfg, ocr, id)
  const phase: DocStatus['phase'] = meta.ocrFatal !== undefined
    ? 'error'
    : meta.ocrTotal > 0 && !done ? (meta.ocrDone > 0 ? 'ocr' : 'parsing') : 'ready'
  if (phase === 'ready' || phase === 'error') {
    // Full text: the conversation only carries the compact reference, so the
    // preview modal and read_document both need the uncapped extraction here.
    // An error terminal still carries whatever partial text was extracted.
    const full = await store.readText(id)
    writeJson(res, 200, {
      ok: true,
      doc: {
        id: meta.id,
        name: meta.name,
        kind: meta.kind,
        phase,
        chars: meta.chars,
        ocrDone: meta.ocrDone,
        ocrTotal: meta.ocrTotal,
        text: full,
        truncated: false,
        warning: meta.warning.length > 0 ? meta.warning : undefined,
        cost: costView(cfg, meta, full),
      },
    })
    return
  }
  writeJson(res, 200, {
    ok: true,
    doc: {
      id: meta.id,
      name: meta.name,
      kind: meta.kind,
      phase,
      chars: meta.chars,
      ocrDone: meta.ocrDone,
      ocrTotal: meta.ocrTotal,
      // Shared budget math (ocr.ts): clients derive their poll deadline from
      // the same formula instead of a fixed deadline healthy large jobs
      // outlive.
      // Shared budget math (ocr.ts), sized to the REMAINING pages: clients
      // refresh their deadline on progress, so this is the no-progress bound.
      ocrBudgetMs: estimateOcrBudgetMs(cfg, Math.max(ocrPageCount(meta) - meta.ocrDone, 1)),
      warning: meta.warning.length > 0 ? meta.warning : undefined,
    },
  })
}

async function handleStartOcr(store: DocStore, ocr: OcrRunner, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req, 16 * 1024)
  const id = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).id : undefined
  if (typeof id !== 'string' || store.registry.get(id) === undefined) {
    writeJson(res, 404, { ok: false, error: { code: 'missing', message: '文档不存在或已被清理' } })
    return
  }
  await startOcr(ocr, store, id)
  writeJson(res, 200, { ok: true, started: true })
}

/** Serve the stored original bytes so the file chip can open the real document. */
async function handleRaw(store: DocStore, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const pathname = new URL(req.url ?? '/', 'http://x').pathname
  const id = pathname.slice('/doc-import/raw/'.length)
  const meta = store.registry.get(id)
  if (meta === undefined) {
    writeJson(res, 404, { ok: false, error: { code: 'missing', message: '文档不存在或已被清理' } })
    return
  }
  try {
    const bytes = await store.readOriginal(id)
    res.writeHead(200, {
      'content-type': meta.mediaType || 'application/octet-stream',
      'content-length': String(bytes.byteLength),
      'cache-control': 'private, max-age=3600',
      'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
    })
    res.end(bytes)
  } catch {
    writeJson(res, 404, { ok: false, error: { code: 'missing', message: '原始文件缺失' } })
  }
}

/** Register the /doc-import prefix route on the shared webserver. */
export function registerDocRoutes(ctx: Context, getCfg: () => DocImportConfig, store: DocStore, ocr: OcrRunner): void {
  const webserver = ctx.get('webServer') as { register(route: { kind: 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }): void } | undefined
  if (webserver === undefined) return
  webserver.register({
    kind: 'prefix',
    path: '/doc-import',
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden: loopback-only' } })
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://x').pathname
      if (pathname === '/doc-import/attach' && req.method === 'POST') {
        await handleAttach(ctx, getCfg(), store, ocr, req, res)
        return
      }
      if (pathname === '/doc-import/ocr' && req.method === 'POST') {
        await handleStartOcr(store, ocr, req, res)
        return
      }
      if (pathname === '/doc-import/status' && req.method === 'GET') {
        await handleStatus(store, getCfg(), ocr, req, res)
        return
      }
      if (pathname.startsWith('/doc-import/raw/') && req.method === 'GET') {
        await handleRaw(store, req, res)
        return
      }
      writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown /doc-import route' } })
    },
  })
}
