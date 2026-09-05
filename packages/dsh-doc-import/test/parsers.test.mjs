import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { assemblePdfText, decodeText, detectKind, EXTRACTOR_VERSION, parseDocument, sanitizeDocxMarkdown } from '../lib/parsers.js'
import { estimateTokens, inlineCost, isPeakBeijing } from '../lib/cost.js'
import { resolveConfig } from '../lib/config.js'
import { joinTextItems } from '../lib/pdf.js'
import { readDocumentTool } from '../lib/tool.js'

const cfg = resolveConfig()

test('detectKind by extension and mime', () => {
  assert.equal(detectKind('论文.pdf', 'application/pdf'), 'pdf')
  assert.equal(detectKind('note.md', ''), 'md')
  assert.equal(detectKind('README.markdown', ''), 'md')
  assert.equal(detectKind('data.csv', 'text/csv'), 'csv')
  assert.equal(detectKind('report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), 'docx')
  assert.equal(detectKind('a.txt', 'text/plain'), 'txt')
  assert.equal(detectKind('song.mp3', 'audio/mpeg'), undefined)
})

test('decodeText: UTF-8, BOM, GB18030 fallback', () => {
  assert.equal(decodeText(Buffer.from('你好 world')), '你好 world')
  assert.equal(decodeText(Buffer.from('\uFEFF你好', 'utf8')), '你好')
  const gbk = Buffer.from('中文测试', 'latin1') // wrong decode on purpose
  assert.ok(decodeText(Buffer.from('中文测试')).length > 0)
  // real GB18030 bytes for 中文测试
  const realGbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4])
  assert.equal(decodeText(realGbk), '中文测试')
})

test('txt parser', async () => {
  const result = await parseDocument(Buffer.from('第一行\n第二行'), 'a.txt', 'text/plain', cfg)
  assert.equal(result.kind, 'txt')
  assert.equal(result.text, '第一行\n第二行')
})

test('csv parser produces a markdown table', async () => {
  const result = await parseDocument(Buffer.from('名称,数量\n苹果,3\n香蕉,5'), 'a.csv', 'text/csv', cfg)
  assert.match(result.text, /\| 名称 \| 数量 \|/)
  assert.match(result.text, /\| 苹果 \| 3 \|/)
})

test('csv parser respects quotes and delimiters', async () => {
  const result = await parseDocument(Buffer.from('a;b\n"x;y";2'), 'a.csv', 'text/csv', cfg)
  assert.match(result.text, /\| x;y \|/)
})

test('cost estimation: CJK ≈ 1 token/char, prices from config', () => {
  const tokens = estimateTokens('中文中文中文中文')
  assert.equal(tokens, 8)
  const cost = inlineCost('中文中文中文中文', cfg)
  assert.ok(cost.cny > 0)
  assert.ok(cost.cnyPeak >= cost.cnyOffPeak)
  assert.equal(typeof isPeakBeijing(), 'boolean')
})

test('pdf text item joiner keeps lines separated', () => {
  // y is bottom-up: larger y = higher on the page, so the y=20 line reads first.
  const items = [
    { str: 'Hello', transform: [0, 0, 0, 0, 0, 0], width: 30, hasEOL: false },
    { str: 'world', transform: [0, 0, 0, 0, 35, 0], width: 30, hasEOL: true },
    { str: 'Next', transform: [0, 0, 0, 0, 0, 20], width: 20, hasEOL: false },
  ]
  assert.equal(joinTextItems(items), 'Next\nHello world')
})

test('pdf assembly ignores stream order and sorts by visual y (descending)', () => {
  // Content stream order is jumbled: markers ("1."/"2.") arrive last, and the
  // page y axis is bottom-up (larger y = higher). Visual reading order must
  // win: "1. 场景建模" before "2. 方案评估".
  const items = [
    { str: '场景建模', transform: [8.79, 0, 0, 8.79, 48.2, 244.17], width: 34.6 },
    { str: '方案评估', transform: [8.79, 0, 0, 8.79, 48.2, 232.17], width: 34.6 },
    { str: '1.', transform: [8.79, 0, 0, 8.79, 33.1, 244.17], width: 7.3 },
    { str: '2.', transform: [8.79, 0, 0, 8.79, 33.1, 232.17], width: 7.3 },
  ]
  assert.equal(joinTextItems(items), '1. 场景建模\n2. 方案评估')
})

test('pdf assembly excludes rotated text from line clustering', () => {
  const items = [
    { str: 'normal', transform: [8.79, 0, 0, 8.79, 10, 100], width: 40 },
    { str: 'rotated', transform: [0, 8.79, -8.79, 0, 50, 100], width: 40 },
  ]
  const text = joinTextItems(items)
  assert.ok(text.includes('normal'))
  assert.ok(text.includes('rotated'))
})

test('CJK runs on the same visual line join without spaces', () => {
  const items = [
    { str: '中文', transform: [8.79, 0, 0, 8.79, 48.2, 100], width: 20 },
    { str: '文档', transform: [8.79, 0, 0, 8.79, 68.2, 100], width: 20 },
  ]
  assert.equal(joinTextItems(items), '中文文档')
})

