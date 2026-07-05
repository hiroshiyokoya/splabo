#!/usr/bin/env node
/**
 * nxapi-wrapper — geartoon Tauri サイドカー
 *
 * 使い方 (CLI / sidecar):
 *   node wrapper.js setup <session_token> <data_dir>
 *   node wrapper.js fetch_gear <data_dir> <out_dir>
 *   node wrapper.js check_login <data_dir>
 *
 * 結果は stdout に 1行の JSON で出力する。
 * エラー時は {"ok": false, "error": "<message>"} を stdout に出力し、exit code 1 で終了。
 *
 * ## ビルドについて
 * esbuild で CJS バンドルに変換してから @yao-pkg/pkg でコンパイルする。
 * 静的な相対パスインポート（./node_modules/nxapi/dist/...）で nxapi の
 * exports 制限を回避する（top-level await を使わないため esbuild CJS 変換可能）。
 */

import { createWriteStream, existsSync, mkdirSync, writeFileSync } from 'fs';
import { pipeline } from 'stream/promises';
import path from 'path';

// ── nxapi 内部モジュール（相対パスで直接インポート、exports 制限を回避）
// getBulletToken は fetch_gear でのみ使用するため動的インポートにする
// （splatnet3.js → coral.js の top-level await を起動時に走らせないため）
import { init as initGlobals } from './node_modules/nxapi/dist/common/globals.js';
import { embedded_nxapi_auth_cli_client_id, pkg } from './node_modules/nxapi/dist/util/product.js';
import { initStorage } from './node_modules/nxapi/dist/util/storage.js';
import { NxapiClientAssertionProvider, setClientAssertionProvider } from './node_modules/nxapi/dist/util/nxapi-auth.js';
import { addUserAgent } from './node_modules/nxapi/dist/util/useragent.js';

// ── nxapi 初期化 ────────────────────────────────────────────
initGlobals();
addUserAgent('geartoon-sidecar/1.0');

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
    case 'fetch_gear':
      await cmdFetchGear(args);
      break;
    case 'check_login':
      await cmdCheckLogin(args);
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
 * fetch_gear <data_dir> <out_dir>
 * SplatNet3 からギアデータを取得し、画像DL + gear_db.json を生成する。
 */
