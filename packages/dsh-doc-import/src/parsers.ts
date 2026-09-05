/**
 * Parser registry: one parser per document kind, dispatched by extension and
 * media type. New formats are pure additions to this registry.
 * @module dsh-doc-import/parsers
 */

import mammoth from 'mammoth'
import type { DocImportConfig } from './config.js'
import { extractPdfPages } from './pdf.js'
import type { PdfPageRecord } from './store.js'

export const DOC_KINDS = ['txt', 'md', 'csv', 'docx', 'pdf'] as const
export type DocKind = (typeof DOC_KINDS)[number]

/**
 * Extraction pipeline version. Bump when the PDF text-order algorithm (or
 * any parser output shape) changes: re-importing a stored document then
 * re-extracts instead of serving the stale stored text (OCR page results
 * are preserved by page number).
 * v3: every PDF page gets a `[第 N 页]` marker; failed OCR pages carry a
 * retryable `ocrError` instead of a permanent ocrText marker.
 * v4: docx markdown is de-noised (embedded images → placeholders, empty
 * bookmarks dropped); CSV stores the full table instead of a row-capped one.
 */
export const EXTRACTOR_VERSION = 4

export const KIND_LABELS: Record<DocKind, string> = {
  txt: 'txt',
  md: 'markdown',
  csv: 'csv',
  docx: 'docx',
  pdf: 'pdf',
}

export interface ParseResult {
  kind: DocKind
  text: string
  pages?: PdfPageRecord[]
  ocrCandidates: number[]
  warnings: string[]
}

const EXT_KIND: Record<string, DocKind> = {
  txt: 'txt',
  md: 'md',
  markdown: 'md',
  csv: 'csv',
  docx: 'docx',
  pdf: 'pdf',
}

const MIME_KIND: Record<string, DocKind> = {
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/x-markdown': 'md',
  'text/csv': 'csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
}

/** Detect the document kind from the file name, falling back to the media type. */
export function detectKind(name: string, mediaType: string): DocKind | undefined {
  const dot = name.lastIndexOf('.')
  if (dot >= 0) {
    const ext = name.slice(dot + 1).toLowerCase()
    const byExt = EXT_KIND[ext]
    if (byExt !== undefined) return byExt
  }
  return MIME_KIND[mediaType.toLowerCase()]
}

/** Decode text bytes as UTF-8, falling back to GB18030 (Chinese Windows files). */
export function decodeText(bytes: Buffer): string {
  const stripBom = (s: string): string => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s)
  try {
    return stripBom(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    try {
      return stripBom(new TextDecoder('gb18030', { fatal: true }).decode(bytes))
    } catch {
      return stripBom(new TextDecoder('utf-8').decode(bytes))
    }
  }
}

/** Split one CSV line respecting double quotes. */
function splitCsvLine(line: string, delimiter: string): string[] {
  const fields: string[] = []
  let current = ''
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        current += ch
      }
    } else if (ch === '"') {
      quoted = true
    } else if (ch === delimiter) {
      fields.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  fields.push(current)
  return fields
}

function sniffDelimiter(lines: string[]): string {
  const candidates = [',', '\t', ';']
  let best = ','
  let bestScore = -1
  for (const delimiter of candidates) {
    let score = 0
    for (const line of lines.slice(0, 3)) {
      const count = splitCsvLine(line, delimiter).length
      if (count > score) score = count
    }
    if (score > bestScore) {
      bestScore = score
      best = delimiter
    }
  }
  return best
}

function escapeTableCell(cell: string): string {
  return cell.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim()
}

function parseCsv(bytes: Buffer, cfg: DocImportConfig): ParseResult {
  const warnings: string[] = []
  const raw = decodeText(bytes).replace(/^\uFEFF/, '')
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0)
  if (lines.length === 0) return { kind: 'csv', text: '', ocrCandidates: [], warnings: ['CSV 文件为空'] }
  const delimiter = sniffDelimiter(lines)
  const rows = lines.map((line) => splitCsvLine(line, delimiter))
  const columns = Math.max(...rows.map((r) => r.length))
  // Full table, always: the conversation carries only a compact reference, so
  // nothing is gained by dropping rows here — and the read_document promise
  // ("full text is stored") must hold for CSV too.
  const header = rows[0]
  const body = rows.length > 1 ? rows.slice(1) : []
  const render = (row: string[]): string => `| ${row.map(escapeTableCell).join(' | ')} |`
  const parts = [render(header), `| ${header.map(() => '---').join(' | ')} |`, ...body.map(render)]
  if (rows.length > cfg.maxInlineTableRows) {
    warnings.push(`CSV 共 ${rows.length} 行（${columns} 列），全部内容已入库；超长表格建议用 read_document 分页读取`)
  }
  return { kind: 'csv', text: parts.join('\n'), ocrCandidates: [], warnings }
}

/**
 * Clean mammoth markdown output for model consumption: embedded images become
 * short placeholders (a single logo can be 100KB+ of base64 — pure noise that
 * makes models degenerate into echoing random strings), empty bookmark
 * anchors are dropped, and runs of blank lines are collapsed.
 */
