/**
 * Send interception: a send that carries draft documents is rewritten into a
 * plain-text prompt carrying each document's compact `[document …]` reference
 * (name, kind, pages/chars, id). The extracted text itself never enters the
 * message — the model reads it through the read_document tool, and the chat
 * transcript renders the reference as a file chip (see preview.ts). Pending
 * OCR jobs are awaited first so a reference is never published before its
 * content is ready; documents that failed to parse are skipped and stay
 * visible in the dock for removal. Image ids pass through untouched (the
 * shell's own image pipeline, and other send hooks, keep working).
 *
 * Structural like the sibling describe-image hook: wraps the conversation
 * service's sendSession in place, guarded by a module marker.
 * @module dsh-doc-import/client/send-hook
 */

import { clearReadyDrafts, getDrafts } from './state.js'

const HOOK_MARKER = '__dshDocImportSendHooked'

interface ConversationSendFace {
  sendSession(session: unknown, text: string, imageIds: readonly string[], mode: string, signal?: AbortSignal): Promise<unknown>
}

export function installSendHook(
  conversation: unknown,
  _readThreshold?: () => number | undefined,
): void {
  const face = conversation as ConversationSendFace & Record<string, unknown>
  if (face === null || typeof face !== 'object') return
  if (typeof face.sendSession !== 'function') return
  if (face[HOOK_MARKER] === true) return
  face[HOOK_MARKER] = true

  const original = face.sendSession
  face.sendSession = async function sendSession(session, text, imageIds, mode, signal) {
    const candidates = getDrafts().filter((doc) => doc.status !== 'error')
    if (candidates.length === 0) {
      return original.call(face, session, text, imageIds, mode, signal)
    }
    try {
      await Promise.all(candidates.map((doc) => doc.ready))
    } catch {
      // Individual docs already settled into the error state.
    }
    const ready = candidates.filter((doc) => doc.status === 'ready' && doc.header.length > 0)
    if (ready.length === 0) {
      return original.call(face, session, text, imageIds, mode, signal)
    }

    // Pure file references: one compact line per document, no inlined text.
    const references = ready.map((doc) => doc.header).join('\n')
    const merged = references + (text.trim().length > 0 ? `\n\n${text}` : '')
    const outcome = await original.call(face, session, merged, imageIds, mode, signal)
    clearReadyDrafts()
    return outcome
  }
}
