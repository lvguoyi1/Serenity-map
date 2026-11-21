import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { createStoreServer } from '../scripts/store-api.mjs'

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
}
const csp = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "media-src 'self' data: blob: https:",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ')

export async function startDesktopServer({ distDir, storeDir, settings }) {
  const token = randomBytes(32).toString('hex')
  const server = createStoreServer({
    storeDir,
    authorize: (request) => request.headers['x-serenity-session'] === token,
    getAiConfig: settings.forRequest,
    async handleDesktopRequest(request, response, url, readJsonBody, sendJson) {
      if (url.pathname === '/api/desktop/settings') {
        if (request.method === 'GET') {
          sendJson(response, 200, settings.publicConfig())
          return true
        }
        if (request.method === 'PUT') {
          let input
          try {
            input = await readJsonBody(request)
          } catch {
            sendJson(response, 400, { error: '配置 JSON 无效。' })
            return true
          }
          sendJson(response, 200, await settings.save(input))
          return true
        }
      }

      if (request.method !== 'GET') return false
      const path = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
      if (path !== 'index.html' && !/^assets\/[\w.-]+$/.test(path)) return false
      const contentType = contentTypes[extname(path)]
      if (!contentType) return false
      let body
      try {
        body = await readFile(join(distDir, path))
      } catch (error) {
        if (error.code === 'ENOENT') return false
        throw error
      }
      response.writeHead(200, {
        'Content-Type': contentType,
        'Content-Security-Policy': csp,
        'X-Content-Type-Options': 'nosniff',
      })
      response.end(path === 'index.html'
        ? body.toString('utf8').replace('</head>', '<meta name="serenity-desktop"></head>')
        : body)
      return true
    },
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const origin = `http://127.0.0.1:${server.address().port}`
  return { origin, token, close: () => server.close() }
}
