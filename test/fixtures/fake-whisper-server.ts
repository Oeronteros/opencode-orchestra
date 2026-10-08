// Minimal whisper-server stand-in for spawn-based tests.
import { appendFileSync } from 'node:fs'
import http from 'node:http'

const portIndex = process.argv.indexOf('--port')
const port = portIndex === -1 ? 0 : Number(process.argv[portIndex + 1])
const capture = process.env.FAKE_WHISPER_CAPTURE

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url === undefined || !req.url.startsWith('/inference')) {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<html>whisper server</html>')
    return
  }
  const chunks: Buffer[] = []
  req.on('data', (chunk: Buffer) => chunks.push(chunk))
  req.on('end', () => {
    const body = Buffer.concat(chunks)
    if (body.toString('latin1').includes('name="language"\r\n\r\ncrash')) process.exit(3)
    if (capture !== undefined) {
      appendFileSync(capture, `${JSON.stringify({ contentType: req.headers['content-type'], body: body.toString('latin1') })}\n`)
    }
    const slow = body.toString('latin1').includes('name="language"\r\n\r\nslow')
    const reply = () => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('Привет из тестового сервера')
    }
    if (slow) setTimeout(reply, 5000)
    else reply()
  })
})
server.listen(port, '127.0.0.1')
