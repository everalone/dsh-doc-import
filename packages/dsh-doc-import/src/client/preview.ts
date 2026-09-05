/**
 * Conversation file-chip enhancer. The web shell renders user messages as
 * plain text, so a sent `[document …]` reference sits in the transcript as
 * raw text. This module watches the chat transcript (the official
 * `conversation.session` slot wrapper, which excludes the composer) and
 * upgrades each reference in place into a file chip: an icon, the file name
 * and its meta line. Clicking opens a modal with the full extracted text and
 * an "open original file" action (the /doc-import/raw route). The message
 * text itself is never edited — the original reference is restored on
 * dispose — so the session log and the model side are untouched.
 *
 * Scanning mirrors the sibling describe-image preview enhancer: a document
 * observer (re)discovers the transcript container, while the content
 * observer on the container processes just the nodes each mutation record
 * carries. Processed references become elements, never text nodes, so a
 * re-scan finds nothing new.
 * @module dsh-doc-import/client/preview
 */

import type { CostView } from '../cost.js'
import { dictionaries, getDocImportLanguage, type DocImportClientKey } from './locales.js'
import { createPollDeadline, PREVIEW_POLL_BUDGET_MS, PREVIEW_POLL_INTERVAL_MS } from './timing.js'

/** Matches one `[document … id: <sha256>]` reference inside message text. */
const REFERENCE_PATTERN = /\[document ([^\]\n]+?), id: ([0-9a-f]{64})\]/g

/** The official slot wrapper owning the chat transcript; the composer lives outside it. */
const CONVERSATION_ROOT_SELECTOR = '[data-slot="conversation.session"]'

/** Attribute marking the modal overlay root. */
const MODAL_ATTR = 'data-dsh-docimport-modal'

export interface DocumentReferenceMatch {
  /** Everything between `[document ` and `, id:` — name plus meta fields. */
  head: string
  /** The extracted sha256 id. */
  id: string
  start: number
  end: number
}

/** Locate every document reference in one text chunk (pure string math). */
export function findDocumentReferences(text: string): DocumentReferenceMatch[] {
  const matches: DocumentReferenceMatch[] = []
  REFERENCE_PATTERN.lastIndex = 0
  for (let match = REFERENCE_PATTERN.exec(text); match !== null; match = REFERENCE_PATTERN.exec(text)) {
    matches.push({ head: match[1] ?? '', id: match[2] ?? '', start: match.index, end: match.index + match[0].length })
  }
  return matches
}

/** Split `名称, pdf, 83 页, 85980 字符` into the name and the meta tail. */
export function splitDocumentHead(head: string): { name: string; meta: string } {
  const comma = head.indexOf(', ')
  if (comma < 0) return { name: head, meta: '' }
  return { name: head.slice(0, comma), meta: head.slice(comma + 2) }
}

function kindOf(meta: string): string {
  return meta.split(',')[0]?.trim() ?? ''
}

function iconFor(kind: string): string {
  switch (kind) {
    case 'pdf': return '📕'
    case 'docx': return '📘'
    case 'csv': return '📊'
    case 'markdown':
    case 'md': return '📝'
    default: return '📄'
  }
}

/** Resolve a locale key from the shared namespace dictionaries (zh/en). */
function t(key: DocImportClientKey, vars?: Record<string, string | number>): string {
  const lang = getDocImportLanguage()
  const table = dictionaries[lang] as Record<string, string>
  let text = table[key] ?? key
  if (vars !== undefined) {
    for (const [name, value] of Object.entries(vars)) text = text.replaceAll(`{${name}}`, String(value))
  }
  return text
}

// ---------------------------------------------------------------------------
// File chip
// ---------------------------------------------------------------------------

const CHIP_ATTR = 'data-dsh-docimport-chip'

