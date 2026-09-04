/**
 * The doc-import settings card rendered by the web GUI's built-in plugin
 * config page (Settings → 插件配置) through the `web-ui.plugin.item` slot.
 * Mirrors the family-shared PluginSettingsCard chrome the sibling plugin
 * cards use: a disclosure header (name + description + chevron) that
 * collapses the field body, the same `--dsw-alias-*` tokens, and no trace
 * when the namespace is unavailable. Field values commit on blur; the
 * per-field reset clears the user override back to the composition default.
 * @module dsh-doc-import/client/settings-card
 */

import { useEffect, useSyncExternalStore, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import type { SlotProps } from './ui.js'

export interface DocImportSettingsScope {
  getSnapshot(): {
    status: 'loading' | 'ready' | 'unavailable'
    value?: Record<string, unknown>
  }
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<void>
  unset(field: string): Promise<void>
}

interface FieldDef {
  key: string
  label: string
  hint?: string
  kind: 'number' | 'text' | 'boolean'
  group: 'doc' | 'ocr' | 'price'
  step?: string
  min?: number
  /** Display transform (number fields only). */
  toDisplay?: (value: number) => number
  fromDisplay?: (display: number) => number
}

const MiB = 1024 * 1024

const FIELDS: readonly FieldDef[] = [
  // ---- 文档导入 ----
  { key: 'inlineCap', label: '内联字符上限', kind: 'number', group: 'doc', step: '1000', min: 1000, hint: '保留字段：纯文件引用模式下不再内联正文' },
  { key: 'costNoticeThreshold', label: '费用提示阈值（字符）', kind: 'number', group: 'doc', step: '1000', min: 100, hint: '保留字段：正文改为文件引用后无内联费用提示' },
  { key: 'maxUploadBytes', label: '上传上限（MiB）', kind: 'number', group: 'doc', step: '1', min: 1, hint: '单个文档字节上限', toDisplay: (v) => v / MiB, fromDisplay: (v) => Math.round(v * MiB) },
  { key: 'maxPdfPages', label: 'PDF 页数上限', kind: 'number', group: 'doc', step: '100', min: 1 },
  { key: 'maxInlineTableRows', label: 'CSV 解析行数', kind: 'number', group: 'doc', step: '100', min: 1, hint: '超出部分存全文，可经 read_document 回读' },
  // ---- OCR ----
  { key: 'ocrEnabled', label: '自动 OCR 扫描页', kind: 'boolean', group: 'ocr', hint: '无文本层/空白页自动转图识别' },
  { key: 'ocrPageCap', label: '单文档 OCR 页数上限', kind: 'number', group: 'ocr', step: '10', min: 0, hint: '0 = 不限；超出的页跳过并警告' },
  { key: 'ocrConcurrency', label: 'OCR 并发', kind: 'number', group: 'ocr', step: '1', min: 1 },
  { key: 'ocrBlankThreshold', label: '扫描页判定阈值（字符）', kind: 'number', group: 'ocr', step: '5', min: 1, hint: '单页文本少于该字符数视为扫描页' },
  { key: 'ocrModel', label: 'OCR 模型', kind: 'text', group: 'ocr' },
  { key: 'ocrBaseURL', label: 'OCR 端点', kind: 'text', group: 'ocr', hint: 'OpenAI 兼容根地址，自动追加 /chat/completions' },
  { key: 'ocrApiKeyEnv', label: 'OCR 密钥环境变量', kind: 'text', group: 'ocr', hint: '经凭证服务解析（默认 DEEPSEEK_API_KEY）' },
  { key: 'ocrTimeoutMs', label: '单页超时（毫秒）', kind: 'number', group: 'ocr', step: '5000', min: 1000 },
  { key: 'ocrMaxOutputTokens', label: '单页输出 token 上限', kind: 'number', group: 'ocr', step: '256', min: 1 },
  { key: 'ocrImageScale', label: '渲染倍率', kind: 'number', group: 'ocr', step: '0.1', min: 0.5, hint: '页图渲染分辨率（1.5 ≈ 108 DPI）' },
  // ---- 价格表 ----
  { key: 'pricePeakInputPerMTok', label: '输入价·高峰', kind: 'number', group: 'price', step: '0.1', min: 0 },
  { key: 'priceOffPeakInputPerMTok', label: '输入价·空闲', kind: 'number', group: 'price', step: '0.1', min: 0 },
  { key: 'pricePeakOutputPerMTok', label: '输出价·高峰', kind: 'number', group: 'price', step: '0.1', min: 0 },
  { key: 'priceOffPeakOutputPerMTok', label: '输出价·空闲', kind: 'number', group: 'price', step: '0.1', min: 0 },
  { key: 'priceOcrPeakInputPerMTok', label: 'OCR 输入价·高峰', kind: 'number', group: 'price', step: '0.1', min: 0 },
  { key: 'priceOcrOffPeakInputPerMTok', label: 'OCR 输入价·空闲', kind: 'number', group: 'price', step: '0.1', min: 0 },
  { key: 'priceOcrPeakOutputPerMTok', label: 'OCR 输出价·高峰', kind: 'number', group: 'price', step: '0.1', min: 0 },
  { key: 'priceOcrOffPeakOutputPerMTok', label: 'OCR 输出价·空闲', kind: 'number', group: 'price', step: '0.1', min: 0 },
  { key: 'ocrImageTokensPerPage', label: '每页图片 tokens', kind: 'number', group: 'price', step: '16', min: 1, hint: 'DeepSeek 图片封顶 384 tokens' },
]

const GROUP_LABELS: Record<FieldDef['group'], string> = {
  doc: '文档导入',
  ocr: 'OCR 识别',
  price: '价格表（¥ / 百万 tokens，高峰=工作日 9–12 / 14–18）',
}

// --- card chrome (mirrors the family-shared PluginSettingsCard tokens) ---
const cardStyle: CSSProperties = {
  border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25))',
  background: 'var(--dsw-alias-bg-layer-3, rgba(128,128,128,.05))',
  borderRadius: 12,
  listStyle: 'none',
  transition: 'border-color .16s, background .16s',
  color: 'var(--dsw-alias-label-primary, inherit)',
  fontSize: 13,
  lineHeight: 1.5,
}
const headerStyle: CSSProperties = {
  appearance: 'none',
  width: '100%',
  boxSizing: 'border-box',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  padding: '12px 16px',
  fontSize: 'inherit',
  textAlign: 'left',
}
const headTextStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }
const nameStyle: CSSProperties = { fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }
const descriptionStyle: CSSProperties = { color: 'var(--dsw-alias-label-secondary, #999)', fontSize: 12 }
const chevronStyle: CSSProperties = { color: 'var(--dsw-alias-label-tertiary, #999)', flexShrink: 0, transition: 'transform .16s', display: 'flex' }
const bodyStyle: CSSProperties = { padding: '0 16px 14px', display: 'flex', flexDirection: 'column', gap: 12 }
const groupTitleStyle: CSSProperties = {
  margin: '4px 0 2px',
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--dsw-alias-label-secondary, #999)',
}
const gridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(150px, 1fr) minmax(120px, 200px) 24px',
  gap: '6px 10px',
  alignItems: 'center',
}
const labelStyle: CSSProperties = { minWidth: 0 }
const controlStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3))',
  background: 'var(--dsw-alias-bg-layer-1, rgba(128,128,128,.06))',
  borderRadius: 6,
  padding: '5px 8px',
  fontSize: 13,
  color: 'inherit',
}
const resetStyle: CSSProperties = {
  cursor: 'pointer',
  border: 'none',
  background: 'transparent',
  color: 'var(--dsw-alias-label-tertiary, #999)',
  fontSize: 13,
  padding: 0,
  opacity: 0.8,
}
const resetAllStyle: CSSProperties = {
  cursor: 'pointer',
  border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3))',
  background: 'var(--dsw-alias-bg-layer-1, rgba(128,128,128,.06))',
  borderRadius: 6,
  padding: '6px 12px',
  fontSize: 12,
  color: 'inherit',
  alignSelf: 'flex-start',
}
const noticeStyle: CSSProperties = { color: 'var(--dsw-alias-label-tertiary, #999)', fontSize: 12, margin: 0 }

