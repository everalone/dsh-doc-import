import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { decodeText, detectKind, parseDocument } from '../lib/parsers.js'
import { estimateTokens, inlineCost, isPeakBeijing } from '../lib/cost.js'
import { resolveConfig } from '../lib/config.js'
import { joinTextItems } from '../lib/pdf.js'

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
