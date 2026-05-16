#!/usr/bin/env node
/**
 * nxapi-wrapper — geartoon Tauri サイドカー
 *
 * 使い方 (CLI / sidecar):
 *   node wrapper.mjs setup <session_token> <data_dir>
 *   node wrapper.mjs fetch_gear <data_dir> <out_dir>
 *   node wrapper.mjs check_login <data_dir>
 *
 * 結果は stdout に 1行の JSON で出力する。
 * エラー時は {"ok": false, "error": "<message>"} を stdout に出力し、exit code 1 で終了。
 */

import { createWriteStream, existsSync, mkdirSync, writeFileSync } from 'fs';
import { pipeline } from 'stream/promises';
import path from 'path';

// ── nxapi 初期化 ────────────────────────────────────────────
import { init as initGlobals } from 'nxapi/dist/common/globals.js';
import { getBulletToken } from 'nxapi/dist/common/auth/splatnet3.js';
import { embedded_nxapi_auth_cli_client_id, pkg } from 'nxapi/dist/util/product.js';
import { initStorage } from 'nxapi/dist/util/storage.js';
import {
  NxapiClientAssertionProvider,
  setClientAssertionProvider,
} from 'nxapi/dist/util/nxapi-auth.js';
import { addUserAgent } from 'nxapi/dist/util/useragent.js';

initGlobals();
addUserAgent('geartoon-sidecar/1.0');

// nxapi-znca-api クライアント ID を設定（f-token 生成に必要）
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

// ── エントリポイント ────────────────────────────────────────
const [, , cmd, ...args] = process.argv;

try {
  switch (cmd) {
    case 'setup':
      await cmdSetup(args);
      break;
    case 'fetch_gear':
      await cmdFetchGear(args);
      break;
    case 'check_login':
      await cmdCheckLogin(args);
      break;
    default:
      respond({ ok: false, error: `不明なコマンド: ${cmd}` });
      process.exit(1);
  }
} catch (e) {
  respond({ ok: false, error: String(e?.message ?? e) });
  process.exit(1);
}

// ── コマンド実装 ────────────────────────────────────────────

/**
 * setup <session_token> <data_dir>
 * session_token を nxapi のストレージ形式で保存する。
 */
async function cmdSetup([sessionToken, dataDir]) {
  if (!sessionToken || !dataDir) {
    throw new Error('usage: setup <session_token> <data_dir>');
  }

  // session_token の JWT payload から sub (nsid) を取得
  const nsid = parseJwtSub(sessionToken);

  const storage = await initStorage(dataDir);
  await storage.setItem('SelectedUser', nsid);
  await storage.setItem('NintendoAccountToken.' + nsid, sessionToken);

  respond({ ok: true, nsid });
}

/**
 * fetch_gear <data_dir> <out_dir>
 * SplatNet3 からギアデータを取得し、画像DL + gear_db.json を生成する。
 * data_dir: nxapi ストレージのディレクトリ（認証情報を読み込む）
 * out_dir:  出力先（gear_db.json と images/ を書き出す）
 */
