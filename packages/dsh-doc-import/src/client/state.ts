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

/** sessionStorage key holding the minimal draft records. */
const DRAFTS_STORAGE_KEY = 'dsh-doc-import.drafts.v1'

/** Upper bound on persisted records; oldest are dropped first. */
const MAX_PERSISTED_DRAFTS = 20

/** One JSON-safe draft record: no promises, no extracted text (the host owns it). */
export interface PersistedDraft {
  id: string
  name: string
  kind: string
  bytes: number
  chars: number
  pages: number
  status: DraftStatus
  ocrDone: number
  ocrTotal: number
  header: string
  truncated: boolean
  warning?: string
  cost?: { tokens: number; cny: number; ocrCny: number; label: string }
}

/** Storage face used for persistence (injectable for tests). */
export interface DraftStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function draftStorage(): DraftStorage | undefined {
  try {
    return typeof sessionStorage === 'undefined' ? undefined : sessionStorage
  } catch {
    // Storage can throw when disabled by policy; drafts then live in memory only.
    return undefined
  }
}

function makeReadyHandle(): { ready: Promise<void>; resolveReady: () => void } {
  let resolveReady: () => void = () => {}
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve
  })
  return { ready, resolveReady }
}

/**
 * Serialize the drafts worth restoring. In-flight uploads have no id yet, so
 * they cannot be resumed; everything with an id survives, including a running
 * OCR job (the host keeps working and the status route resumes the progress).
 */
export function toPersistedDrafts(drafts: readonly DraftDoc[]): string {
  const records: PersistedDraft[] = drafts
    .filter((doc) => doc.id.length > 0 && !doc.id.startsWith('pending-'))
    .slice(-MAX_PERSISTED_DRAFTS)
    .map((doc) => ({
      id: doc.id,
      name: doc.name,
      kind: doc.kind,
      bytes: doc.bytes,
      chars: doc.chars,
      pages: doc.pages,
      status: doc.status,
      ocrDone: doc.ocrDone,
      ocrTotal: doc.ocrTotal,
      header: doc.header,
      truncated: doc.truncated,
      ...(doc.warning === undefined ? {} : { warning: doc.warning }),
      ...(doc.cost === undefined ? {} : { cost: doc.cost }),
    }))
  return JSON.stringify(records)
}

/** Rebuild drafts from a persisted payload; malformed input restores nothing. */
export function fromPersistedDrafts(raw: string | null | undefined): DraftDoc[] {
  if (raw === null || raw === undefined || raw.length === 0) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const restored: DraftDoc[] = []
  for (const value of parsed) {
    if (typeof value !== 'object' || value === null) continue
    const record = value as Partial<PersistedDraft>
    if (typeof record.id !== 'string' || record.id.length === 0) continue
    if (typeof record.header !== 'string' || record.header.length === 0) continue
    const status: DraftStatus = record.status === 'parsing' || record.status === 'ocr' || record.status === 'error' || record.status === 'ready'
      ? record.status
      : 'ready'
    const handle = makeReadyHandle()
    restored.push({
      id: record.id,
      name: typeof record.name === 'string' ? record.name : record.id,
      kind: typeof record.kind === 'string' ? record.kind : '',
      bytes: typeof record.bytes === 'number' ? record.bytes : 0,
      chars: typeof record.chars === 'number' ? record.chars : 0,
      pages: typeof record.pages === 'number' ? record.pages : 0,
      status,
      ocrDone: typeof record.ocrDone === 'number' ? record.ocrDone : 0,
      ocrTotal: typeof record.ocrTotal === 'number' ? record.ocrTotal : 0,
      header: record.header,
      text: '',
      truncated: record.truncated === true,
      ...(record.warning === undefined ? {} : { warning: record.warning }),
      ...(record.cost === undefined ? {} : { cost: record.cost }),
      ready: handle.ready,
      resolveReady: handle.resolveReady,
    })
  }
  return restored
}

let lastPersisted = ''

/** Persist the current drafts; identical payloads are not rewritten. */
function persistDrafts(storage: DraftStorage | undefined = draftStorage()): void {
  if (storage === undefined) return
  const payload = toPersistedDrafts(docs)
  if (payload === lastPersisted) return
  try {
    storage.setItem(DRAFTS_STORAGE_KEY, payload)
    lastPersisted = payload
  } catch {
    // A full or disabled storage must never break the composer.
  }
}

/**
 * Restore drafts after a page refresh or a client-module reload, and resume
 * OCR polling for jobs that were still running. Without this, a reload wipes
 * the chip (and the model never receives the reference).
 */
export function rehydrateDrafts(storage: DraftStorage | undefined = draftStorage()): void {
  if (storage === undefined || docs.length > 0) return
  let raw: string | null = null
  try {
    raw = storage.getItem(DRAFTS_STORAGE_KEY)
  } catch {
    return
  }
  const restored = fromPersistedDrafts(raw)
  if (restored.length === 0) return
  docs = restored
  for (const doc of restored) {
    if (doc.status === 'parsing' || doc.status === 'ocr') {
      void pollUntilReady(doc)
    } else {
      doc.resolveReady()
    }
  }
  emit()
}

/** Test seam: drop the module-level store and its memoized payload. */
export function resetDraftsForTest(): void {
  docs = []
  lastPersisted = ''
}

function emit(): void {
  persistDrafts()
  // Status updates mutate the draft objects in place (doc.status = 'ready',
  // OCR counters, …), so the array identity would otherwise stay the same and
  // useSyncExternalStore's Object.is comparison would skip the re-render: the
  // chip stayed on "导入中" until an unrelated re-render (typing in the
  // composer) happened to flush the newest values. Rebind on every emit so
  // subscribers always observe a fresh snapshot.
  docs = docs.slice()
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
  const handle = makeReadyHandle()
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
    ready: handle.ready,
    resolveReady: handle.resolveReady,
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

// Restore drafts left by a previous page load (refresh, HMR client reload).
// A reload must never silently drop a document the user already attached:
// the reference is the only thing the model gets, and losing it looks like
// "the file was never sent" from the composer.
rehydrateDrafts()
