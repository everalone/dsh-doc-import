/**
 * Shared client-side timing constants. The OCR poll deadline is NOT defined
 * here — it comes from the status response's `ocrBudgetMs` (host-side shared
 * math in ocr.ts), so a 100-page job gets the ~2 h budget it can legitimately
 * need instead of a fixed deadline that fails healthy slow jobs. These
 * constants are the fallbacks and the user-facing wait bounds.
 * @module dsh-doc-import/client/timing
 */

/** Status poll interval. */
export const POLL_INTERVAL_MS = 700

/** Fallback poll budget when the host did not advertise `ocrBudgetMs`. */
export const FALLBACK_POLL_BUDGET_MS = 15 * 60_000

/** Preview modal polling: fallback budget and interval. */
export const PREVIEW_POLL_BUDGET_MS = 30 * 60_000
export const PREVIEW_POLL_INTERVAL_MS = 2_000

/** Upper bound for the send hook waiting on pending OCR before sending anyway. */
export const SEND_WAIT_MS = 120_000

/**
 * Deadline tracker for status polling, shared by the send flow and the
 * preview modal. The advertised budget (host-side shared math in ocr.ts,
 * sized to the remaining pages) bounds the time WITHOUT progress: every
 * poll that reports more finished pages refreshes the deadline, so a healthy
 * slow job is never killed while a stalled one eventually is.
 */
export function createPollDeadline(fallbackMs: number): (ocrDone: number, ocrBudgetMs?: number) => number {
  let deadline: number | null = null
  let lastDone = -1
  return (ocrDone, ocrBudgetMs) => {
    if (deadline === null || ocrDone > lastDone) {
      deadline = Date.now() + (ocrBudgetMs ?? fallbackMs)
      lastDone = ocrDone
    }
    return deadline
  }
}