async function cmdFetchGear([dataDir, outDir]) {
  if (!dataDir || !outDir) {
    throw new Error('usage: fetch_gear <data_dir> <out_dir>');
  }

  const storage = await initStorage(dataDir);
  const nsid = await storage.getItem('SelectedUser');
  if (!nsid) throw new Error('ログインされていません。先に setup を実行してください。');

  const sessionToken = await storage.getItem('NintendoAccountToken.' + nsid);
  if (!sessionToken) throw new Error('session_token が見つかりません。');

  process.stderr.write('bulletToken を取得中...\n');
  // splatnet3.js は coral の top-level await を含むため、ここで動的インポート
  const { getBulletToken } = await import('./node_modules/nxapi/dist/common/auth/splatnet3.js');
  const { splatnet } = await getBulletToken(storage, sessionToken, undefined, true);

  process.stderr.write('SplatNet3 からギアデータを取得中...\n');
  const equipment = await splatnet.getEquipment();

  const rawDir = path.join(outDir, 'data', 'splatnet3');
  mkdirSync(rawDir, { recursive: true });
  const rawPath = path.join(rawDir, 'splatnet3-equipment.json');
  writeFileSync(rawPath, JSON.stringify(equipment, null, 2), 'utf-8');
  process.stderr.write(`生データを保存: ${rawPath}\n`);

  process.stderr.write('画像をダウンロード中...\n');
  const imgDir = path.join(outDir, 'images');
  await downloadGearImages(equipment, imgDir);

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

function filenameFromUrl(url) {
  return url.split('?')[0].split('/').pop();
}

function localImage(url, subdir) {
  return `images/${subdir}/${filenameFromUrl(url)}`;
}

async function downloadFile(url, dest) {
  if (existsSync(dest)) return false;
  mkdirSync(path.dirname(dest), { recursive: true });
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  const file = createWriteStream(dest);
  await pipeline(res.body, file);
  return true;
}

async function downloadGearImages(equipment, imgDir) {
  const sections = {
    headGears: 'head',
    clothingGears: 'clothing',
    shoesGears: 'shoes',
  };

  let downloaded = 0;
  let skipped = 0;
  const seenSkillUrls = new Set();

  for (const [section, label] of Object.entries(sections)) {
    const nodes = equipment?.data?.[section]?.nodes ?? [];
    for (const node of nodes) {
      if (node.image?.url) {
        const dest = path.join(imgDir, 'gear', label, filenameFromUrl(node.image.url));
        (await downloadFile(node.image.url, dest)) ? downloaded++ : skipped++;
      }
      if (node.brand?.image?.url) {
        const dest = path.join(imgDir, 'brand', filenameFromUrl(node.brand.image.url));
        (await downloadFile(node.brand.image.url, dest)) ? downloaded++ : skipped++;
      }
      if (node.primaryGearPower?.image?.url && !seenSkillUrls.has(node.primaryGearPower.image.url)) {
        seenSkillUrls.add(node.primaryGearPower.image.url);
        const dest = path.join(imgDir, 'skill', filenameFromUrl(node.primaryGearPower.image.url));
        (await downloadFile(node.primaryGearPower.image.url, dest)) ? downloaded++ : skipped++;
      }
      for (const sub of node.additionalGearPowers ?? []) {
        if (sub.image?.url && !seenSkillUrls.has(sub.image.url)) {
          seenSkillUrls.add(sub.image.url);
          const dest = path.join(imgDir, 'skill', filenameFromUrl(sub.image.url));
          (await downloadFile(sub.image.url, dest)) ? downloaded++ : skipped++;
        }
      }
    }
  }

  process.stderr.write(`画像: ${downloaded} DL, ${skipped} スキップ\n`);
}

function buildGearDb(equipment, dbPath) {
  const sections = {
    headGears: { category: 'head', idField: 'headGearId' },
    clothingGears: { category: 'clothing', idField: 'clothingGearId' },
    shoesGears: { category: 'shoes', idField: 'shoesGearId' },
  };

  const db = {};
  // スキル辞書（id → { id, name, image }）。アキ枠を含む全スキルを収集する
  const skillsMap = {};

  for (const [section, { category, idField }] of Object.entries(sections)) {
    const nodes = equipment?.data?.[section]?.nodes ?? [];
    db[category] = nodes.map((node) => {
      const primarySkill = {
        id: node.primaryGearPower.gearPowerId,
        name: node.primaryGearPower.name,
        image: localImage(node.primaryGearPower.image.url, 'skill'),
      };
      const additionalSkills = node.additionalGearPowers.map((p) => ({
        id: p.gearPowerId,
        name: p.name,
        image: localImage(p.image.url, 'skill'),
      }));

      // スキル辞書に登録（重複は上書きで問題なし）
      skillsMap[primarySkill.id] = primarySkill;
      for (const s of additionalSkills) skillsMap[s.id] = s;

      return {
        id: node[idField],
        name: node.name,
        rarity: node.rarity,
        brand: node.brand.name,
        brand_image: localImage(node.brand.image.url, 'brand'),
        image: localImage(node.image.url, `gear/${category}`),
        primary_skill: primarySkill,
        additional_skills: additionalSkills,
        exp: node.stats.exp,
      };
    });
    process.stderr.write(`  ${category}: ${db[category].length} items\n`);
  }

  db.skills = skillsMap;
  process.stderr.write(`  skills: ${Object.keys(skillsMap).length} entries\n`);

  writeFileSync(dbPath, JSON.stringify(db, null, 2), 'utf-8');
}