async function cmdFetchGear([dataDir, outDir]) {
  if (!dataDir || !outDir) {
    throw new Error('usage: fetch_gear <data_dir> <out_dir>');
  }

  // 1. 認証情報を読み込む
  const storage = await initStorage(dataDir);
  const nsid = await storage.getItem('SelectedUser');
  if (!nsid) throw new Error('ログインされていません。先に setup を実行してください。');

  const sessionToken = await storage.getItem('NintendoAccountToken.' + nsid);
  if (!sessionToken) throw new Error('session_token が見つかりません。');

  // 2. BulletToken を取得（キャッシュあれば再利用、なければ全認証フロー）
  process.stderr.write('bulletToken を取得中...\n');
  const { splatnet } = await getBulletToken(storage, sessionToken, undefined, true);

  // 3. 所持ギアデータを取得
  process.stderr.write('SplatNet3 からギアデータを取得中...\n');
  const equipment = await splatnet.getEquipment();

  // 4. 生データを保存
  const rawDir = path.join(outDir, 'data', 'splatnet3');
  mkdirSync(rawDir, { recursive: true });
  const rawPath = path.join(rawDir, 'splatnet3-equipment.json');
  writeFileSync(rawPath, JSON.stringify(equipment, null, 2), 'utf-8');
  process.stderr.write(`生データを保存: ${rawPath}\n`);

  // 5. 画像をダウンロード
  process.stderr.write('画像をダウンロード中...\n');
  const imgDir = path.join(outDir, 'images');
  await downloadGearImages(equipment, imgDir);

  // 6. gear_db.json を生成
  const dbPath = path.join(outDir, 'gear_db.json');
  buildGearDb(equipment, dbPath);
  process.stderr.write(`gear_db.json を生成: ${dbPath}\n`);

  respond({ ok: true, db_path: dbPath });
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

// ── ユーティリティ ─────────────────────────────────────────

/** stdout に 1行 JSON を出力する */
function respond(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

/** JWT の payload から sub フィールド（Nintendo Account ID）を取り出す */
function parseJwtSub(jwt) {
  const parts = jwt.split('.');
  if (parts.length < 2) throw new Error('session_token が JWT 形式ではありません');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
  if (!payload.sub) throw new Error('JWT payload に sub フィールドがありません');
  return payload.sub;
}

/** URL からクエリ文字列を除いたファイル名を取得する */
function filenameFromUrl(url) {
  return url.split('?')[0].split('/').pop();
}

/** URL の相対ローカルパスを生成する（imagesルート相対） */
function localImage(url, subdir) {
  return `images/${subdir}/${filenameFromUrl(url)}`;
}

/** 1つの URL を dest ファイルにダウンロードする（既存ならスキップ） */
async function downloadFile(url, dest) {
  if (existsSync(dest)) return false;
  mkdirSync(path.dirname(dest), { recursive: true });
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  const file = createWriteStream(dest);
  await pipeline(res.body, file);
  return true;
}

/** equipment JSON から全画像をダウンロードする */
async function downloadGearImages(equipment, imgDir) {
  const sections = {
    headGears: 'head',
    clothingGears: 'clothing',
    shoesGears: 'shoes',
  };

  let downloaded = 0;
  let skipped = 0;

  for (const [section, label] of Object.entries(sections)) {
    const nodes = equipment?.data?.[section]?.nodes ?? [];
    for (const node of nodes) {
      // ギア画像
      if (node.image?.url) {
        const dest = path.join(imgDir, 'gear', label, filenameFromUrl(node.image.url));
        if (await downloadFile(node.image.url, dest)) downloaded++;
        else skipped++;
      }
      // ブランド画像
      if (node.brand?.image?.url) {
        const dest = path.join(imgDir, 'brand', filenameFromUrl(node.brand.image.url));
        if (await downloadFile(node.brand.image.url, dest)) downloaded++;
        else skipped++;
      }
      // スキル画像（メイン）
      if (node.primaryGearPower?.image?.url) {
        const dest = path.join(imgDir, 'skill', filenameFromUrl(node.primaryGearPower.image.url));
        if (await downloadFile(node.primaryGearPower.image.url, dest)) downloaded++;
        else skipped++;
      }
      // スキル画像（サブ）
      for (const sub of node.additionalGearPowers ?? []) {
        if (sub.image?.url) {
          const dest = path.join(imgDir, 'skill', filenameFromUrl(sub.image.url));
          if (await downloadFile(sub.image.url, dest)) downloaded++;
          else skipped++;
        }
      }
    }
  }

  process.stderr.write(`画像: ${downloaded} DL, ${skipped} スキップ\n`);
}

/** equipment JSON から gear_db.json を生成して書き出す */
function buildGearDb(equipment, dbPath) {
  const sections = {
    headGears: { category: 'head', idField: 'headGearId' },
    clothingGears: { category: 'clothing', idField: 'clothingGearId' },
    shoesGears: { category: 'shoes', idField: 'shoesGearId' },
  };

  const db = {};
  for (const [section, { category, idField }] of Object.entries(sections)) {
    const nodes = equipment?.data?.[section]?.nodes ?? [];
    db[category] = nodes.map((node) => ({
      id: node[idField],
      name: node.name,
      rarity: node.rarity,
      brand: node.brand.name,
      brand_image: localImage(node.brand.image.url, 'brand'),
      image: localImage(node.image.url, `gear/${category}`),
      primary_skill: {
        id: node.primaryGearPower.gearPowerId,
        name: node.primaryGearPower.name,
        image: localImage(node.primaryGearPower.image.url, 'skill'),
      },
      additional_skills: node.additionalGearPowers.map((p) => ({
        id: p.gearPowerId,
        name: p.name,
        image: localImage(p.image.url, 'skill'),
      })),
      exp: node.stats.exp,
    }));
    process.stderr.write(`  ${category}: ${db[category].length} items\n`);
  }

  writeFileSync(dbPath, JSON.stringify(db, null, 2), 'utf-8');
}
