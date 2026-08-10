/**
 * nxapi-wrapper ビルドスクリプト
 *
 * esbuild で bundle.cjs を生成する。
 * nxapi の product.js / remote-config.js がビルド時に globalThis 経由で
 * package.json / remote-config.json を参照するため、バナーで事前に注入する。
 */

import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'fs';
import { mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 1. nxapi の遠隔設定を**ビルド時に取得**して同梱する（#618）
//
// 🔴 実行時の取得はバンドルの都合で無効化してある（下の remote-config.js パッチ）。
// そのため同梱した値が**そのまま固定**になる。
//
// この設定には NSO アプリの版（`coral.znca_version`）が入っていて、
// 任天堂がアプリを更新すると古い版は znca-api に拒否される。
// nxapi は本来これを実行時に読んで**新しい nxapi を出さずに追従**する仕組みだが、
// 無効化しているぶんをビルド時取得で埋める。
//
// 実際、手で維持していたスナップショットが `znca_version: 3.4.0` のまま古くなり、
// 認証が数時間 `500 unknown_error` で失敗し続けた。**手で維持する限り必ず古くなる。**
//
// 取得できないときは同梱値へフォールバックする（ネットワークが無い環境でも
// ビルドは通す）。どちらを使ったかは必ずログに出す。黙って古い値を使うと、
// 今回と同じ壊れ方を静かに再現する。
const CONFIG_URL = 'https://fancy.org.uk/api/nxapi/config';
const remoteConfigSrc = path.join(__dirname, '..', 'nxapi-remote-config.json');
const remoteConfigDst = path.join(__dirname, 'node_modules', 'nxapi', 'resources', 'common', 'remote-config.json');

async function fetchRemoteConfig() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(CONFIG_URL, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const json = await res.json();
    // 最低限の妥当性を見る。空や壊れた応答で同梱値を上書きしない。
    if (!json || typeof json !== 'object' || !json.coral_auth) {
      throw new Error('応答の形が想定と違う');
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

let remoteConfig;
try {
  remoteConfig = await fetchRemoteConfig();
  // 取得できたら同梱ファイルも更新する（差分が git に出るので、変化に気付ける）。
  writeFileSync(remoteConfigSrc, JSON.stringify(remoteConfig, null, 2) + '\n', 'utf-8');
  console.log(`remote-config: 取得しました（${CONFIG_URL}）`);
  console.log(`  coral = ${JSON.stringify(remoteConfig.coral)}`);
  console.log(`  splatnet3 app_ver = ${remoteConfig.coral_gws_splatnet3?.app_ver}`);
} catch (e) {
  remoteConfig = JSON.parse(readFileSync(remoteConfigSrc, 'utf-8'));
  console.warn(`remote-config: 取得に失敗したので同梱値を使います（${e.message}）`);
  console.warn('  🔴 NSO アプリの版が古いと認証が通らなくなります。ネットワークを確認してください。');
}
writeFileSync(remoteConfigDst, JSON.stringify(remoteConfig), 'utf-8');
console.log('patched remote-config.json');

// 2. nxapi の package.json を読み込む
const nxapiPkg = JSON.parse(readFileSync(
  path.join(__dirname, 'node_modules', 'nxapi', 'package.json'), 'utf-8'));

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
  // #402: サイドカーのネットワーク操作にタイムアウト（withTimeout / NETWORK_TIMEOUT_MS）が
  // 載っていること。載っていないと「接続はできるが応答なし」でサイドカーが無限ハングする。
  if (!bundle.includes('NETWORK_TIMEOUT_MS') || !/function withTimeout\b/.test(bundle)) {
    throw new Error('[verify] dist/bundle.cjs: ネットワークタイムアウト（withTimeout / NETWORK_TIMEOUT_MS）が載っていません（#402）。');
  }
  console.log(`verified bundle: znca-api ErrorResponse ${kept} 箇所 / upstream_error 出力あり / network timeout あり`);
}

console.log('dist/bundle.cjs generated');
