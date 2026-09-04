/**
 * Minimal structural shims for pdfjs-dist's main build (v6: ships a built-in
 * NodeCanvasFactory backed by @napi-rs/canvas). The build ships TypeScript
 * declarations under types/src, but only the surface this plugin uses is
 * spelled here to keep the package lean.
 */
declare module 'pdfjs-dist/legacy/build/pdf.mjs' {
  export interface PDFPageProxy {
    getTextContent(): Promise<{ items: Array<{ str?: string; transform?: number[]; width?: number; height?: number; hasEOL?: boolean }> }>
    getViewport(options: { scale: number }): { width: number; height: number }
    render(options: { canvas: unknown; viewport: { width: number; height: number } }): { promise: Promise<void> }
    cleanup?(): void
  }
  export interface PDFDocumentProxy {
    numPages: number
    getPage(pageNumber: number): Promise<PDFPageProxy>
    destroy(): Promise<void>
  }
  export function getDocument(options: {
    data: Uint8Array
    isEvalSupported?: boolean
    useSystemFonts?: boolean
    disableFontFace?: boolean
    verbosity?: number
    standardFontDataUrl?: string
    cMapUrl?: string
    cMapPacked?: boolean
  }): {
    promise: PDFDocumentProxy
    destroy(): Promise<void>
  }
}