function rawValue(snapshot: { value?: Record<string, unknown> }, key: string): unknown {
  return snapshot.value?.[key]
}

interface FieldRowProps {
  field: FieldDef
  value: unknown
  scope: DocImportSettingsScope
}

function FieldRow({ field, value, scope }: FieldRowProps): ReactElement {
  const [draft, setDraft] = useState<string>(() => {
    if (field.kind === 'boolean') return ''
    if (field.kind === 'number' && typeof value === 'number' && field.toDisplay !== undefined) return String(field.toDisplay(value))
    return value === undefined || value === null ? '' : String(value)
  })
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (field.kind === 'boolean') return
    if (field.kind === 'number' && typeof value === 'number' && field.toDisplay !== undefined) setDraft(String(field.toDisplay(value)))
    else setDraft(value === undefined || value === null ? '' : String(value))
  }, [field, value])

  const commit = async (): Promise<void> => {
    if (field.kind === 'boolean') return
    setSaving(true)
    try {
      const trimmed = draft.trim()
      if (trimmed === '') {
        await scope.unset(field.key)
        return
      }
      if (field.kind === 'number') {
        const parsed = Number(trimmed)
        if (!Number.isFinite(parsed)) return
        if (field.min !== undefined && parsed < field.min) return
        const final = field.fromDisplay !== undefined ? field.fromDisplay(parsed) : parsed
        await scope.set(field.key, final)
      } else {
        await scope.set(field.key, trimmed)
      }
    } catch (error) {
      console.warn('[doc-import] settings write failed:', error)
    } finally {
      setSaving(false)
    }
  }

  const title = field.hint !== undefined ? `${field.label} — ${field.hint}` : field.label
  return (
    <>
      <span style={labelStyle} title={title}>{field.label}</span>
      {field.kind === 'boolean' ? (
        <input
          type="checkbox"
          checked={value === true}
          style={{ justifySelf: 'start' }}
          onChange={(event) => {
            void scope.set(field.key, event.currentTarget.checked).catch(() => {})
          }}
        />
      ) : (
        <input
          type={field.kind === 'number' ? 'number' : 'text'}
          value={draft}
          step={field.step}
          min={field.min}
          disabled={saving}
          style={controlStyle}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onBlur={() => void commit()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
          }}
        />
      )}
      <button type="button" style={resetStyle} title="重置为默认" onClick={() => void scope.unset(field.key).catch(() => {})}>↺</button>
    </>
  )
}

