/**
 * Client surface: the composer import button (conversation.input.left), the
 * document chip dock above the composer (conversation.input.dock), and the
 * document-level drop/paste listeners. Components stay pure props + the
 * module draft registry; the t prop comes from the slot locale namespace.
 * @module dsh-doc-import/client/ui
 */

import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { CSSProperties, DragEvent, ReactElement } from 'react'
import { clearAllDrafts, getDrafts, importFiles, isDocFile, removeDraft, subscribeDrafts, type DraftDoc } from './state.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface SlotProps {
  t: (key: string, vars?: Record<string, string | number>) => string
  session?: unknown
  input?: unknown
  [key: string]: unknown
}

function pickDocsFromEvent(dataTransfer: DataTransfer | null | undefined): File[] {
  if (dataTransfer === null || dataTransfer === undefined) return []
  return Array.from(dataTransfer.files ?? []).filter(isDocFile)
}

function statusLine(doc: DraftDoc, t: SlotProps['t']): string {
  switch (doc.status) {
    case 'uploading':
      return t('chip.uploading')
    case 'parsing':
      return t('chip.parsing')
    case 'ocr':
      return t('chip.ocr', { done: doc.ocrDone, total: doc.ocrTotal || 0 })
    case 'error':
      return t('chip.error', { error: doc.error ?? '?' })
    case 'ready':
      return doc.truncated
        ? t('chip.truncated', { chars: doc.text.length, total: doc.chars })
        : t('chip.ready', { chars: doc.chars })
  }
}

function statusColor(status: DraftDoc['status']): string {
  switch (status) {
    case 'error':
      return '#e5484d'
    case 'ready':
      return '#30a46c'
    case 'ocr':
      return '#f5a524'
    default:
      return '#8e8ea0'
  }
}

const chipStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 10px',
  borderRadius: 8,
  border: '1px solid var(--border, rgba(128,128,128,.25))',
  background: 'var(--card, rgba(128,128,128,.08))',
  fontSize: 12,
  lineHeight: 1.4,
  maxWidth: 420,
  minWidth: 0,
}

const dockStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 8,
  padding: '4px 0 6px',
  width: '100%',
}

function DocChip({ doc, t }: { doc: DraftDoc; t: SlotProps['t'] }): ReactElement {
  const nameStyle: CSSProperties = { fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 160 }
  const metaStyle: CSSProperties = { color: statusColor(doc.status), whiteSpace: 'nowrap' }
  const removeStyle: CSSProperties = {
    cursor: 'pointer',
    border: 'none',
    background: 'transparent',
    color: 'inherit',
    fontSize: 14,
    padding: '0 2px',
    opacity: 0.7,
  }
  return (
    <div style={chipStyle} title={doc.warning ?? doc.name}>
      <span style={{ fontSize: 14 }}>📄</span>
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <span style={nameStyle}>{doc.name}</span>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={metaStyle}>{statusLine(doc, t)}</span>
        </div>
      </div>
      <button
        type="button"
        style={removeStyle}
        aria-label={t('chip.remove')}
        title={t('chip.remove')}
        onClick={() => removeDraft(doc.id)}
      >
        ×
      </button>
    </div>
  )
}

/** The dock rendered through the conversation.input.dock slot. */
export function DocDock(props: SlotProps): ReactElement | null {
  const docs = useSyncExternalStore(subscribeDrafts, getDrafts, getDrafts)
  // Drafts are session-scoped: switching the conversation drops them, so a
  // document never leaks into an unrelated session's next send.
  const sessionId = (props.session as { sessionId?: unknown } | undefined)?.sessionId
  const lastSessionRef = useRef<unknown>(sessionId)
  useEffect(() => {
    if (sessionId !== lastSessionRef.current) {
      lastSessionRef.current = sessionId
      clearAllDrafts()
    }
  }, [sessionId])
  if (docs.length === 0) return null
  return (
    <div style={dockStyle}>
      {docs.map((doc) => (
        <DocChip key={doc.id} doc={doc} t={props.t} />
      ))}
    </div>
  )
}

/** The import button rendered through the conversation.input.left slot. */
export function ImportButton({ t }: SlotProps): ReactElement {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const openPicker = (): void => {
    if (inputRef.current === null) {
      const input = document.createElement('input')
      input.type = 'file'
      input.multiple = true
      input.accept = '.txt,.md,.markdown,.csv,.docx,.pdf,text/plain,text/markdown,text/csv,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      input.style.display = 'none'
      input.addEventListener('change', () => {
        if (input.files !== null && input.files.length > 0) void importFiles(Array.from(input.files))
        input.remove()
      })
      document.body.appendChild(input)
      inputRef.current = input
    }
    inputRef.current.click()
  }
  const style: CSSProperties = {
    cursor: 'pointer',
    border: '1px solid var(--border, rgba(128,128,128,.25))',
    background: 'var(--card, rgba(128,128,128,.08))',
    borderRadius: 8,
    padding: '4px 8px',
    fontSize: 12,
    color: 'inherit',
    whiteSpace: 'nowrap',
  }
  return (
    <button type="button" style={style} title={t('button.aria')} aria-label={t('button.aria')} onClick={openPicker}>
      📄 {t('button.title')}
    </button>
  )
}

/** Document-level drop and paste listeners; never claims image files. */
export function installDropPaste(): () => void {
  const onDragOver = (event: DragEvent): void => {
    if (pickDocsFromEvent(event.dataTransfer).length > 0) {
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    }
  }
  const onDrop = (event: DragEvent): void => {
    const files = pickDocsFromEvent(event.dataTransfer)
    if (files.length > 0) {
      event.preventDefault()
      void importFiles(files)
    }
  }
  const onPaste = (event: ClipboardEvent): void => {
    const files = Array.from(event.clipboardData?.files ?? []).filter(isDocFile)
    if (files.length > 0) {
      event.preventDefault()
      void importFiles(files)
    }
  }
  document.addEventListener('dragover', onDragOver as unknown as EventListener)
  document.addEventListener('drop', onDrop as unknown as EventListener)
  document.addEventListener('paste', onPaste)
  return () => {
    document.removeEventListener('dragover', onDragOver as unknown as EventListener)
    document.removeEventListener('drop', onDrop as unknown as EventListener)
    document.removeEventListener('paste', onPaste)
  }
}

export type { DraftDoc }
