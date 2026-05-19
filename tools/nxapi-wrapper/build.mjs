/**
 * nxapi-wrapper ビルドスクリプト
 *
 * esbuild で bundle.cjs を生成する。
 * nxapi の product.js / remote-config.js がビルド時に globalThis 経由で
 * package.json / remote-config.json を参照するため、バナーで事前に注入する。
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
const banner = [
  `globalThis.__NXAPI_BUNDLE_PKG__ = ${JSON.stringify(nxapiPkg)};`,
  `globalThis.__NXAPI_BUNDLE_DEFAULT_REMOTE_CONFIG__ = ${JSON.stringify(remoteConfig)};`,
  nxapiPkg.__nxapi_auth?.cli?.client_id
    ? `globalThis.__NXAPI_BUNDLE_NXAPI_AUTH_CLI_CLIENT_ID__ = ${JSON.stringify(nxapiPkg.__nxapi_auth.cli.client_id)};`
    : '',
].filter(Boolean).join('\n');

/**
 * nxapi の dist ファイルから top-level await を除去するパッチ。
 */
function patchNxapiFiles() {
  // ── product.js ──────────────────────────────────────────────────────
  const productPath = path.join(__dirname, 'node_modules', 'nxapi', 'dist', 'util', 'product.js');
  let productSrc = readFileSync(productPath, 'utf-8');

  productSrc = productSrc.replace(
    /export const dir = path\.resolve\(fileURLToPath\(import\.meta\.url\)[^;]+;/,
    "export const dir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();"
  );
  productSrc = productSrc.replace(
    /export const pkg = embedded_pkg \?\? JSON\.parse\(await fs\.readFile\([^;]+\);/,
    "export const pkg = embedded_pkg ?? (() => { throw new Error('__NXAPI_BUNDLE_PKG__ not set'); })();"
  );
  productSrc = productSrc.replace(
    /export const docker = pkg\.__nxapi_docker \?\? await \(async \(\) => \{[\s\S]*?\}\)\(\);/,
    "export const docker = pkg.__nxapi_docker ?? null;"
  );
  productSrc = productSrc.replace(
    /export const git = typeof embedded_git !== 'undefined' \? embedded_git : pkg\.__nxapi_git \?\? await \(async \(\) => \{[\s\S]*?\}\)\(\);/,
    "export const git = typeof embedded_git !== 'undefined' ? embedded_git : pkg.__nxapi_git ?? null;"
  );

  writeFileSync(productPath, productSrc, 'utf-8');
  console.log('patched product.js');

  // ── remote-config.js ───────────────────────────────────────────────
  const remoteConfigPath = path.join(__dirname, 'node_modules', 'nxapi', 'dist', 'common', 'remote-config.js');
  let remoteConfigSrc = readFileSync(remoteConfigPath, 'utf-8');

  remoteConfigSrc = remoteConfigSrc.replace(
    /\.\.\.\(embedded_default_remote_config \?\?[\s\S]*?\)\)\),/,
    "...(embedded_default_remote_config ?? {}),"
  );
  remoteConfigSrc = remoteConfigSrc.replace(
    /const debug_fixed_config = !dev \? null :[\s\S]*?\|\| null;/,
    "const debug_fixed_config = null;"
  );
  remoteConfigSrc = remoteConfigSrc.replace(
    /export const cache = debug_fixed_config \? null :[\s\S]*?await loadRemoteConfig\(\);/,
    "export const cache = null;"
  );

  writeFileSync(remoteConfigPath, remoteConfigSrc, 'utf-8');
  console.log('patched remote-config.js');
}

patchNxapiFiles();

mkdirSync(path.join(__dirname, 'dist'), { recursive: true });

await build({
  entryPoints: [path.join(__dirname, 'wrapper.js')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: path.join(__dirname, 'dist', 'bundle.cjs'),
  banner: { js: banner },
});

console.log('dist/bundle.cjs generated');
