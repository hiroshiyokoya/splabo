#!/usr/bin/env node
/**
 * nxapi-wrapper — chartoon Tauri サイドカー
 *
 * 使い方 (CLI / sidecar):
 *   node wrapper.js setup <session_token> <data_dir>
 *   node wrapper.js get_bullet_token <data_dir>
 *   node wrapper.js check_login <data_dir>
 *   node wrapper.js weapon_records <data_dir>
 *
 * 結果は stdout に 1行の JSON で出力する。
 * エラー時は {"ok": false, "error": "<message>"} を stdout に出力し、exit code 1 で終了。
 */

import path from 'path';

// ── nxapi 内部モジュール（相対パスで直接インポート、exports 制限を回避）
import { init as initGlobals } from './node_modules/nxapi/dist/common/globals.js';
import { embedded_nxapi_auth_cli_client_id, pkg } from './node_modules/nxapi/dist/util/product.js';
import { initStorage } from './node_modules/nxapi/dist/util/storage.js';
import { NxapiClientAssertionProvider, setClientAssertionProvider } from './node_modules/nxapi/dist/util/nxapi-auth.js';
import { addUserAgent } from './node_modules/nxapi/dist/util/useragent.js';

// ── nxapi 初期化 ────────────────────────────────────────────
initGlobals();
addUserAgent('chartoon-sidecar/0.1.0');

// nxapi-znca-api クライアント ID を設定（f-token 生成に必要）
function setupClientAssertion() {
  if (embedded_nxapi_auth_cli_client_id) {
    setClientAssertionProvider(
      new NxapiClientAssertionProvider(
        embedded_nxapi_auth_cli_client_id,
        undefined,
        'ca:gf ca:er ca:dr ca:na',
      ),
    );
  } else if (pkg.__nxapi_auth?.cli?.client_id) {
    setClientAssertionProvider(
      new NxapiClientAssertionProvider(
        pkg.__nxapi_auth.cli.client_id,
        undefined,
        'ca:gf ca:er ca:dr ca:na',
      ),
    );
  } else if (process.env.NXAPI_AUTH_CLIENT_ID) {
    setClientAssertionProvider(
      new NxapiClientAssertionProvider(
        process.env.NXAPI_AUTH_CLIENT_ID,
        undefined,
        process.env.NXAPI_AUTH_SCOPE ?? 'ca:gf ca:er ca:dr',
      ),
    );
  } else {
    respond({ ok: false, error: 'nxapi クライアント ID が見つかりません' });
    process.exit(1);
  }
}

// ── エントリポイント ────────────────────────────────────────
const [, , cmd, ...args] = process.argv;

async function main() {
  setupClientAssertion();

  switch (cmd) {
    case 'setup':
      await cmdSetup(args);
      break;
    case 'get_bullet_token':
      await cmdGetBulletToken(args);
      break;
    case 'check_login':
      await cmdCheckLogin(args);
      break;
    case 'weapon_records':
      await cmdWeaponRecords(args);
      break;
    default:
      respond({ ok: false, error: `不明なコマンド: ${cmd ?? '(なし)'}` });
      process.exit(1);
  }
}

main().catch((e) => {
  respond({ ok: false, error: String(e?.message ?? e) });
  process.exit(1);
});

// ── コマンド実装 ────────────────────────────────────────────

/**
 * setup <session_token> <data_dir>
 * session_token を nxapi のストレージ形式で保存する。
 */
/**
 * 一時エラー（znca-api の 5xx / タイムアウト / ネットワーク断）に対して指数バックオフで再試行する。
 * 恒久エラー（未ログイン・4xx 等）は即座に投げる。nxapi の znca-api 呼び出しが断続的に
 * 500{"error":"timeout"} を返す事象への耐性（#272）。
 */
