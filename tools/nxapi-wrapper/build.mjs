/**
 * nxapi-wrapper ビルドスクリプト
 *
 * esbuild で bundle.mjs を生成する。
 * nxapi の product.js / remote-config.js がビルド時に globalThis 経由で
 * package.json / remote-config.json を参照するため、バナーで事前に注入する。
 * これにより import.meta.url ベースのファイル読み込みを回避できる。
 */

import { build } from 'esbuild';
import { readFileSync, writeFileSync, copyFileSync } from 'fs';
import { mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 1. nxapi-remote-config.json → nxapi のリソースにパッチ
const remoteConfigSrc = path.join(__dirname, '..', 'nxapi-remote-config.json');
const remoteConfigDst = path.join(__dirname, 'node_modules', 'nxapi', 'resources', 'common', 'remote-config.json');
try {
  copyFileSync(remoteConfigSrc, remoteConfigDst);
  console.log('patched remote-config.json');
} catch (e) {
  console.warn('remote-config patch skipped:', e.message);
}

// 2. nxapi の package.json と remote-config.json を読み込む
const nxapiPkg = JSON.parse(readFileSync(
  path.join(__dirname, 'node_modules', 'nxapi', 'package.json'), 'utf-8'));
const remoteConfig = JSON.parse(readFileSync(remoteConfigDst, 'utf-8'));

// 3. esbuild バナー: globalThis に埋め込む
//    これにより product.js / remote-config.js の top-level await が
//    ファイル読み込みにフォールバックしなくなる
// CJS バンドル用バナー: nxapi のバンドルグローバルを事前に設定する
// (product.js / remote-config.js のファイル読み込みフォールバックを回避)
const banner = [
  `globalThis.__NXAPI_BUNDLE_PKG__ = ${JSON.stringify(nxapiPkg)};`,
  `globalThis.__NXAPI_BUNDLE_DEFAULT_REMOTE_CONFIG__ = ${JSON.stringify(remoteConfig)};`,
  nxapiPkg.__nxapi_auth?.cli?.client_id
    ? `globalThis.__NXAPI_BUNDLE_NXAPI_AUTH_CLI_CLIENT_ID__ = ${JSON.stringify(nxapiPkg.__nxapi_auth.cli.client_id)};`
    : '',
].filter(Boolean).join('\n');

/**
 * nxapi の dist ファイルから top-level await を除去するパッチ。
 * __NXAPI_BUNDLE_PKG__ / __NXAPI_BUNDLE_DEFAULT_REMOTE_CONFIG__ をバナーで
 * 注入しているため、フォールバック用のファイル読み込みは実行されない。
 */
function patchNxapiFiles() {
  // ── product.js ──────────────────────────────────────────────────────
  const productPath = path.join(__dirname, 'node_modules', 'nxapi', 'dist', 'util', 'product.js');
  let productSrc = readFileSync(productPath, 'utf-8');

  // dir: uses fileURLToPath(import.meta.url) which is undefined in pkg's CJS snapshot
  // Replace with __dirname (available in pkg's CJS context) since we've patched away all
  // file-read uses of dir, so the exact path value doesn't matter
  productSrc = productSrc.replace(
    /export const dir = path\.resolve\(fileURLToPath\(import\.meta\.url\)[^;]+;/,
    "export const dir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();"
  );

  // top-level await: pkg (fallback file read)
  // Use [^;]+ to handle nested parens inside the readFile call
  productSrc = productSrc.replace(
    /export const pkg = embedded_pkg \?\? JSON\.parse\(await fs\.readFile\([^;]+\);/,
    "export const pkg = embedded_pkg ?? (() => { throw new Error('__NXAPI_BUNDLE_PKG__ not set'); })();"
  );
  // top-level await: docker (/.dockerenv check)
  productSrc = productSrc.replace(
    /export const docker = pkg\.__nxapi_docker \?\? await \(async \(\) => \{[\s\S]*?\}\)\(\);/,
    "export const docker = pkg.__nxapi_docker ?? null;"
  );
  // top-level await: git (git revision)
  productSrc = productSrc.replace(
    /export const git = typeof embedded_git !== 'undefined' \? embedded_git : pkg\.__nxapi_git \?\? await \(async \(\) => \{[\s\S]*?\}\)\(\);/,
    "export const git = typeof embedded_git !== 'undefined' ? embedded_git : pkg.__nxapi_git ?? null;"
  );

  writeFileSync(productPath, productSrc, 'utf-8');
  console.log('patched product.js');

  // ── remote-config.js ───────────────────────────────────────────────
  const remoteConfigPath = path.join(__dirname, 'node_modules', 'nxapi', 'dist', 'common', 'remote-config.js');
  let remoteConfigSrc = readFileSync(remoteConfigPath, 'utf-8');

  // top-level await: default_config (fallback resources read, spans 2 lines)
  // Use [\s\S]*? to handle nested parens across lines
  remoteConfigSrc = remoteConfigSrc.replace(
    /\.\.\.\(embedded_default_remote_config \?\?[\s\S]*?\)\)\),/,
    "...(embedded_default_remote_config ?? {}),"
  );
  // top-level await: debug_fixed_config — already patched to null in current dist
  remoteConfigSrc = remoteConfigSrc.replace(
    /const debug_fixed_config = !dev \? null :[\s\S]*?\|\| null;/,
    "const debug_fixed_config = null;"
  );
  // top-level await: export const cache (lines 181-184)
  remoteConfigSrc = remoteConfigSrc.replace(
    /export const cache = debug_fixed_config \? null :[\s\S]*?await loadRemoteConfig\(\);/,
    "export const cache = null;"
  );

  writeFileSync(remoteConfigPath, remoteConfigSrc, 'utf-8');
  console.log('patched remote-config.js');
}

// 4. nxapi の top-level await をパッチ（CJS バンドルのために必要）
//    - product.js / remote-config.js には top-level await があるが、
//      __NXAPI_BUNDLE_PKG__ / __NXAPI_BUNDLE_DEFAULT_REMOTE_CONFIG__ で
//      フォールバックは不要なので await を除去しても安全
patchNxapiFiles();

// 5. dist/ ディレクトリを作成
mkdirSync(path.join(__dirname, 'dist'), { recursive: true });

// 6. esbuild でバンドル（CJS 形式 — nxapi の top-level await をパッチ済み）
await build({
  entryPoints: [path.join(__dirname, 'wrapper.js')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: path.join(__dirname, 'dist', 'bundle.cjs'),
  banner: { js: banner },
});

console.log('bundle.mjs generated');
