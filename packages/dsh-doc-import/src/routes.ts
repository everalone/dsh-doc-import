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
import { formatCny, inlineCost, ocrPageCost } from './cost.js'
import { isLoopbackRequest, readJsonBody, writeJson } from './http.js'
import type { DocImportConfig } from './config.js'
import type { OcrRunner } from './ocr.js'
import { assemblePdfText, detectKind, parseDocument, DOC_KINDS, EXTRACTOR_VERSION, KIND_LABELS } from './parsers.js'
import { docIdFor, type DocMeta, type DocStore } from './store.js'

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

/** The `[document …]` header the client inlines above the text. */
export function buildDocumentHeader(meta: DocMeta, cfg: DocImportConfig): string {
  const parts: string[] = [meta.name, KIND_LABELS[meta.kind as keyof typeof KIND_LABELS] ?? meta.kind]
  if (meta.pages > 0) parts.push(`${meta.pages} 页`)
  parts.push(`${meta.chars} 字符`)
  if (meta.truncated) parts.push(`内联截断至 ${meta.inlineChars} 字符，可用 read_document 回读全文`)
  parts.push(`id: ${meta.id}`)
  return `[document ${parts.join(', ')}]`
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
    if (existing !== undefined && existing.kind === kind && existing.extractor === EXTRACTOR_VERSION) {
      const text = await store.readText(id)
      const capped = capText(text, cfg.inlineCap)
      writeJson(res, 200, { ok: true, doc: attachView(cfg, existing, capped.text, capped.truncated) })
      return
    }
    // Fresh parse, or a stored document whose text predates the current
    // extraction pipeline: re-extract now, preserving OCR page results by
    // page number so upgrading never re-spends OCR money.
    if (existing !== undefined && existing.kind === kind) {
      const oldPages = await store.readPages(id)
      if (parsed.pages !== undefined && oldPages !== null) {
        for (const page of parsed.pages) {
          const old = oldPages.find((candidate) => candidate.n === page.n)
          if (page.source === 'ocr' && old?.ocrText !== undefined && old.ocrText.length > 0) page.ocrText = old.ocrText
        }
      }
      const refreshed: DocMeta = {
        ...existing,
        name,
        mediaType,
        bytes: bytes.length,
        chars: parsed.text.length,
        inlineChars: 0,
        truncated: false,
        pages: parsed.pages?.length ?? 0,
        ocrPages: parsed.ocrCandidates,
        ocrDone: 0,
        ocrTotal: 0,
        ocrSkipped: 0,
        warning: parsed.warnings.join('；'),
        extractor: EXTRACTOR_VERSION,
      }
      await store.save(refreshed, bytes, parsed.text, parsed.pages)
      if (parsed.ocrCandidates.length > 0 && cfg.ocrEnabled) {
        refreshed.ocrTotal = parsed.ocrCandidates.length
        await store.writeMeta(refreshed)
        ocr.start(id)
      } else if (parsed.ocrCandidates.length > 0) {
        refreshed.warning = [refreshed.warning, `OCR 已禁用，${parsed.ocrCandidates.length} 个扫描页无文本内容`].filter(Boolean).join('；')
        await store.writeMeta(refreshed)
      }
      const text = await store.readText(id)
      const capped = capText(text, cfg.inlineCap)
      writeJson(res, 200, { ok: true, doc: attachView(cfg, refreshed, capped.text, capped.truncated) })
      return
    }
    const meta: DocMeta = {
      id,
      name,
      kind,
      mediaType,
      bytes: bytes.length,
      chars: parsed.text.length,
      inlineChars: 0,
      truncated: false,
      pages: parsed.pages?.length ?? 0,
      ocrPages: parsed.ocrCandidates,
      ocrDone: 0,
      ocrTotal: 0,
      ocrSkipped: 0,
      warning: parsed.warnings.join('；'),
      createdAt: Date.now(),
      extractor: EXTRACTOR_VERSION,
    }
    await store.save(meta, bytes, parsed.text, parsed.pages)
    if (parsed.ocrCandidates.length > 0 && cfg.ocrEnabled) {
      meta.ocrTotal = parsed.ocrCandidates.length
      await store.writeMeta(meta)
      ocr.start(id)
    } else if (parsed.ocrCandidates.length > 0) {
      meta.warning = [meta.warning, `OCR 已禁用，${parsed.ocrCandidates.length} 个扫描页无文本内容`].filter(Boolean).join('；')
      await store.writeMeta(meta)
    }
    const text = await store.readText(id)
    const capped = capText(text, cfg.inlineCap)
    writeJson(res, 200, { ok: true, doc: attachView(cfg, meta, capped.text, capped.truncated) })
  } catch (error) {
    writeJson(res, 422, { ok: false, error: { code: 'rejected', message: (error as Error).message } })
  }
}