async function withRetry(fn, { attempts = 3, baseDelayMs = 800, label = 'znca-api' } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = String((e && e.message) || e);
      const transient = /Non-200 status code:\s*5\d\d|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|network/i.test(msg);
      if (!transient || i === attempts) throw e;
      const wait = baseDelayMs * i;
      process.stderr.write(`[${label}] 一時エラー (${i}/${attempts}): ${msg} — ${wait}ms 後に再試行\n`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

async function cmdSetup([sessionToken, dataDir]) {
  if (!sessionToken || !dataDir) {
    throw new Error('usage: setup <session_token> <data_dir>');
  }

  const nsid = parseJwtSub(sessionToken);

  const storage = await initStorage(dataDir);
  await storage.setItem('SelectedUser', nsid);
  await storage.setItem('NintendoAccountToken.' + nsid, sessionToken);

  respond({ ok: true, nsid });
}

/**
 * get_bullet_token <data_dir>
 * SplatNet3 の bulletToken を取得して返す。
 */
async function cmdGetBulletToken([dataDir]) {
  if (!dataDir) throw new Error('usage: get_bullet_token <data_dir>');

  const storage = await initStorage(dataDir);
  const nsid = await storage.getItem('SelectedUser');
  if (!nsid) throw new Error('未ログインです（先に setup を実行してください）');

  const sessionToken = await storage.getItem('NintendoAccountToken.' + nsid);
  if (!sessionToken) throw new Error('session_token が見つかりません');

  process.stderr.write('bulletToken を取得中...\n');
  // splatnet3.js は coral の top-level await を含むため、ここで動的インポート
  const { getBulletToken } = await import('./node_modules/nxapi/dist/common/auth/splatnet3.js');
  const { data } = await withRetry(() => getBulletToken(storage, sessionToken, undefined, true));

  respond({
    ok: true,
    bullet_token: data.bullet_token.bulletToken,
    country: data.country,
    language: data.bullet_token.lang,
  });
}

/**
 * check_login <data_dir>
 * ストレージにログイン情報があるか確認する。
 */
async function cmdCheckLogin([dataDir]) {
  if (!dataDir) throw new Error('usage: check_login <data_dir>');

  const storage = await initStorage(dataDir);
  const nsid = await storage.getItem('SelectedUser');
  if (!nsid) {
    respond({ ok: true, logged_in: false });
    return;
  }
  const token = await storage.getItem('NintendoAccountToken.' + nsid);
  respond({ ok: true, logged_in: !!token, nsid });
}

/**
 * weapon_records <data_dir>
 * SplatNet 3 の WeaponRecordQuery を実行し、レスポンス全体を返す。
 *
 * レスポンスの形 (data.weaponRecords.nodes[]):
 *   { name, image2d{url}, image3d{url}, weaponId, stats{level,paint,win,vibes,...},
 *     subWeapon{name,image{url}}, specialWeapon{name,image{url}}, weaponCategory{...} }
 *
 * 武器熟練度 (stats.level)・通算勝利数 (stats.win)・総塗りポイント (stats.paint) はここで取れる。
 * ブキチャレパワー / ビッグラン熟練度は WeaponRecordQuery には含まれない（別クエリの領域）。
 */
async function cmdWeaponRecords([dataDir]) {
  if (!dataDir) throw new Error('usage: weapon_records <data_dir>');

  const storage = await initStorage(dataDir);
  const nsid = await storage.getItem('SelectedUser');
  if (!nsid) throw new Error('未ログインです（先に setup を実行してください）');

  const sessionToken = await storage.getItem('NintendoAccountToken.' + nsid);
  if (!sessionToken) throw new Error('session_token が見つかりません');

  process.stderr.write('WeaponRecordQuery を実行中...\n');
  const { getBulletToken } = await import('./node_modules/nxapi/dist/common/auth/splatnet3.js');
  // 第 4 引数 allow_fetch_token=true により bullet_token が無ければ自動取得する。
  const { splatnet } = await withRetry(() => getBulletToken(storage, sessionToken, undefined, true));

  const result = await splatnet.getWeaponRecords();
  // result は { data, ... }。data.weaponRecords.nodes が本体。
  respond({ ok: true, data: result.data });
}

// ── ユーティリティ ─────────────────────────────────────────

function respond(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function parseJwtSub(jwt) {
  const parts = jwt.split('.');
  if (parts.length < 2) throw new Error('session_token が JWT 形式ではありません');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
  if (!payload.sub) throw new Error('JWT payload に sub フィールドがありません');
  return payload.sub;
}
