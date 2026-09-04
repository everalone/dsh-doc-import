/**
 * Post-restart live verification against the running web GUI
 * (default http://127.0.0.1:3080). Proves the plugin is actually mounted in
 * the live harness: the route family answers, and a real document upload
 * round-trips through parse → store → status.
 *
 * Usage:
 *   node scripts/verify-live.mjs [baseUrl]
 */
const base = process.argv[2] ?? 'http://127.0.0.1:3080'

const sample = `dsh-doc-import 活体验证
这是通过 live GUI 路由导入的样例文档。
第一行
第二行`

const attach = await fetch(`${base}/doc-import/attach`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    data: Buffer.from(sample, 'utf8').toString('base64'),
    mediaType: 'text/plain',
    name: 'verify-live.txt',
  }),
})

if (!attach.ok || attach.status === 404 || attach.status === 405) {
  const text = await attach.text().catch(() => '')
  const isJson = text.trim().startsWith('{')
  if (isJson) {
    console.log('ROUTE REACHABLE but rejected:', attach.status, text.slice(0, 200))
    process.exit(1)
  }
  console.log(`NOT MOUNTED YET: /doc-import/attach → ${attach.status}（插件路由未挂载 — 需要重启 dsh web）`)
  process.exit(1)
}

const body = await attach.json()
if (!body.ok) {
  console.log('ATTACH FAILED:', JSON.stringify(body))
  process.exit(1)
}
const doc = body.doc
console.log('MOUNTED ✓  attach ok:', doc.kind, doc.chars, 'chars, header:', doc.header.slice(0, 60))

const status = await (await fetch(`${base}/doc-import/status?id=${doc.id}`)).json()
console.log('status ✓  phase:', status.doc.phase, 'chars:', status.doc.chars, 'cost:', status.doc.cost?.label ?? '-')

console.log('LIVE VERIFICATION PASSED')
