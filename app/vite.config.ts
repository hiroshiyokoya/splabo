import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'

// tools/data/ を /data/ として配信するミドルウェア
function serveToolsData() {
  const dataDir = path.resolve(process.cwd(), '../tools/data')

  return {
    name: 'serve-tools-data',
    configureServer(server: any) {
      server.middlewares.use('/data', (req: any, res: any, next: any) => {
        const filePath = path.join(dataDir, decodeURIComponent(req.url || ''))

        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
          return next()
        }

        const ext = path.extname(filePath).toLowerCase()

        if (ext === '.json') {
          const buf = fs.readFileSync(filePath)
          let text: string
          try {
            text = new TextDecoder('utf-8', { fatal: true }).decode(buf)
          } catch {
            text = new TextDecoder('shift_jis').decode(buf)
          }
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(text)
        } else {
          const mime: Record<string, string> = {
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.webp': 'image/webp',
          }
          res.setHeader('Content-Type', mime[ext] ?? 'application/octet-stream')
          fs.createReadStream(filePath).pipe(res)
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), serveToolsData()],
})
