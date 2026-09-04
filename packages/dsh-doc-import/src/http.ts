/**
 * Loopback trust fence and JSON body/response helpers for the /doc-import/*
 * routes. Semantics mirror the dsh-web-shared host helpers: RFC 5735 IPv4
 * 127/8, ::1, IPv4-mapped ::ffff:127/8, localhost hostnames, plus the browser
 * same-origin markers. X-Forwarded-For is never trusted.
 * @module dsh-doc-import/http
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/** Whether a socket remote address names the loopback range. */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) {
    const v4 = normalized.slice('::ffff:'.length)
    return v4.split('.')[0] === '127' && v4.split('.').length === 4
  }
  const parts = normalized.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Whether a normalized URL hostname names the loopback authority. */
export function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || (hostname.split('.').length === 4 && hostname.split('.')[0] === '127')
}

/** Request-level trust fence for the browser-to-host upload seam. */
export function isLoopbackRequest(request: IncomingMessage): boolean {
  if (!isLoopbackAddress(request.socket.remoteAddress)) return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl: URL
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** Bounded JSON body reader; returns null on empty/invalid/oversized bodies. */
export async function readJsonBody(req: IncomingMessage, maxBytes: number, objectOnly = true): Promise<unknown | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > maxBytes) return null
    chunks.push(buffer)
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (objectOnly && (typeof value !== 'object' || value === null || Array.isArray(value))) return null
    return value
  } catch {
    return null
  }
}

/** Write one JSON response with the family-default headers. */
export function writeJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  })
  res.end(body)
}
