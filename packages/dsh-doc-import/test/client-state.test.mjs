import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  fromPersistedDrafts,
  getDrafts,
  rehydrateDrafts,
  resetDraftsForTest,
  toPersistedDrafts,
} from '../lib/client/state.js'
import { documentReferences, mergeReferences } from '../lib/client/send-hook.js'

const HEADER = '[document 示例.pdf, pdf, 1 页, 2342 字符, id: ' + 'a'.repeat(64) + ']\n（全文获取：……）'

function draft(overrides = {}) {
  let resolveReady = () => {}
  const ready = new Promise((resolve) => {
    resolveReady = resolve
  })
  return {
    id: 'b'.repeat(64),
    name: '示例.pdf',
    kind: 'pdf',
    bytes: 1234,
    chars: 2342,
    pages: 1,
    status: 'ready',
    ocrDone: 0,
    ocrTotal: 0,
    header: HEADER,
    text: '很长的正文不应被持久化',
    truncated: false,
    ready,
    resolveReady,
    ...overrides,
  }
}

test('persisted drafts round-trip without the extracted text and without pending uploads', () => {
  const payload = toPersistedDrafts([
    draft(),
    draft({ id: 'pending-xyz', status: 'uploading', header: '' }),
    draft({ id: 'c'.repeat(64), status: 'ocr', ocrDone: 2, ocrTotal: 5 }),
  ])
  const restored = fromPersistedDrafts(payload)
  assert.equal(restored.length, 2, 'the id-less upload must not be persisted')
  assert.equal(restored[0].id, 'b'.repeat(64))
  assert.equal(restored[0].header, HEADER)
  assert.equal(restored[0].text, '', 'extracted text stays on the host')
  assert.equal(restored[1].status, 'ocr')
  assert.equal(restored[1].ocrDone, 2)
  assert.equal(restored[1].ocrTotal, 5)
  assert.ok(!payload.includes('很长的正文'), 'the payload must not carry document text')
})

test('malformed persisted payloads restore nothing instead of throwing', () => {
  assert.deepEqual(fromPersistedDrafts(null), [])
  assert.deepEqual(fromPersistedDrafts(''), [])
  assert.deepEqual(fromPersistedDrafts('{not json'), [])
  assert.deepEqual(fromPersistedDrafts('{"a":1}'), [])
  assert.deepEqual(fromPersistedDrafts('[{"header":"x"}]'), [], 'records without an id are dropped')
})

test('a reload restores ready drafts and keeps them sendable', async () => {
  // Regression for the report "卡片已就绪但发送时消息里没有引用": a page reload
  // (or a client-module reload) used to wipe the module-level store, so the
  // send went out with no reference and the model saw no document at all.
  resetDraftsForTest()
  const storage = new Map()
  const fake = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  }
  fake.setItem('dsh-doc-import.drafts.v1', toPersistedDrafts([draft()]))
  rehydrateDrafts(fake)

  const restored = getDrafts()
  assert.equal(restored.length, 1, 'the ready draft must survive a reload')
  assert.equal(restored[0].header, HEADER)
  await restored[0].ready // resolves immediately: the document is already parsed

  // And the send path turns it into the reference the model needs.
  const references = documentReferences(getDrafts())
  assert.ok(references !== undefined && references.includes('id: ' + 'a'.repeat(64)))
  const merged = mergeReferences(references, '这个文档说的什么')
  assert.ok(merged.startsWith('[document '), 'the reference must precede the user text')
  assert.ok(merged.endsWith('这个文档说的什么'))
  resetDraftsForTest()
})

test('no ready draft leaves the message untouched', () => {
  assert.equal(documentReferences([{ status: 'ocr', header: HEADER }]), undefined)
  assert.equal(documentReferences([{ status: 'error', header: HEADER }]), undefined)
  assert.equal(documentReferences([{ status: 'ready', header: '' }]), undefined)
  assert.equal(mergeReferences(undefined, '只有文字'), '只有文字')
})

test('drafts are never dropped by a session switch API anymore', async () => {
  // The old store exposed clearAllDrafts(), and the chip dock called it on
  // every session change — attaching a document and then opening a new chat
  // silently discarded the reference. Lock that API out of the module.
  const state = await import('../lib/client/state.js')
  assert.equal('clearAllDrafts' in state, false, 'clearAllDrafts must not come back')
})
