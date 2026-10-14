// `tauri dev` の beforeDevCommand（#811）。
//
// PC の画面は Vite の dev サーバー（:1420）から出るが、スマホ Web 版の画面はコンパニオン
// サーバーが app/dist から出す（companion.rs の respond_static）。dev サーバーだけだと
// app/dist は古いままになり、git pull やコードの変更がスマホに出ない。
// そこで dev サーバーと一緒に `vite build --watch` を動かし、変更があれば app/dist を
// ビルドし直す。どちらかが終わったら、もう片方も止める。
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const viteBin = join(dirname(createRequire(import.meta.url).resolve('vite/package.json')), 'bin', 'vite.js')

const run = args => spawn(process.execPath, [viteBin, ...args], { cwd: appDir, stdio: 'inherit' })

const children = [
  run([]),
  // ビルドのログはエラーだけにする（ビルドし直すたびに出る既知の警告で、dev サーバーのログを埋もれさせない）
  run(['build', '--watch', '--logLevel', 'error']),
]

let stopping = false
const stop = code => {
  if (stopping) return
  stopping = true
  for (const c of children) if (c.exitCode === null) c.kill()
  process.exit(code ?? 0)
}

for (const c of children) c.on('exit', code => stop(code))
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => stop(0))
