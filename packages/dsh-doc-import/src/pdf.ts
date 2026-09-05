/**
 * PDF text-layer extraction and page rasterization via pdfjs-dist v6, whose
 * main build ships a built-in NodeCanvasFactory backed by @napi-rs/canvas.
 * Text extraction needs no canvas; rasterization (for OCR) passes a canvas
 * object straight to page.render.
 * @module dsh-doc-import/pdf
 */

import { createCanvas } from '@napi-rs/canvas'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'

const require = createRequire(import.meta.url)
const pdfjsRoot = dirname(require.resolve('pdfjs-dist/package.json'))

interface TextItemLike {
  str?: string
  transform?: number[]
  width?: number
  height?: number
  hasEOL?: boolean
}

interface PlacedItem {
  str: string
  x: number
  y: number
  xEnd: number
  height: number
}

interface PlacedLine {
  y: number
  xStart: number
  xEnd: number
  text: string
}

/** True when the transform has no rotation/skew (any uniform scale is fine). */
function isPlainTransform(transform: number[] | undefined): boolean {
  if (transform === undefined) return true
  const a = transform[0] ?? 1
  const b = transform[1] ?? 0
  const c = transform[2] ?? 0
  const d = transform[3] ?? 1
  const scale = Math.max(Math.abs(a), Math.abs(d), 1)
  return Math.abs(b) < 0.01 * scale && Math.abs(c) < 0.01 * scale
}

/** Place one content item; rotated/skewed fragments join with a newline. */
function placeItems(items: TextItemLike[]): PlacedItem[] {
  const placed: PlacedItem[] = []
  for (const item of items) {
    const str = item.str
    if (typeof str !== 'string' || str.length === 0) continue
    const transform = item.transform ?? [1, 0, 0, 1, 0, 0]
    if (!isPlainTransform(transform)) {
      placed.push({ str, x: Number.NaN, y: Number.NaN, xEnd: Number.NaN, height: item.height ?? 10 })
      continue
    }
    const x = transform[4] ?? 0
    const y = transform[5] ?? 0
    placed.push({ str, x, y, xEnd: x + (item.width ?? 0), height: item.height ?? 10 })
  }
  return placed
}

/** True when the code point is CJK (ideographs, kana, CJK punctuation, fullwidth forms). */
function isCJKLike(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0
  return (code >= 0x2e80 && code <= 0x303f)
    || (code >= 0x3040 && code <= 0x30ff)
    || (code >= 0x3400 && code <= 0x4dbf)
    || (code >= 0x4e00 && code <= 0x9fff)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xff00 && code <= 0xffef)
}

/**
 * Separator between two text runs joined on the same visual line: pdfjs
 * splits runs at font changes, so two adjacent CJK runs must join with no
 * space (Chinese never uses inter-word spaces), while Latin/digit boundaries
 * keep a hard space. Empty on either side (or existing whitespace) joins
 * with nothing.
 */
function joinSeparator(left: string, right: string): string {
  const l = left.length > 0 ? left[left.length - 1] : ''
  const r = right.length > 0 ? right[0] : ''
  if (l === '' || r === '' || /\s/.test(l) || /\s/.test(r)) return ''
  return isCJKLike(l) && isCJKLike(r) ? '' : ' '
}

/** Cluster placed items into visual lines, independent of stream order. */
function clusterLines(items: PlacedItem[], tolerance: number): PlacedLine[] {
  const sortable = items.filter((item) => Number.isFinite(item.x))
  // pdfjs y is bottom-up: larger y = higher on the page, so descending y
  // walks the page top-to-bottom in reading order.
  sortable.sort((a, b) => (a.y !== b.y ? b.y - a.y : a.x - b.x))
  const lines: PlacedLine[] = []
  for (const item of sortable) {
    const current = lines[lines.length - 1]
    if (current !== undefined && Math.abs(item.y - current.y) <= tolerance) {
      // Join on the same visual line: insert by x (the sort keeps order).
      if (item.x >= current.xEnd - 0.5) {
        current.text += joinSeparator(current.text, item.str) + item.str
      } else {
        current.text = item.str + joinSeparator(item.str, current.text) + current.text
      }
      current.xEnd = Math.max(current.xEnd, item.xEnd)
      continue
    }
    const line: PlacedLine = { y: item.y, xStart: item.x, xEnd: item.xEnd, text: item.str }
    lines.push(line)
  }
  return lines.filter((line) => line.text.trim().length > 0)
}

