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
 * パッチが「当たったこと」を検証するヘルパー（#399）。
 *
 * 正規表現パッチは nxapi の dist が変わると**静かに素通りする**。素通りしたまま
 * バンドルすると、ビルドは成功するのに実行時に壊れる（top-level await が残る、
 * エラーの構造が失われる等）ので、置換後に必ずマーカーの有無を確認して落とす。
 *
 * `node_modules` は in-place で書き換わるため、2 回目以降のビルドでは正規表現が
 * 当たらない（＝すでに当たっている）。したがって「置換が起きたか」ではなく
 * 「最終的に期待どおりの形になっているか」で判定する。
 */
function assertPatched(src, { file, marker, min = 1, forbidden }) {
  const found = typeof marker === 'string'
    ? src.split(marker).length - 1
    : (src.match(marker) ?? []).length;
  if (found < min) {
    throw new Error(
      `[patch] ${file}: パッチが当たっていません（marker=${marker} 期待 ${min} 箇所以上 / 実際 ${found} 箇所）。` +
      ' nxapi のバージョンアップで dist の形が変わった可能性があります。'
    );
  }
  if (forbidden && forbidden.test(src)) {
    throw new Error(`[patch] ${file}: 旧パッチの痕跡が残っています（forbidden=${forbidden}）。`);
  }
  return found;
}

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

  assertPatched(productSrc, { file: 'product.js', marker: "typeof __dirname !== 'undefined' ? __dirname : process.cwd();" });
  assertPatched(productSrc, { file: 'product.js', marker: "__NXAPI_BUNDLE_PKG__ not set" });
  assertPatched(productSrc, { file: 'product.js', marker: 'export const docker = pkg.__nxapi_docker ?? null;' });
  assertPatched(productSrc, { file: 'product.js', marker: 'pkg.__nxapi_git ?? null;' });

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

  assertPatched(remoteConfigSrc, { file: 'remote-config.js', marker: '...(embedded_default_remote_config ?? {}),' });
  assertPatched(remoteConfigSrc, { file: 'remote-config.js', marker: 'const debug_fixed_config = null;' });
  assertPatched(remoteConfigSrc, { file: 'remote-config.js', marker: 'export const cache = null;' });

  writeFileSync(remoteConfigPath, remoteConfigSrc, 'utf-8');
  console.log('patched remote-config.js');

  // ── api/f.js (znca-api エラーに status を残す) ────────────────────
  //
  // 以前はここで `new Error('... body=' + text)` に差し替えていたが、それだと
  //   * nxapi の `ErrorResponse` が持つ `response`（＝HTTP ステータス）と `data`（＝パース済み body）が消える
  //   * その直後の `err.data?.error === 'invalid_token' / 'invalid_grant'` 判定が
  //     常に false になり、nxapi 側の自動リトライ・トークン再取得が死ぬ
  // という二重の害があった（#399）。ステータスと body は文字列に埋めるのではなく
  // **ErrorResponse のまま**残し、wrapper.js が構造として読み出す。
  // message には運用ログ用に status だけ足す。
  const fApiPath = path.join(__dirname, 'node_modules', 'nxapi', 'dist', 'api', 'f.js');
  let fApiSrc = readFileSync(fApiPath, 'utf-8');

  const ZNCA_ERR =
    "const err = await ErrorResponse.fromResponse(response, '[znca-api] Non-200 status code: ' + response.status);";

  // (a) nxapi 素の形
  fApiSrc = fApiSrc.replace(
    /const err = await ErrorResponse\.fromResponse\(response, '\[znca-api\] Non-200 status code'\);/g,
    ZNCA_ERR
  );
  // (b) 旧パッチ適用済みの形（すでに書き換わっているローカル node_modules 用）
  fApiSrc = fApiSrc.replace(
    /const _body_dbg = await response\.clone\(\)\.text\(\)\.catch\(\(\) => '<no body>'\);\s*\n\s*const err = new Error\('\[znca-api\] Non-200 status code: ' \+ response\.status \+ ' body=' \+ _body_dbg\);/g,
    ZNCA_ERR
  );

  assertPatched(fApiSrc, {
    file: 'f.js',
    marker: ZNCA_ERR,
    min: ZNCA_ERROR_SITES,
    // 旧パッチ（構造を捨てる plain Error）が残っていたら失敗させる
    forbidden: /new Error\('\[znca-api\] Non-200 status code/,
  });

  writeFileSync(fApiPath, fApiSrc, 'utf-8');
  console.log(`patched f.js (znca-api error: ErrorResponse を維持 / ${ZNCA_ERROR_SITES} 箇所)`);
}

/** f.js 内で `[znca-api] Non-200 status code` を投げる箇所の数（nxapi 1.6.1-next.254 時点）。 */
const ZNCA_ERROR_SITES = 4;

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

// ── 生成物の検証（#399）────────────────────────────────────────────
// node_modules へのパッチが当たっていても、バンドルに載っていなければ意味がない。
// **最終成果物**を直接 grep して、期待した形だけが入っていることを確かめる。
// esbuild は文字列リテラルの引用符を " に正規化するので、両方の形を許容する。
{
  const bundlePath = path.join(__dirname, 'dist', 'bundle.cjs');
  const bundle = readFileSync(bundlePath, 'utf-8');

  const kept = (bundle.match(
    /ErrorResponse\.fromResponse\(response, ["']\[znca-api\] Non-200 status code: ["'] \+ response\.status\)/g
  ) ?? []).length;
  if (kept < ZNCA_ERROR_SITES) {
    throw new Error(
      `[verify] dist/bundle.cjs: znca-api エラーの構造化パッチが ${kept}/${ZNCA_ERROR_SITES} 箇所しか載っていません。`
    );
  }
  if (/new Error\(["']\[znca-api\] Non-200 status code/.test(bundle)) {
    throw new Error('[verify] dist/bundle.cjs: 構造を捨てる旧 znca-api エラーが残っています。');
  }
  if (!bundle.includes('upstream_error')) {
    throw new Error('[verify] dist/bundle.cjs: wrapper.js の構造化失敗レスポンス（upstream_error）が載っていません。');
  }
  console.log(`verified bundle: znca-api ErrorResponse ${kept} 箇所 / upstream_error 出力あり`);
}

console.log('dist/bundle.cjs generated');