export function sanitizeDocxMarkdown(raw: string): { text: string; images: number } {
  let text = raw.replace(/!\[[\s\S]*?\]\(data:[^)]{8,}\)/g, '【图片】')
  text = text.replace(/data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]{64,}/g, '【图片】')
  text = text.replace(/<a id="[^"]*"><\/a>/g, '')
  text = text.replace(/\n{3,}/g, '\n\n')
  const images = (raw.match(/data:image\/[a-z+]+;base64,/g) ?? []).length
  return { text, images }
}

async function parseDocx(bytes: Buffer): Promise<ParseResult> {
  const warnings: string[] = []
  const mammothMarkdown = mammoth as unknown as {
    convertToMarkdown(input: { buffer: Buffer }, options?: unknown): Promise<{ value: string; messages: Array<{ message: string }> }>
  }
  try {
    const result = await mammothMarkdown.convertToMarkdown({ buffer: bytes })
    for (const message of result.messages.slice(0, 5)) warnings.push(message.message)
    const { text, images } = sanitizeDocxMarkdown(result.value)
    if (images > 0) warnings.push(`文档含 ${images} 张内嵌图片，文本中以【图片】占位（图片内容未提取）`)
    if (text.trim().length === 0 && result.value.trim().length > 0) {
      warnings.push('docx 除图片外未提取到文本（可能全部为图片）')
    } else if (result.value.trim().length === 0) {
      warnings.push('docx 未提取到文本（可能全部为图片）')
    }
    return { kind: 'docx', text, ocrCandidates: [], warnings }
  } catch {
    return { kind: 'docx', text: '', ocrCandidates: [], warnings: ['docx 解析失败：文件可能损坏或不是有效的 docx'] }
  }
}

/**
 * Assemble per-page PDF records into the inline text. Every page gets a
 * `[第 N 页]` marker (OCR pages `[第 N 页 · OCR]`) so the model can cite
 * pages and the reader can spot order problems. Failed OCR pages show a
 * 【OCR 失败】 body but stay retryable (ocrError set, ocrText empty).
 */
export function assemblePdfText(pages: PdfPageRecord[], ocrPendingLabel: (n: number) => string): string {
  return pages
    .map((page) => {
      if (page.source !== 'ocr') {
        return `\n\n[第 ${page.n} 页]\n${page.text}`
      }
      const header = `[第 ${page.n} 页 · OCR]`
      if (page.ocrText !== undefined && page.ocrText.length > 0) {
        return `\n\n${header}\n${page.ocrText}`
      }
      if (page.ocrError !== undefined && page.ocrError.length > 0) {
        return `\n\n${header}\n【第 ${page.n} 页 · OCR 失败：${page.ocrError}】`
      }
      return `\n\n${header}\n${ocrPendingLabel(page.n)}`
    })
    .join('')
}

async function parsePdf(bytes: Buffer, cfg: DocImportConfig): Promise<ParseResult> {
  const warnings: string[] = []
  const extracted = await extractPdfPages(bytes)
  if (extracted.length > cfg.maxPdfPages) {
    throw new Error(`PDF 共 ${extracted.length} 页，超过 ${cfg.maxPdfPages} 页上限`)
  }
  const pages: PdfPageRecord[] = extracted.map((page) => ({
    n: page.n,
    source: page.chars < cfg.ocrBlankThreshold ? 'ocr' : 'text',
    text: page.text,
  }))
  const ocrCandidates = pages.filter((p) => p.source === 'ocr').map((p) => p.n)
  if (ocrCandidates.length > 0) {
    warnings.push(`检测到 ${ocrCandidates.length} 个无文本层页面（第 ${ocrCandidates.slice(0, 10).join(', ')}${ocrCandidates.length > 10 ? '…' : ''} 页）`)
  }
  const text = assemblePdfText(pages, (n) => `【第 ${n} 页 · 扫描页文本待 OCR】`)
  return { kind: 'pdf', text, pages, ocrCandidates, warnings }
}

type Parser = (bytes: Buffer, cfg: DocImportConfig) => Promise<ParseResult>

const PARSERS: Record<DocKind, Parser> = {
  txt: async (bytes) => ({ kind: 'txt', text: decodeText(bytes), ocrCandidates: [], warnings: [] }),
  md: async (bytes) => ({ kind: 'md', text: decodeText(bytes), ocrCandidates: [], warnings: [] }),
  csv: async (bytes, cfg) => parseCsv(bytes, cfg),
  docx: async (bytes) => parseDocx(bytes),
  pdf: async (bytes, cfg) => parsePdf(bytes, cfg),
}

/** Parse document bytes by detected kind. Throws for unsupported kinds. */
export async function parseDocument(bytes: Buffer, name: string, mediaType: string, cfg: DocImportConfig): Promise<ParseResult> {
  const kind = detectKind(name, mediaType)
  if (kind === undefined) {
    if (/\.doc$/i.test(name)) {
      throw new Error('暂不支持老版 .doc（Word 97-2003）格式：请先在 Word 中另存为 .docx，或导出为 PDF 后再导入')
    }
    throw new Error(`不支持的文档类型：${name}（支持 ${DOC_KINDS.map((k) => `.${k}`).join(' / ')}）`)
  }
  if (bytes.length === 0) throw new Error('文件为空')
  return await PARSERS[kind](bytes, cfg)
}