function buildChip(match: DocumentReferenceMatch): HTMLElement {
  const { name, meta } = splitDocumentHead(match.head)
  const button = document.createElement('button')
  button.type = 'button'
  button.setAttribute(CHIP_ATTR, '')
  button.setAttribute('data-dsh-docimport-id', match.id)
  button.title = `${t('file.open')}: ${name}`
  button.style.cssText = [
    'display:inline-flex', 'align-items:center', 'gap:8px',
    'border:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3))',
    'background:var(--dsw-alias-bg-layer-1, rgba(128,128,128,.06))',
    'border-radius:8px', 'padding:6px 10px', 'margin:2px 4px 2px 0',
    'font-size:13px', 'line-height:1.4', 'color:inherit', 'cursor:pointer',
    'max-width:420px', 'text-align:left', 'vertical-align:middle',
  ].join(';')
  const icon = document.createElement('span')
  icon.textContent = iconFor(kindOf(meta))
  icon.style.cssText = 'font-size:16px;flex-shrink:0;'
  const text = document.createElement('span')
  text.style.cssText = 'display:flex;flex-direction:column;min-width:0;'
  const nameEl = document.createElement('span')
  nameEl.textContent = name
  nameEl.style.cssText = 'font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;'
  const metaEl = document.createElement('span')
  metaEl.textContent = meta.length > 0 ? meta : t('file.open')
  metaEl.style.cssText = 'font-size:11px;color:var(--dsw-alias-label-secondary, #999);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;'
  text.append(nameEl, metaEl)
  button.append(icon, text)
  return button
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

interface ModalState {
  docId: string
  title: string
  overlay: HTMLElement | null
}

function openModal(docId: string, title: string): void {
  closeModal()
  const overlay = document.createElement('div')
  overlay.setAttribute(MODAL_ATTR, '')
  overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:rgba(8,8,14,.55);display:flex;align-items:center;justify-content:center;padding:24px;'
  const panel = document.createElement('div')
  panel.style.cssText = 'background:var(--dsw-alias-bg-layer-1, #17171d);border:1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.12));border-radius:12px;width:min(820px,100%);max-height:82vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,.45);color:var(--dsw-alias-label-primary, #eee);'
  const header = document.createElement('div')
  header.style.cssText = 'display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.08));'
  const titleEl = document.createElement('span')
  titleEl.textContent = title
  titleEl.style.cssText = 'font-weight:600;font-size:14px;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;'
  const metaEl = document.createElement('span')
  metaEl.style.cssText = 'font-size:12px;color:var(--dsw-alias-label-secondary, #999);flex-shrink:0;'
  const openOriginal = document.createElement('button')
  openOriginal.type = 'button'
  openOriginal.textContent = t('file.openOriginal')
  openOriginal.style.cssText = 'border:1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.18));background:var(--dsw-alias-bg-layer-2, rgba(255,255,255,.06));color:inherit;border-radius:6px;padding:5px 10px;font-size:12px;cursor:pointer;'
  openOriginal.addEventListener('click', () => {
    window.open(`/doc-import/raw/${encodeURIComponent(docId)}`, '_blank', 'noopener')
  })
  const closeButton = document.createElement('button')
  closeButton.type = 'button'
  closeButton.textContent = t('file.close')
  closeButton.style.cssText = 'border:1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.18));background:var(--dsw-alias-bg-layer-2, rgba(255,255,255,.06));color:inherit;border-radius:6px;padding:5px 10px;font-size:12px;cursor:pointer;'
  closeButton.addEventListener('click', closeModal)
  header.append(titleEl, metaEl, openOriginal, closeButton)

  const body = document.createElement('div')
  body.style.cssText = 'overflow:auto;padding:14px 16px;'
  const loading = document.createElement('div')
  loading.textContent = t('file.loading')
  loading.style.cssText = 'color:var(--dsw-alias-label-secondary, #999);font-size:13px;'
  body.append(loading)
  panel.append(header, body)
  overlay.append(panel)
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) closeModal()
  })
  document.body.appendChild(overlay)
  ;(overlay as unknown as { __docId: string }).__docId = docId

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') closeModal()
  }
  document.addEventListener('keydown', onKey)
  ;(overlay as unknown as { __onKey: (event: KeyboardEvent) => void }).__onKey = onKey

  interface StatusDoc {
    kind: string
    chars: number
    phase?: 'parsing' | 'ocr' | 'ready' | 'error'
    ocrDone?: number
    text?: string
    cost?: CostView
    warning?: string
    ocrBudgetMs?: number
  }

  const load = async (): Promise<StatusDoc> => {
    const response = await fetch(`/doc-import/status?id=${encodeURIComponent(docId)}`)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const payload = await response.json() as { ok: boolean; doc?: StatusDoc }
    if (!payload.ok || payload.doc === undefined) throw new Error('status failed')
    return payload.doc
  }

  const render = (doc: StatusDoc): void => {
    metaEl.textContent = `${doc.kind} · ${t('file.chars', { chars: doc.chars })}${doc.cost !== undefined ? ` · ${doc.cost.label}` : ''}`
    const warningText = doc.warning
    body.textContent = ''
    if (warningText !== undefined && warningText.length > 0) {
      const warning = document.createElement('div')
      warning.textContent = warningText
      warning.style.cssText = 'color:var(--dsw-alias-label-warning, #f5a524);font-size:12px;margin:0 0 8px;'
      body.append(warning)
    }
    if (doc.text !== undefined) {
      const pre = document.createElement('pre')
      pre.textContent = doc.text
      pre.style.cssText = 'margin:0;white-space:pre-wrap;word-break:break-word;font:12.5px/1.6 ui-monospace, SFMono-Regular, Consolas, monospace;color:inherit;'
      body.append(pre)
    } else {
      const empty = document.createElement('div')
      empty.textContent = t('file.loading')
      empty.style.cssText = 'color:var(--dsw-alias-label-secondary, #999);font-size:13px;'
      body.append(empty)
    }
  }

  /** Poll while OCR is pending so a mid-job open converges instead of sticking on "加载中…". */
  const pollUntilText = async (): Promise<void> => {
    // Budgeted via the shared tracker: refreshes on progress, so a healthy
    // slow job keeps polling while a stalled one eventually shows a failure.
    const deadline = createPollDeadline(PREVIEW_POLL_BUDGET_MS)
    for (;;) {
      let doc: StatusDoc
      try {
        doc = await load()
      } catch (error: unknown) {
        body.textContent = ''
        const failed = document.createElement('div')
        failed.textContent = t('file.failed', { error: (error as Error)?.message ?? String(error) })
        failed.style.cssText = 'color:var(--dsw-alias-label-danger, #e5484d);font-size:13px;'
        body.append(failed)
        return
      }
      // Modal closed while polling: stop.
      if (document.querySelector(`[${MODAL_ATTR}]`) === null) return
      render(doc)
      if (doc.text !== undefined) return
      if (doc.phase === 'error' || Date.now() > deadline(doc.ocrDone ?? 0, doc.ocrBudgetMs)) {
        const failed = document.createElement('div')
        failed.textContent = t('file.failed', { error: doc.warning ?? 'OCR 未能完成' })
        failed.style.cssText = 'color:var(--dsh-alias-label-danger, #e5484d);font-size:13px;'
        body.append(failed)
        return
      }
      await new Promise((resolve) => setTimeout(resolve, PREVIEW_POLL_INTERVAL_MS))
    }
  }

  void pollUntilText()
}