function Chevron({ open }: { open: boolean }): ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ ...chevronStyle, transform: open ? 'rotate(180deg)' : 'none' }}
    >
      <path
        d="M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z"
        fill="currentColor"
      />
    </svg>
  )
}

/** Build the card component for one bound settings scope. */
export function createDocImportSettingsCard(scope: DocImportSettingsScope): (props: SlotProps) => ReactElement | null {
  return function DocImportSettingsCard(props: SlotProps): ReactElement | null {
    const snapshot = useSyncExternalStore(scope.subscribe, scope.getSnapshot, scope.getSnapshot)
    const t = props.t ?? ((key: string): string => key)
    const [open, setOpen] = useState(false)

    // Like the family card: no trace while the namespace is unavailable.
    if (snapshot.status === 'unavailable') return null
    if (snapshot.status === 'loading' && snapshot.value === undefined) return null

    const value = snapshot.value ?? {}
    const groups: FieldDef['group'][] = ['doc', 'ocr', 'price']
    return (
      <div style={cardStyle}>
        <button
          type="button"
          style={headerStyle}
          aria-expanded={open}
          aria-label={`${t(open ? 'card.collapse' : 'card.expand')}: ${t('card.title')}`}
          onClick={() => setOpen(!open)}
        >
          <span style={headTextStyle}>
            <span style={nameStyle} title={t('card.title')}>{t('card.title')}</span>
            <span style={descriptionStyle} title={t('card.description')}>{t('card.description')}</span>
          </span>
          <Chevron open={open} />
        </button>
        {open ? (
          <div style={bodyStyle}>
            {groups.map((group) => (
              <div key={group} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <h4 style={groupTitleStyle}>{GROUP_LABELS[group]}</h4>
                <div style={gridStyle}>
                  {FIELDS.filter((f) => f.group === group).map((field) => (
                    <FieldRow key={field.key} field={field} value={rawValue(snapshot, field.key)} scope={scope} />
                  ))}
                </div>
              </div>
            ))}
            <button
              type="button"
              style={resetAllStyle}
              onClick={() => {
                void Promise.all(FIELDS.map((f) => scope.unset(f.key))).catch((error) => {
                  console.warn('[doc-import] reset failed:', error)
                })
              }}
            >
              {t('card.resetAll')}
            </button>
            <p style={noticeStyle}>{t('card.saveHint')}</p>
          </div>
        ) : null}
      </div>
    )
  }
}

export { FIELDS }
