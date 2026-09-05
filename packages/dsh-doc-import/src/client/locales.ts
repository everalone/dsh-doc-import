/**
 * Client namespace dictionaries (composer import button, doc chips, cost
 * notice). The zh set is the key-set source of truth.
 * @module dsh-doc-import/client/locales
 */

export const zh = {
  'button.title': '导入文档',
  'button.aria': '导入 txt / md / csv / docx / pdf 文档，自动解析并生成文件引用',
  'chip.uploading': '导入中…',
  'chip.parsing': '解析中…',
  'chip.ocr': 'OCR 回退中 {done}/{total} 页',
  'chip.ready': '已就绪 · {chars} 字符',
  'chip.truncated': '已就绪 · 内联 {chars} 字符（全文 {total} 字符，可回读）',
  'chip.error': '失败：{error}',
  'chip.remove': '移除文档',
  'drop.title': '导入文档',
  'drop.hint': '松开即可导入 txt / md / csv / docx / pdf（扫描版 PDF 自动 OCR）',
  'card.title': '文档导入',
  'card.description': '拖入 txt / md / csv / docx / pdf 后的解析、存储与 OCR 回退行为；修改即时生效。',
  'card.loading': '加载设置中…',
  'card.unavailable': '当前部署未暴露 doc-import 设置节，无法在此编辑。',
  'card.resetAll': '全部重置为默认',
  'card.saveHint': '字段失焦即保存；↺ 将单项恢复为默认值。',
  'card.expand': '展开设置',
  'card.collapse': '收起设置',
  'file.open': '打开文档',
  'file.openOriginal': '打开原始文件',
  'file.close': '关闭',
  'file.loading': '加载中…',
  'file.failed': '加载失败：{error}',
  'file.chars': '{chars} 字符',
} as const

export type DocImportClientKey = keyof typeof zh

export const en: Record<DocImportClientKey, string> = {
  'button.title': 'Import document',
  'button.aria': 'Import txt / md / csv / docx / pdf documents; parsed into compact file references automatically',
  'chip.uploading': 'Importing…',
  'chip.parsing': 'Parsing…',
  'chip.ocr': 'OCR fallback {done}/{total} pages',
  'chip.ready': 'Ready · {chars} chars',
  'chip.truncated': 'Ready · {chars} chars inlined (full {total}, readable)',
  'chip.error': 'Failed: {error}',
  'chip.remove': 'Remove document',
  'drop.title': 'Import documents',
  'drop.hint': 'Drop txt / md / csv / docx / pdf files (scanned PDFs OCR automatically)',
  'card.title': 'Document import',
  'card.description': 'Parsing, storage and OCR fallback behavior for dragged txt / md / csv / docx / pdf documents; edits apply immediately.',
  'card.loading': 'Loading settings…',
  'card.unavailable': 'The doc-import settings section is not exposed by this deployment.',
  'card.resetAll': 'Reset all to defaults',
  'card.saveHint': 'Fields save on blur; ↺ restores one field to its default.',
  'card.expand': 'Expand settings',
  'card.collapse': 'Collapse settings',
  'file.open': 'Open document',
  'file.openOriginal': 'Open original file',
  'file.close': 'Close',
  'file.loading': 'Loading…',
  'file.failed': 'Failed: {error}',
  'file.chars': '{chars} chars',
}

export const dictionaries = { zh, en }

let active: 'zh' | 'en' = 'zh'

export function setDocImportLanguage(lang: 'zh' | 'en'): void {
  active = lang
}

export function getDocImportLanguage(): 'zh' | 'en' {
  return active
}

export const NS = 'doc-import' as const
