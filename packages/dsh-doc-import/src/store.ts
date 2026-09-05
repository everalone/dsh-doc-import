/**
 * Plugin-owned document storage under ~/.dsh/storages/doc-import/<sha256>/:
 * the original bytes, the assembled extraction text, per-page data for PDFs,
 * and the doc metadata. Content-addressed ids dedupe identical uploads, and
 * the registry is rebuilt on boot so read_document survives host restarts.
 * @module dsh-doc-import/store
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { DocKind } from './parsers.js'

export interface PdfPageRecord {
  n: number
  source: 'text' | 'ocr'
  text: string
  ocrText?: string
  /** Last OCR failure message; empty ocrText + set ocrError marks a retryable page. */
  ocrError?: string
}

export interface DocMeta {
  id: string
  name: string
  kind: DocKind
  mediaType: string
  bytes: number
  chars: number
  pages: number
  /** 1-based page numbers of scanned pages (OCR candidates). */
  ocrPages: number[]
  ocrDone: number
  ocrTotal: number
  ocrSkipped: number
  /** Terminal OCR job failure (e.g. self-heal budget exhausted); empty when the job can still converge. */
  ocrFatal?: string
  warning: string
  createdAt: number
  /** Extraction pipeline version that produced the stored text. */
  extractor: number
}

/** Append one message to the meta warning chain ('；'-joined). */
export function pushWarning(meta: DocMeta, message: string): void {
  meta.warning = [meta.warning, message].filter(Boolean).join('；')
}

/** Index pages by 1-based page number (shared by the OCR runner and re-import path). */
export function pagesByNumber(pages: PdfPageRecord[]): Map<number, PdfPageRecord> {
  return new Map(pages.map((page) => [page.n, page]))
}

/** The OCR page count to show/charge for: the settled total, or the candidate list while unsettled. */
export function ocrPageCount(meta: DocMeta): number {
  return meta.ocrTotal > 0 ? meta.ocrTotal : meta.ocrPages.length
}

export function docIdFor(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export interface DocStore {
  dir: string
  registry: Map<string, DocMeta>
  init(): Promise<void>
  save(meta: DocMeta, original: Buffer, text: string, pages?: PdfPageRecord[]): Promise<void>
  writeMeta(meta: DocMeta): Promise<void>
  writeText(id: string, text: string, meta: DocMeta): Promise<void>
  writePages(id: string, pages: PdfPageRecord[]): Promise<void>
  readText(id: string): Promise<string>
  readPages(id: string): Promise<PdfPageRecord[] | null>
  readOriginal(id: string): Promise<Buffer>
}

export function createDocStore(): DocStore {
  const dir = dshHomePath('storages', 'doc-import')
  const registry = new Map<string, DocMeta>()
  const docDir = (id: string): string => join(dir, id)

  async function init(): Promise<void> {
    await mkdir(dir, { recursive: true })
    let entries: string[] = []
    try {
      entries = await readdir(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      try {
        const meta: DocMeta = JSON.parse(await readFile(join(docDir(entry), 'meta.json'), 'utf8'))
        if (typeof meta.id === 'string') registry.set(meta.id, meta)
      } catch {
        // A half-written or foreign directory: leave it out of the registry.
      }
    }
  }

  return {
    dir,
    registry,
    init,
    async save(meta, original, text, pages) {
      const d = docDir(meta.id)
      await mkdir(d, { recursive: true })
      await writeFile(join(d, 'original.bin'), original)
      await writeFile(join(d, 'text.txt'), text, 'utf8')
      if (pages !== undefined) await writeFile(join(d, 'pages.json'), JSON.stringify(pages), 'utf8')
      await writeFile(join(d, 'meta.json'), JSON.stringify(meta), 'utf8')
      registry.set(meta.id, meta)
    },
    async writeMeta(meta) {
      // Registry first: when the disk write fails (the failure mode that used
      // to amplify into restart loops) the in-memory state still converges.
      registry.set(meta.id, meta)
      await writeFile(join(docDir(meta.id), 'meta.json'), JSON.stringify(meta), 'utf8')
    },
    async writeText(id, text, meta) {
      registry.set(id, meta)
      await writeFile(join(docDir(id), 'text.txt'), text, 'utf8')
      await writeFile(join(docDir(id), 'meta.json'), JSON.stringify(meta), 'utf8')
    },
    async writePages(id, pages) {
      await writeFile(join(docDir(id), 'pages.json'), JSON.stringify(pages), 'utf8')
    },
    async readText(id) {
      try {
        return await readFile(join(docDir(id), 'text.txt'), 'utf8')
      } catch {
        return ''
      }
    },
    async readPages(id) {
      try {
        return JSON.parse(await readFile(join(docDir(id), 'pages.json'), 'utf8')) as PdfPageRecord[]
      } catch {
        return null
      }
    },
    async readOriginal(id) {
      return readFile(join(docDir(id), 'original.bin'))
    },
  }
}
