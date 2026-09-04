/**
 * Manual host e2e: mounts the /doc-import route family on a throwaway HTTP
 * server (no harness needed) and exercises upload → parse → OCR → status →
 * read_document against the real files and the real DeepSeek API.
 *
 * Usage (from repo root):
 *   node scripts/e2e-host.mjs <pdf-path> [txt-path]
 */
import { createServer } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as yaml from 'js-yaml'
import { apply, parseDocument } from '../packages/dsh-doc-import/lib/index.js'

const pdfPath = process.argv[2]
if (pdfPath === undefined) {
  console.error('usage: node scripts/e2e-host.mjs <pdf-path> [txt-path]')
  process.exit(2)
}

// --- credentials: the same ref the plugin's seam resolves at runtime ---
const credsPath = join(process.env.DSH_HOME ?? `${process.env.USERPROFILE ?? ''}/.dsh`, '.credentials.yaml')
const creds = yaml.load(await readFile(credsPath, 'utf8'))
const apiKey = creds.refs.DEEPSEEK_API_KEY

// --- stub cordis ctx ---
const tools = { registered: [], register(d) { this.registered.push(d) } }
const webserver = {
  registered: [],
  register(route) {
    this.registered.push(route)
    server.on('request', async (req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://x').pathname
      if (pathname.startsWith(route.path)) await route.handler(req, res)
      else {
        res.writeHead(404)
        res.end()
      }
    })
  },
}
const settings = { installSection() {} }
const ctx = {
  get(name) {
    if (name === 'webServer') return webserver
    if (name === 'credentials') return { resolve: async () => ({ value: apiKey }) }
    return undefined
  },
  tools,
  inject(_names, cb) { cb(ctx) },
}

const server = createServer()
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const base = `http://127.0.0.1:${port}`

apply(ctx, {})
await new Promise((r) => setTimeout(r, 300))
console.log('== mounted routes:', webserver.registered.map((r) => r.path))

async function postJson(path, payload) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return { status: res.status, body: await res.json() }
}
async function getJson(path) {
  const res = await fetch(base + path)
  return { status: res.status, body: await res.json() }
}

const pdfBytes = await readFile(pdfPath)
const pdfName = pdfPath.split(/[\\/]/).pop()
console.log(`\n== attach: ${pdfName} (${(pdfBytes.length / 1024 / 1024).toFixed(2)} MiB)`)
const attach = await postJson('/doc-import/attach', {
  data: pdfBytes.toString('base64'),
  mediaType: 'application/pdf',
  name: pdfName,
})
if (!attach.body.ok) {
  console.error('ATTACH FAILED', JSON.stringify(attach.body, null, 2))
  process.exit(1)
}
const doc = attach.body.doc
console.log('id:', doc.id.slice(0, 16) + '…')
console.log('kind/pages/chars:', doc.kind, doc.pages, doc.chars)
console.log('ocrNeeded:', doc.ocrNeeded, 'ocrCount:', doc.ocrCount)
console.log('header:', doc.header)
console.log('cost:', doc.cost.label)
console.log('inline head:', doc.text.slice(0, 60).replace(/\n/g, ' '))

if (doc.ocrNeeded) {
  console.log('\n== start OCR (poll status until ready)')
  await postJson('/doc-import/ocr', { id: doc.id })
  const t0 = Date.now()
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000))
    const { body } = await getJson(`/doc-import/status?id=${doc.id}`)
    const s = body.doc
    process.stdout.write(`\r  ocr ${s.ocrDone}/${s.ocrTotal} phase=${s.phase} ${Math.round((Date.now() - t0) / 1000)}s   `)
    if (s.phase === 'ready' || s.phase === 'error') {
      console.log('')
      if (s.text !== undefined) {
        console.log('final chars:', s.chars)
        const marker = s.text.indexOf('[第')
        if (marker >= 0) console.log('OCR page sample:', s.text.slice(marker, marker + 120).replace(/\n/g, ' '))
      }
      if (s.warning) console.log('warning:', s.warning)
      break
    }
  }
}

if (process.argv[3] !== undefined) {
  const txtBytes = await readFile(process.argv[3])
  const attachTxt = await postJson('/doc-import/attach', {
    data: txtBytes.toString('base64'),
    mediaType: 'text/plain',
    name: process.argv[3].split(/[\\/]/).pop(),
  })
  console.log('\n== txt attach:', attachTxt.body.ok, attachTxt.body.doc?.chars, 'chars')
}

console.log('\n== read_document tool')
const tool = tools.registered.find((t) => t.name === 'read_document')
const result = await tool.execute({ docId: doc.id, maxChars: 100 })
console.log('read_document:', JSON.stringify(result))

console.log('\n== raw route')
const raw = await fetch(base + '/doc-import/raw/' + doc.id)
console.log('raw status:', raw.status, '| content-type:', raw.headers.get('content-type'), '| disposition:', raw.headers.get('content-disposition'))
console.log('raw bytes match original:', (await raw.arrayBuffer()).byteLength === pdfBytes.length)

console.log('\nE2E OK')
await new Promise((r) => server.close(r))
