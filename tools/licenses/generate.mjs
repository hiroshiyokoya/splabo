#!/usr/bin/env node
/**
 * 配布物に入る部品のライセンス一覧（app/public/third-party-licenses.txt）を作る（#534）。
 *
 * 配布物に入るもの:
 *   1. SpLabo 本体（MIT）
 *   2. Rust の crate（本体のバイナリにリンクされるもの。`cargo metadata` の normal 依存を辿る）
 *   3. 画面の JS（app の本番依存。インストール済みの node_modules を辿る）
 *   4. nxapi サイドカー（AGPL-3.0-or-later。esbuild のバンドルに実際に入ったパッケージ + Node.js ランタイム）
 *
 * 各ライセンスの「著作権表示とライセンス文を配布物に含める」条件を満たすため、
 * 各パッケージのライセンスファイルの本文をそのまま載せる（同じ本文はまとめて 1 回）。
 *
 * 使い方（リポジトリのルートで。リリース WF が各 OS のビルドの前に実行する）:
 *   node tools/licenses/generate.mjs [--target <rust のターゲット>] [--sidecar-dir tools/nxapi-wrapper]
 *
 * 前提:
 *   - ルートで `npm install` 済み（app の node_modules）
 *   - サイドカーをビルド済み（`<sidecar-dir>/dist/bundle.cjs` と `<sidecar-dir>/node_modules`）
 *   - crate のソースが手元にある（`cargo fetch` 済み）
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const REPO_URL = 'https://github.com/hiroshiyokoya/splabo'

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : fallback
}

const sidecarDir = resolve(ROOT, arg('--sidecar-dir', 'tools/nxapi-wrapper'))
const outPath = resolve(ROOT, arg('--out', 'app/public/third-party-licenses.txt'))
const target = arg('--target', null) ?? hostTriple()

function hostTriple() {
  const out = execFileSync('rustc', ['-vV'], { encoding: 'utf8' })
  return out.match(/^host: (.+)$/m)[1].trim()
}

/** パッケージのディレクトリにあるライセンス関係のファイル（LICENSE・COPYING・NOTICE など）を読む。 */
const LICENSE_FILE = /^(licen[cs]e|copying|notice|copyright|unlicense|authors)([-._].*)?$/i
function licenseTexts(dir) {
  if (!dir || !existsSync(dir)) return []
  return readdirSync(dir)
    .filter(f => LICENSE_FILE.test(f) && statSync(join(dir, f)).isFile())
    .sort()
    .map(f => ({ file: f, text: readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n').trim() }))
}

// ── 1. Rust の crate ─────────────────────────────────────────────────
function rustCrates() {
  const meta = JSON.parse(execFileSync(
    'cargo',
    ['metadata', '--format-version', '1', '--filter-platform', target, '--manifest-path', join(ROOT, 'Cargo.toml')],
    { encoding: 'utf8', maxBuffer: 1 << 28 },
  ))
  const ws = new Set(meta.workspace_members)
  const byId = new Map(meta.packages.map(p => [p.id, p]))
  const nodes = new Map(meta.resolve.nodes.map(n => [n.id, n]))
  // 本体から normal 依存だけを辿る（build.rs 用・テスト用は配布物に入らない）
  const seen = new Set()
  const stack = [...ws]
  while (stack.length) {
    const id = stack.pop()
    if (seen.has(id)) continue
    seen.add(id)
    for (const d of nodes.get(id)?.deps ?? []) {
      if (d.dep_kinds.some(k => k.kind === null)) stack.push(d.pkg)
    }
  }
  return [...seen]
    .filter(id => !ws.has(id))
    .map(id => byId.get(id))
    .map(p => ({
      name: p.name,
      version: p.version,
      license: p.license ?? '(記載なし)',
      source: `https://crates.io/crates/${p.name}/${p.version}`,
      authors: p.authors ?? [],
      texts: licenseTexts(dirname(p.manifest_path)),
    }))
}

// ── 2. 画面の JS（app の本番依存） ───────────────────────────────────
/** package.json の author（文字列か {name, email}）を、表示用の配列にする。 */
function npmAuthors(pkg) {
  const a = pkg.author
  if (!a) return []
  if (typeof a === 'string') return [a]
  return [a.email ? `${a.name} <${a.email}>` : a.name].filter(Boolean)
}

/** `from` から上に向かって node_modules/<name> を探す（Node の解決と同じ順）。 */
function findPackageDir(name, from) {
  let dir = from
  for (;;) {
    const cand = join(dir, 'node_modules', name)
    if (existsSync(join(cand, 'package.json'))) return cand
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function nodePackages(startDir, rootDeps) {
  const out = new Map()
  const queue = rootDeps.map(name => ({ name, from: startDir, optional: false }))
  while (queue.length) {
    const { name, from, optional } = queue.shift()
    const dir = findPackageDir(name, from)
    if (!dir) {
      if (!optional) console.warn(`[licenses] 見つからない: ${name}（${from} から）`)
      continue
    }
    if (out.has(dir)) continue
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    out.set(dir, {
      name: pkg.name ?? name,
      version: pkg.version ?? '',
      license: typeof pkg.license === 'string' ? pkg.license : pkg.license?.type ?? '(記載なし)',
      source: `https://www.npmjs.com/package/${pkg.name ?? name}/v/${pkg.version}`,
      authors: npmAuthors(pkg),
      texts: licenseTexts(dir),
    })
    for (const d of Object.keys(pkg.dependencies ?? {})) queue.push({ name: d, from: dir, optional: false })
    for (const d of Object.keys(pkg.optionalDependencies ?? {})) queue.push({ name: d, from: dir, optional: true })
  }
  return [...out.values()]
}

function appPackages() {
  const appPkg = JSON.parse(readFileSync(join(ROOT, 'app', 'package.json'), 'utf8'))
  return nodePackages(join(ROOT, 'app'), Object.keys(appPkg.dependencies ?? {}))
}

// ── 3. nxapi サイドカー ──────────────────────────────────────────────
/** esbuild のバンドルに実際に入ったパッケージ名（`// node_modules/<名前>/...` の印から数える）。 */
function sidecarBundledNames() {
  const bundle = join(sidecarDir, 'dist', 'bundle.cjs')
  if (!existsSync(bundle)) {
    throw new Error(`${bundle} がありません。先にサイドカーをビルドしてください（npm run bundle）`)
  }
  const names = new Set()
  for (const m of readFileSync(bundle, 'utf8').matchAll(/^\/\/ node_modules\/((?:@[^/\s]+\/)?[^/\s]+)\//gm)) {
    names.add(m[1])
  }
  return [...names].sort()
}

function sidecarPackages() {
  return sidecarBundledNames().map(name => {
    const dir = findPackageDir(name, sidecarDir)
    if (!dir) throw new Error(`サイドカーの依存 ${name} が ${sidecarDir}/node_modules にありません`)
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    return {
      name,
      version: pkg.version ?? '',
      license: typeof pkg.license === 'string' ? pkg.license : '(記載なし)',
      source: `https://www.npmjs.com/package/${name}/v/${pkg.version}`,
      authors: npmAuthors(pkg),
      texts: licenseTexts(dir),
    }
  })
}

/** サイドカーに pkg が埋め込む Node.js ランタイムのライセンス（ビルドに使った Node のもの）。 */
function nodeRuntime() {
  const dir = dirname(process.execPath)
  const candidates = [join(dir, 'LICENSE'), join(dir, '..', 'LICENSE'), join(dir, '..', 'share', 'doc', 'node', 'LICENSE')]
  const file = candidates.find(existsSync)
  return {
    name: 'Node.js（サイドカーに埋め込むランタイム）',
    version: process.version,
    license: 'MIT（同梱のサードパーティ部品はそれぞれのライセンス。本文参照）',
    source: `https://github.com/nodejs/node/blob/${process.version}/LICENSE`,
    texts: file ? [{ file: 'LICENSE', text: readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trim() }] : [],
  }
}

// ── ライセンスファイルを同梱していない部品の補い ─────────────────────
//
// crate や npm パッケージの中には、ライセンス名だけ書いてファイルを同梱しないものがある。
// その場合も本文を載せるため、宣言されたライセンスの標準の本文を使う
// （MIT・BSD・ISC は作者名を入れたひな形。Apache-2.0・MPL-2.0 は、ほかの部品が同梱している同じ本文）。

const MIT = holder => `MIT License

Copyright (c) ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`

const ISC = holder => `ISC License

Copyright (c) ${holder}

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.`

const BSD3 = holder => `BSD 3-Clause License

Copyright (c) ${holder}

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`

/** ほかの部品が同梱している本文から、Apache-2.0・MPL-2.0 の全文を拾う。 */
function findFullText(all, pattern) {
  for (const p of all) for (const t of p.texts) if (pattern.test(t.text.slice(0, 400))) return t.text
  return null
}

/** 宣言されたライセンス名（SPDX の式）から、載せる標準の本文を決める。 */
function fallbackTexts(p, apache, mpl) {
  const holder = p.authors?.length ? `${p.authors.join(', ')}（${p.name} の作者）` : `the ${p.name} authors`
  const known = {
    MIT: () => MIT(holder),
    'BSD-3-Clause': () => BSD3(holder),
    ISC: () => ISC(holder),
    'Apache-2.0': () => apache,
    'MPL-2.0': () => mpl,
  }
  const ids = p.license.replace(/[()]/g, ' ').split(/\s+(?:OR|AND)\s+|\/|\s+/).filter(Boolean)
  // AND は全部、OR は 1 つ（並び順で先にあって本文を用意できるもの）
  const pick = /\bAND\b/.test(p.license) ? ids.filter(id => known[id]) : ids.filter(id => known[id]).slice(0, 1)
  return pick
    .map(id => ({ file: `${id}（ライセンスファイルが同梱されていないため、宣言されたライセンスの標準の本文）`, text: known[id]() }))
    .filter(t => t.text)
}

function fillMissing(all) {
  const apache = findFullText(all, /Apache License\s+Version 2\.0, January 2004/)
  const mpl = findFullText(all, /Mozilla Public License Version 2\.0/)
  for (const p of all) {
    if (p.texts.length === 0) p.texts = fallbackTexts(p, apache, mpl)
  }
}

// ── 出力 ─────────────────────────────────────────────────────────────
const RULE = '='.repeat(78)
const SUB = '-'.repeat(78)

/** パッケージの一覧と、ライセンス本文（同じ本文は 1 回だけ）を書く。 */
function section(title, intro, packages) {
  const lines = [RULE, title, RULE, '', ...intro, '']
  const sorted = [...packages].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
  lines.push(`パッケージ（${sorted.length} 個）:`, '')
  for (const p of sorted) lines.push(`  ${`${p.name} ${p.version}`.trim()} — ${p.license}`)
  lines.push('')
  // 本文ごとにまとめる
  const groups = new Map()
  const noFile = []
  for (const p of sorted) {
    if (p.texts.length === 0) {
      noFile.push(p)
      continue
    }
    const body = p.texts.map(t => (p.texts.length > 1 ? `[${t.file}]\n` : '') + t.text).join('\n\n')
    const key = createHash('sha256').update(body).digest('hex')
    if (!groups.has(key)) groups.set(key, { body, users: [] })
    groups.get(key).users.push(`${p.name} ${p.version}`.trim())
  }
  for (const { body, users } of groups.values()) {
    lines.push(SUB, `適用: ${users.join(', ')}`, SUB, '', body, '')
  }
  if (noFile.length > 0) {
    lines.push(SUB, 'ライセンスファイルが同梱されていないもの（記載のライセンス名と入手先）', SUB, '')
    for (const p of noFile) lines.push(`  ${p.name} ${p.version} — ${p.license} — ${p.source}`)
    lines.push('')
  }
  return lines.join('\n')
}

const rust = rustCrates()
const app = appPackages()
const sidecar = sidecarPackages()
const runtime = nodeRuntime()
fillMissing([...rust, ...app, ...sidecar])
const mpl = rust.filter(c => /MPL/.test(c.license))
const unlicensed = sidecar.filter(p => p.license === '(記載なし)')

const header = [
  'SpLabo — 同梱ソフトウェアのライセンス',
  '',
  `ソースコード: ${REPO_URL}（各リリースのソースは、そのバージョンのタグ splabo-vX.Y.Z）`,
  `作成: ${new Date().toISOString().slice(0, 10)}・Rust のターゲット ${target}・tools/licenses/generate.mjs が自動で作る`,
  '',
  'SpLabo は 2 つのプログラムでできています。',
  '',
  '  1. SpLabo 本体 — MIT License。下の「SpLabo 本体」の本文を参照',
  '  2. nxapi サイドカー（nxapi-sidecar）— GNU Affero General Public License v3.0 or later',
  '     Nintendo アカウントの認証と SplatNet 3 の取得に使う、nxapi の改変版を含む別のプログラムです。',
  '     本体とはコマンドライン引数と標準入出力だけでやり取りします。',
  `     対応するソースと改変の内容: ${REPO_URL}/tree/develop/tools/nxapi-wrapper`,
  '     （各リリースの版は、そのバージョンのタグの tools/nxapi-wrapper）',
  '',
  ...(mpl.length > 0 ? [
    `Mozilla Public License 2.0 の部品（${mpl.map(c => c.name).join('・')}）は改変せずに使っています。`,
    'ソースは各部品の crates.io のページから入手できます（下の一覧の版）。',
    '',
  ] : []),
  ...(unlicensed.length > 0 ? [
    `次の部品は、作者がライセンスを示していません: ${unlicensed.map(p => `${p.name} ${p.version}`).join('・')}`,
    'nxapi の依存として入っています。',
    '',
  ] : []),
].join('\n')

const parts = [
  header,
  section('SpLabo 本体', ['SpLabo のソースコード（tools/nxapi-wrapper を除く）は MIT License です。'], [
    { name: 'SpLabo', version: '', license: 'MIT', source: REPO_URL, authors: [], texts: licenseTexts(ROOT).filter(t => /^license$/i.test(t.file)) },
  ]),
  section('Rust の部品（SpLabo 本体に組み込み）', [`ターゲット ${target} でリンクされる crate。`], rust),
  section('画面の部品（JavaScript・SpLabo 本体に組み込み）', ['app の本番依存。'], app),
  section('nxapi サイドカーの部品', [
    'サイドカーは全体として GNU Affero General Public License v3.0 or later です（本文は nxapi の項）。',
    'esbuild のバンドルに実際に入ったパッケージと、pkg が埋め込む Node.js ランタイムです。',
  ], [...sidecar, runtime]),
]

writeFileSync(outPath, parts.join('\n\n') + '\n', 'utf8')
const size = statSync(outPath).size
console.log(`[licenses] ${outPath} を書きました（${Math.round(size / 1024)} KB・Rust ${rust.length}・JS ${app.length}・サイドカー ${sidecar.length} + Node.js）`)
for (const p of [...rust, ...app, ...sidecar].filter(p => p.texts.length === 0)) {
  console.warn(`[licenses] ライセンスファイルなし: ${p.name} ${p.version}（${p.license}）`)
}