test('CJK joining keeps Latin boundaries and existing whitespace intact', () => {
  // Latin/digit boundaries keep the hard space (e.g. "1. 场景建模" above).
  // Boundary whitespace must not be doubled.
  const spaced = [
    { str: 'a ', transform: [1, 0, 0, 1, 0, 100], width: 10 },
    { str: 'b', transform: [1, 0, 0, 1, 12, 100], width: 10 },
  ]
  assert.equal(joinTextItems(spaced), 'a b')
})

test('CJK joining handles the prepend branch without spaces', () => {
  // Overlapping widths put the second item left of the running line end:
  // it is prepended, and the CJK boundary joins with no space.
  const overlap = [
    { str: '标题行', transform: [1, 0, 0, 1, 0, 100], width: 90 },
    { str: '页', transform: [1, 0, 0, 1, 10, 100], width: 10 },
  ]
  assert.equal(joinTextItems(overlap), '页标题行')
})

test('assemblePdfText marks every page and reports OCR errors as retryable', () => {
  const pages = [
    { n: 1, source: 'text', text: '第一页正文' },
    { n: 2, source: 'ocr', text: '', ocrText: '扫描内容' },
    { n: 3, source: 'ocr', text: '' },
    { n: 4, source: 'ocr', text: '', ocrError: '请求超时' },
  ]
  const out = assemblePdfText(pages, (n) => `【第 ${n} 页 · 扫描页文本待 OCR】`)
  assert.ok(out.includes('\n\n[第 1 页]\n第一页正文'))
  assert.ok(out.includes('\n\n[第 2 页 · OCR]\n扫描内容'))
  assert.ok(out.includes('\n\n[第 3 页 · OCR]\n【第 3 页 · 扫描页文本待 OCR】'))
  assert.ok(out.includes('\n\n[第 4 页 · OCR]\n【第 4 页 · OCR 失败：请求超时】'))
})

test('EXTRACTOR_VERSION bumped to 4 for the docx-de noise output shape', () => {
  assert.equal(EXTRACTOR_VERSION, 4)
})

test('sanitizeDocxMarkdown replaces embedded-image data URIs with placeholders', () => {
  const raw = '<a id="_Hlk1"></a>![徽标\n\nAI 生成的内容可能不正确。](data:image/png;base64,'
    + 'A'.repeat(200) + ')\n\n\n正文第一段。\n\n![图表](data:image/png;base64,'
    + 'B'.repeat(100) + ')\n结尾。'
  const { text, images } = sanitizeDocxMarkdown(raw)
  assert.equal(images, 2)
  assert.ok(!text.includes('base64'))
  assert.ok(!text.includes('<a id='))
  assert.ok(text.includes('【图片】'))
  assert.ok(text.includes('正文第一段。'))
  assert.ok(text.includes('结尾。'))
  assert.ok(!/\n{3,}/.test(text))
})

test('sanitizeDocxMarkdown strips stray long base64 leftovers', () => {
  const raw = '前文 data:image/jpeg;base64,' + 'C'.repeat(100) + ' 后文'
  const { text, images } = sanitizeDocxMarkdown(raw)
  assert.equal(images, 1)
  assert.ok(text.includes('【图片】'))
  assert.ok(!text.includes('CCCCCC'))
})

function fakeStore(text) {
  return {
    registry: new Map([['d1', { id: 'd1', name: 'doc.pdf' }]]),
    readText: async () => text,
  }
}

test('read_document supports offset paging through long documents', async () => {
  const full = 'A'.repeat(100) + 'B'.repeat(50)
  const tool = readDocumentTool(fakeStore(full))
  const first = await tool.execute({ docId: 'd1', maxChars: 100 })
  assert.equal(first.chars, 100)
  assert.equal(first.totalChars, 150)
  assert.equal(first.truncated, true)
  const second = await tool.execute({ docId: 'd1', offset: 100, maxChars: 100 })
  assert.equal(second.text, 'B'.repeat(50))
  assert.equal(second.chars, 50)
  assert.equal(second.totalChars, 150)
  assert.equal(second.truncated, false)
  const whole = await tool.execute({ docId: 'd1' })
  assert.equal(whole.text, full)
  assert.equal(whole.chars, 150)
  assert.equal(whole.truncated, false)
})

test('read_document returns empty text past the end', async () => {
  const tool = readDocumentTool(fakeStore('short'))
  const tail = await tool.execute({ docId: 'd1', offset: 999 })
  assert.equal(tail.text, '')
  assert.equal(tail.chars, 0)
  assert.equal(tail.totalChars, 5)
  assert.equal(tail.truncated, false)
})

test('read_document rejects unknown doc ids', async () => {
  const tool = readDocumentTool(fakeStore('x'))
  await assert.rejects(() => tool.execute({ docId: 'ghost' }))
})