function attachView(cfg: DocImportConfig, meta: DocMeta, text: string, truncated: boolean) {
  const inline = inlineCost(text, cfg)
  const ocrCount = meta.ocrTotal > 0 ? meta.ocrTotal : meta.ocrPages.length
  const ocrCost = ocrCount > 0 ? ocrPageCost(cfg) : undefined
  const ocrNeeded = meta.ocrPages.length > 0 && meta.ocrTotal > 0
  return {
    id: meta.id,
    name: meta.name,
    kind: meta.kind,
    bytes: meta.bytes,
    chars: meta.chars,
    pages: meta.pages,
    ocrNeeded,
    ocrCount,
    header: buildDocumentHeader(meta, cfg),
    text,
    truncated,
    warning: meta.warning.length > 0 ? meta.warning : undefined,
    cost: {
      tokens: inline.tokens,
      cny: inline.cny,
      cnyOffPeak: inline.cnyOffPeak,
      cnyPeak: inline.cnyPeak,
      isPeak: inline.isPeak,
      ocrCny: ocrCost?.cny ?? 0,
      ocrCnyPeak: ocrCost?.cnyPeak ?? 0,
      ocrCnyOffPeak: ocrCost?.cnyOffPeak ?? 0,
      label: `≈ ${inline.tokens} tokens ≈ ${formatCny(inline.cny)}${ocrCost ? `（OCR ≈ ${formatCny(ocrCost.cny)}）` : ''}`,
    },
  }
}

/** Public status of one document for the browser half. */
export interface DocStatus {
  id: string
  name: string
  kind: string
  phase: 'parsing' | 'ocr' | 'ready' | 'error'
  chars: number
  ocrDone: number
  ocrTotal: number
  text?: string
  truncated?: boolean
  warning?: string
}

async function handleStatus(store: DocStore, cfg: DocImportConfig, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x')
  const id = url.searchParams.get('id') ?? ''
  const meta = store.registry.get(id)
  if (meta === undefined) {
    writeJson(res, 404, { ok: false, error: { code: 'missing', message: '文档不存在或已被清理' } })
    return
  }
  const done = meta.ocrTotal > 0 && meta.ocrDone >= meta.ocrTotal
  const phase: DocStatus['phase'] = meta.ocrTotal > 0 && !done ? (meta.ocrDone > 0 ? 'ocr' : 'parsing') : 'ready'
  if (phase === 'ready') {
    // Full text: the conversation only carries the compact reference, so the
    // preview modal and read_document both need the uncapped extraction here.
    const full = await store.readText(id)
    const inline = inlineCost(full, cfg)
    const ocrCost = meta.ocrPages.length > 0 ? ocrPageCost(cfg) : undefined
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
        cost: {
          tokens: inline.tokens,
          cny: inline.cny,
          ocrCny: ocrCost?.cny ?? 0,
          label: `≈ ${inline.tokens} tokens ≈ ${formatCny(inline.cny)}${ocrCost ? `（OCR ≈ ${formatCny(ocrCost.cny)}）` : ''}`,
        },
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
  ocr.start(id)
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
        await handleStatus(store, getCfg(), req, res)
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

export { assemblePdfText }
