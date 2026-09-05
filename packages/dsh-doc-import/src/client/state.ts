/**
 * Browser-side draft document registry: upload + parse via the host attach
 * route, live OCR progress via the status route, and the in-memory state the
 * chips dock and the send hook read. Module-level store with a subscribe
 * contract for useSyncExternalStore.
 * @module dsh-doc-import/client/state
 */

import type { CostView } from '../cost.js'
import { createPollDeadline, FALLBACK_POLL_BUDGET_MS, POLL_INTERVAL_MS } from './timing.js'

export type DraftStatus = 'uploading' | 'parsing' | 'ocr' | 'ready' | 'error'

export interface DraftDoc {
  id: string
  name: string
  // Deliberately `string`, not the host's DocKind union: the draft is created
  // from the file extension before the host responds, and unknown extensions
  // must not crash the client — the host remains the parser of record.
  kind: string
  bytes: number
  chars: number
  pages: number
  status: DraftStatus
  ocrDone: number
  ocrTotal: number
  header: string
  text: string
  truncated: boolean
  warning?: string
  error?: string
  cost?: { tokens: number; cny: number; ocrCny: number; label: string }
  /** Resolves once the doc is ready to send (or definitively failed). */
  ready: Promise<void>
  resolveReady: () => void
}

const DOC_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'csv', 'docx', 'pdf'])

/** Whether a browser File is a document this plugin claims (never images). */
export function isDocFile(file: File): boolean {
  if (file.type.startsWith('image/')) return false
  const dot = file.name.lastIndexOf('.')
  if (dot >= 0) return DOC_EXTENSIONS.has(file.name.slice(dot + 1).toLowerCase())
  return file.type === 'application/pdf'
    || file.type === 'text/plain'
    || file.type === 'text/csv'
    || file.type === 'text/markdown'
    || file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
}

let docs: DraftDoc[] = []
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of [...listeners]) listener()
}

export function subscribeDrafts(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getDrafts(): readonly DraftDoc[] {
  return docs
}

export function removeDraft(id: string): void {
  docs = docs.filter((d) => d.id !== id)
  emit()
}

export function clearReadyDrafts(): void {
  const before = docs.length
  docs = docs.filter((d) => d.status !== 'ready')
  if (docs.length !== before) emit()
}

/** Drop every draft (used when the conversation session changes). */
export function clearAllDrafts(): void {
  if (docs.length === 0) return
  docs = []
  emit()
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('读取文件失败'))
    reader.onload = () => {
      const result = reader.result
      if (typeof result !== 'string') {
        reject(new Error('读取文件失败'))
        return
      }
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.readAsDataURL(file)
  })
}

async function postJson<T>(url: string, payload?: unknown): Promise<T> {
  const response = await fetch(url, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: payload === undefined ? undefined : { 'content-type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  })
  const value = (await response.json().catch(() => ({}))) as T & { ok?: boolean; error?: { message?: string } }
  if (!response.ok || value.ok === false) {
    throw new Error(value.error?.message ?? `请求失败（${response.status}）`)
  }
  return value
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

interface AttachResponse {
  ok: true
  doc: {
    id: string
    name: string
    kind: string
    bytes: number
    chars: number
    pages: number
    ocrNeeded: boolean
    ocrCount: number
    header: string
    text: string
    truncated: boolean
    warning?: string
    cost: CostView
  }
}

interface StatusResponse {
  ok: true
  doc: {
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
    cost?: CostView
    ocrBudgetMs?: number
  }
}

function createDraft(name: string, kind: string, bytes: number): DraftDoc {
  let resolveReady: () => void = () => {}
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve
  })
  return {
    id: `pending-${Math.random().toString(36).slice(2)}`,
    name,
    kind,
    bytes,
    chars: 0,
    pages: 0,
    status: 'uploading',
    ocrDone: 0,
    ocrTotal: 0,
    header: '',
    text: '',
    truncated: false,
    ready,
    resolveReady,
  }
}

async function pollUntilReady(doc: DraftDoc): Promise<void> {
  // The host advertises a poll budget sized to the remaining pages; the
  // tracker refreshes it whenever the job makes progress, so healthy slow
  // runs are never killed while stalled ones eventually surface as errors.
  const deadline = createPollDeadline(FALLBACK_POLL_BUDGET_MS)
  try {
    for (;;) {
      await sleep(POLL_INTERVAL_MS)
      const response = await postJson<StatusResponse>(`/doc-import/status?id=${encodeURIComponent(doc.id)}`)
      const status = response.doc
      doc.ocrDone = status.ocrDone
      doc.ocrTotal = status.ocrTotal
      doc.warning = status.warning
      if (status.cost !== undefined) doc.cost = status.cost
      if (status.text !== undefined) {
        doc.text = status.text
        doc.truncated = status.truncated === true
        doc.chars = status.chars
      }
      emit()
      if (status.phase === 'ready') {
        doc.status = 'ready'
        doc.resolveReady()
        emit()
        return
      }
      if (status.phase === 'error') {
        doc.status = 'error'
        doc.error = status.warning ?? 'OCR 失败'
        doc.resolveReady()
        emit()
        return
      }
      // The host settles every job (self-healing status route), so this is a
      // last-resort guard: never leave a send waiting forever.
      if (Date.now() > deadline(status.ocrDone, status.ocrBudgetMs)) {
        doc.status = 'error'
        doc.error = 'OCR 处理超时，已停止等待（文档仍在后台，可稍后在预览中查看）'
        doc.resolveReady()
        emit()
        return
      }
    }
  } catch (error) {
    doc.status = 'error'
    doc.error = (error as Error).message
    doc.resolveReady()
    emit()
  }
}

/** Import one batch of document files; updates the shared draft registry. */
export async function importFiles(files: readonly File[]): Promise<void> {
  for (const file of files) {
    if (!isDocFile(file)) continue
    const kind = file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase()
    const doc = createDraft(file.name, kind, file.size)
    docs = [...docs, doc]
    emit()
    try {
      const data = await readAsBase64(file)
      doc.status = 'parsing'
      emit()
      const response = await postJson<AttachResponse>('/doc-import/attach', {
        data,
        mediaType: file.type,
        name: file.name,
      })
      const d = response.doc
      doc.id = d.id
      doc.kind = d.kind
      doc.bytes = d.bytes
      doc.chars = d.chars
      doc.pages = d.pages
      doc.header = d.header
      doc.text = d.text
      doc.truncated = d.truncated
      doc.warning = d.warning
      doc.cost = d.cost
      doc.ocrTotal = d.ocrCount
      if (d.ocrNeeded) {
        doc.status = 'ocr'
        emit()
        // A failed kick-off is not fatal: the status route self-heals by
        // restarting stalled jobs, so keep polling regardless.
        await postJson('/doc-import/ocr', { id: doc.id }).catch((error: unknown) => {
          console.warn('[doc-import] OCR kick-off failed; relying on status self-heal:', error)
        })
        void pollUntilReady(doc)
      } else {
        doc.status = 'ready'
        doc.resolveReady()
        emit()
      }
    } catch (error) {
      doc.status = 'error'
      doc.error = (error as Error).message
      doc.resolveReady()
      emit()
    }
  }
}