/** Detect two clean column bands; returns the per-line column index map, or null. */
function detectColumns(lines: PlacedLine[], minCoverage = 0.2): Map<PlacedLine, number> | null {
  if (lines.length < 6) return null
  const starts = lines.map((line) => line.xStart).sort((a, b) => a - b)
  const clusters: Array<{ center: number; members: PlacedLine[] }> = []
  for (const line of lines) {
    let cluster = clusters.find((candidate) => Math.abs(candidate.center - line.xStart) <= 12)
    if (cluster === undefined) {
      cluster = { center: line.xStart, members: [] }
      clusters.push(cluster)
    } else {
      cluster.center = (cluster.center * cluster.members.length + line.xStart) / (cluster.members.length + 1)
    }
    cluster.members.push(line)
  }
  const significant = clusters.filter((cluster) => cluster.members.length >= lines.length * minCoverage)
  if (significant.length < 2) return null
  significant.sort((a, b) => a.center - b.center)
  const assignment = new Map<PlacedLine, number>()
  for (let index = 0; index < significant.length; index += 1) {
    for (const line of significant[index].members) assignment.set(line, index)
  }
  // Every remaining line joins the nearest column band.
  for (const line of lines) {
    if (assignment.has(line)) continue
    let best = 0
    let bestDistance = Number.POSITIVE_INFINITY
    significant.forEach((cluster, index) => {
      const distance = Math.abs(cluster.center - line.xStart)
      if (distance < bestDistance) {
        bestDistance = distance
        best = index
      }
    })
    assignment.set(line, best)
  }
  return assignment
}

/**
 * Assemble one page's text in reading order: global (y, x) sort, line
 * clustering, then column-major output when two clean column bands exist.
 * The pdfjs content stream order is deliberately ignored — items drawn last
 * (e.g. the resume's "1. / 2. / 3." markers) would otherwise land at the end.
 */
export function assemblePageText(items: TextItemLike[], lineTolerance = 3): string {
  const placed = placeItems(items)
  const rotated = placed.filter((item) => !Number.isFinite(item.x))
  const lines = clusterLines(placed, lineTolerance)
  const columns = detectColumns(lines)
  const ordered: PlacedLine[] = []
  if (columns !== null) {
    const byColumn = new Map<number, PlacedLine[]>()
    for (const line of lines) {
      const column = columns.get(line) ?? 0
      const bucket = byColumn.get(column) ?? []
      bucket.push(line)
      byColumn.set(column, bucket)
    }
    const indices = [...byColumn.keys()].sort((a, b) => a - b)
    for (const index of indices) {
      ordered.push(...(byColumn.get(index) ?? []).sort((a, b) => b.y - a.y))
    }
  } else {
    ordered.push(...lines)
  }
  let out = ordered.map((line) => line.text).join('\n')
  if (rotated.length > 0) {
    out += (out.length > 0 ? '\n' : '') + rotated.map((item) => item.str).join('\n')
  }
  return out
}

/** Legacy joiner kept for tests; assemblePageText is the production path. */
export function joinTextItems(items: TextItemLike[]): string {
  return assemblePageText(items)
}

const DOC_OPTIONS = {
  isEvalSupported: false,
  useSystemFonts: false,
  disableFontFace: false,
  verbosity: 0,
} as const

interface OpenPdf {
  doc: PDFDocumentProxy
  close(): Promise<void>
}

async function openDocument(bytes: Buffer): Promise<OpenPdf> {
  const loadingTask = getDocument({
    data: new Uint8Array(bytes),
    ...DOC_OPTIONS,
    // Correct rendering/extraction for non-embedded fonts and CJK cmaps.
    standardFontDataUrl: join(pdfjsRoot, 'standard_fonts') + '/',
    cMapUrl: join(pdfjsRoot, 'cmaps') + '/',
    cMapPacked: true,
  })
  const doc = await loadingTask.promise
  return {
    doc,
    async close() {
      await loadingTask.destroy().catch(() => {})
    },
  }
}

export interface ExtractedPdfPage {
  n: number
  text: string
  chars: number
}

/** Extract the text layer of every page. */
export async function extractPdfPages(bytes: Buffer): Promise<ExtractedPdfPage[]> {
  const { doc, close } = await openDocument(bytes)
  try {
    const pages: ExtractedPdfPage[] = []
    for (let n = 1; n <= doc.numPages; n += 1) {
      const page: PDFPageProxy = await doc.getPage(n)
      try {
        const content = await page.getTextContent()
        const text = joinTextItems(content.items as TextItemLike[])
        pages.push({ n, text, chars: text.length })
      } finally {
        page.cleanup?.()
      }
    }
    return pages
  } finally {
    await close()
  }
}

/** Render one page to PNG bytes for OCR via the built-in NodeCanvasFactory. */
export async function renderPagePng(bytes: Buffer, pageNumber: number, scale: number): Promise<Buffer> {
  const { doc, close } = await openDocument(bytes)
  try {
    const page: PDFPageProxy = await doc.getPage(pageNumber)
    try {
      const viewport = page.getViewport({ scale })
      const canvas = createCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)))
      await page.render({ canvas, viewport }).promise
      return canvas.toBuffer('image/png')
    } finally {
      page.cleanup?.()
    }
  } finally {
    await close()
  }
}