function closeModal(): void {
  const overlay = document.querySelector(`[${MODAL_ATTR}]`) as HTMLElement | null
  if (overlay === null) return
  const extra = overlay as unknown as { __onKey?: (event: KeyboardEvent) => void }
  if (extra.__onKey !== undefined) document.removeEventListener('keydown', extra.__onKey)
  overlay.remove()
}

// ---------------------------------------------------------------------------
// Transcript enhancer
// ---------------------------------------------------------------------------

interface ReplacedNode {
  chip: HTMLElement
  original: string
}

export interface ConversationDocPreview {
  dispose(): void
}

/** Whether a text node sits inside an editable surface, raw-text island, or our own UI. */
function isExcluded(node: Text): boolean {
  const parent = node.parentElement
  if (parent === null) return true
  return parent.closest(`input, textarea, script, style, [contenteditable], [${CHIP_ATTR}], [${MODAL_ATTR}]`) !== null
}

/**
 * Install the enhancer. The transcript container is resolved through the
 * official slot attribute and re-resolved on every document mutation burst
 * (microtask-collapsed, one querySelector per burst — the same discovery
 * pattern as the sibling describe-image preview enhancer), so a session
 * switch that rebuilds the conversation panel re-enhances the references.
 * Content passes are record-driven and idempotent; processed references
 * become elements, never text nodes, so a re-scan finds nothing new.
 * @param root - fixed subtree to watch (defaults to the transcript container).
 * @returns the handle; dispose restores the original reference text.
 */
export function installConversationDocPreview(root?: ParentNode): ConversationDocPreview {
  const replaced = new Set<ReplacedNode>()
  let contentObserver: MutationObserver | null = null
  let mountObserver: MutationObserver | null = null
  let observedRoot: ParentNode | undefined = root
  let disposed = false
  let scheduled = false

  const processTextNode = (node: Text): void => {
    if (isExcluded(node)) return
    const source = node.textContent
    if (source === null || source.length === 0) return
    const matches = findDocumentReferences(source)
    if (matches.length === 0) return
    const parent = node.parentNode
    if (parent === null) return
    const fragment = document.createDocumentFragment()
    let cursor = 0
    for (const match of matches) {
      if (match.start > cursor) fragment.append(document.createTextNode(source.slice(cursor, match.start)))
      const chip = buildChip(match)
      chip.addEventListener('click', () => {
        const { name } = splitDocumentHead(match.head)
        openModal(match.id, name)
      })
      replaced.add({ chip, original: source.slice(match.start, match.end) })
      fragment.append(chip)
      cursor = match.end
    }
    if (cursor < source.length) fragment.append(document.createTextNode(source.slice(cursor)))
    parent.replaceChild(fragment, node)
  }

  /** Upgrade the references inside one added or changed node (text node or subtree). */
  const scanNode = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      processTextNode(node as Text)
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
      acceptNode: (candidate) => {
        const text = candidate as Text
        if (text.textContent === null || !text.textContent.includes('id: ')) return NodeFilter.FILTER_REJECT
        return isExcluded(text) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
      },
    })
    // Collect before mutating: replacing a node mid-walk invalidates the iterator.
    const targets: Text[] = []
    for (let current = walker.nextNode(); current !== null; current = walker.nextNode()) targets.push(current as Text)
    for (const target of targets) processTextNode(target)
  }

  /** One full upgrade pass over the scope. */
  const enhanceAll = (): void => {
    if (observedRoot !== undefined) scanNode(observedRoot)
  }

  /** Content observer: process only the nodes each mutation record carries. */
  const onContentRecords = (records: MutationRecord[]): void => {
    if (disposed) return
    for (const record of records) {
      if (record.type === 'characterData') {
        scanNode(record.target)
      } else {
        for (const node of record.addedNodes) scanNode(node)
      }
    }
  }

  /** (Re)attach the content observer to the live transcript container. */
  const attach = (): void => {
    const next = root ?? document.querySelector<HTMLElement>(CONVERSATION_ROOT_SELECTOR) ?? undefined
    if (next === observedRoot) return
    contentObserver?.disconnect()
    observedRoot = next
    if (observedRoot !== undefined) {
      contentObserver = new MutationObserver(onContentRecords)
      contentObserver.observe(observedRoot, { childList: true, subtree: true, characterData: true })
      enhanceAll()
    }
  }

  /** Collapse a mutation burst into one container re-resolution per microtask. */
  const schedule = (): void => {
    if (scheduled || disposed) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      if (!disposed) attach()
    })
  }

  if (root === undefined) {
    // Watch the whole document to (re)discover the transcript container; the
    // per-burst work is one identity check plus at most one querySelector.
    mountObserver = new MutationObserver(schedule)
    mountObserver.observe(document.body, { childList: true, subtree: true })
  }
  attach()

  return {
    dispose() {
      disposed = true
      mountObserver?.disconnect()
      contentObserver?.disconnect()
      closeModal()
      for (const { chip, original } of replaced) {
        if (chip.parentNode !== null) chip.parentNode.replaceChild(document.createTextNode(original), chip)
      }
      replaced.clear()
    },
  }
}
