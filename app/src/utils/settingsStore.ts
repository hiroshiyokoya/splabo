/**
 * settingsStore — chartoon シェル設定の localStorage キー定義と、
 * tauri-plugin-store（ファイル `settings.json`）への「ミラー」ロジック。
 *
 * ## 背景（splabo v0.8 統合・#241 B2）
 *
 * chartoon の設定（AI/stat.ink API キー・スケジューラ設定など）は WebView2 の
 * localStorage に置かれるが、localStorage はアプリ識別子（`com.chartoon.app`）配下の
 * EBWebView プロファイルに紐づくため、識別子変更（v0.8 D 段階で `com.splabo.app` へ）で
 * **原理的に失われる**。ファイルコピーでも移行できない。
 *
 * これを防ぐため、設定を保存するたびに tauri-plugin-store の **`settings.json`** へも
 * ミラー保存する（`auth.json` は auth.rs が legacy 認証 store として使用中なので使わない）。
 * store ファイルは `app_data_dir`（識別子配下）に置かれるので、識別子変更後は
 * migration（#242 C）が `settings.json` を新識別子配下へコピーし、起動時取り込みで
 * localStorage へ書き戻すことで設定が復元される。
 *
 * ## キー命名
 *
 * chartoon シェルの localStorage キーは `chartoon:*` → `splabo:shell*` へ移行。
 * `shell` プレフィックスは、gear 側が既に使う `splabo:themeId` 等との衝突を避けるため
 * （chartoon テーマ ID = `dark`/`solarized-*`、gear テーマ ID = `purple` 等）。
 *
 * 読み出しは新キー優先・旧 `chartoon:*` フォールバック（後方互換）。書き込みは常に新キー。
 */

import { load, type Store } from '@tauri-apps/plugin-store'

// ── localStorage キー（新 splabo:shell* / 旧 chartoon:*） ──────────────

export const SETTINGS_KEY          = 'splabo:shellSettings'
export const LAST_FETCHED_KEY      = 'splabo:shellLastFetchedAt'
export const LAST_WEAPONS_FETCH_KEY = 'splabo:shellLastWeaponsFetchAt'
export const THEME_KEY             = 'splabo:shellThemeId'
export const CUSTOM_CHARTS_KEY     = 'splabo:shellCustomCharts'
/** タブ内ビューの選択状態（#296）。旧 chartoon 時代には無いので OLD キーは持たない。 */
export const VIEWS_KEY             = 'splabo:shellViews'

const SETTINGS_KEY_OLD           = 'chartoon:settings'
const LAST_FETCHED_KEY_OLD       = 'chartoon:lastFetchedAt'
const LAST_WEAPONS_FETCH_KEY_OLD = 'chartoon:lastWeaponsFetchAt'
const THEME_KEY_OLD              = 'chartoon:themeId'
const CUSTOM_CHARTS_KEY_OLD      = 'chartoon:customCharts'

/** 旧 chartoon:* キーへのマップ（新キー → 旧キー）。フォールバック読み出し・取り込みに使う。 */
const OLD_KEY: Record<string, string> = {
  [SETTINGS_KEY]:           SETTINGS_KEY_OLD,
  [LAST_FETCHED_KEY]:       LAST_FETCHED_KEY_OLD,
  [LAST_WEAPONS_FETCH_KEY]: LAST_WEAPONS_FETCH_KEY_OLD,
  [THEME_KEY]:              THEME_KEY_OLD,
  [CUSTOM_CHARTS_KEY]:      CUSTOM_CHARTS_KEY_OLD,
}

/**
 * ミラー対象のキー一覧。chartoon シェル設定に加え、gear 側設定
 * （`splabo:densityId` 等）も含める。gear キーは軽量で、識別子変更後の
 * 再設定ゼロにできるため一緒にミラーしておく（実装メモ #241 の推奨）。
 * gear キーには旧 `chartoon:*` フォールバックは無い（別系統なので OLD_KEY 対象外）。
 *
 * テーマは #344 でシェル（THEME_KEY）に一本化したため、gear 側の
 * `splabo:themeId` はミラーしない（ギアはシェルのテーマに追従する）。
 */
const MIRROR_KEYS: readonly string[] = [
  SETTINGS_KEY,
  LAST_FETCHED_KEY,
  LAST_WEAPONS_FETCH_KEY,
  THEME_KEY,
  CUSTOM_CHARTS_KEY,
  VIEWS_KEY,
  // gear 側設定（gear/utils/appSettings.ts と同名。ここでは値をそのままミラーするだけ）
  'splabo:densityId',
  'splabo:comboLimit',
  'splabo:nearLimit',
]

// ── localStorage 読み書き（新キー優先・旧キーフォールバック） ─────────

/** 新キー優先、無ければ旧 `chartoon:*` を読む（後方互換）。 */
export function lsGet(newKey: string): string | null {
  const v = localStorage.getItem(newKey)
  if (v !== null) return v
  const old = OLD_KEY[newKey]
  return old ? localStorage.getItem(old) : null
}

/** 常に新キーへ書く。 */
export function lsSet(newKey: string, value: string): void {
  localStorage.setItem(newKey, value)
}

// ── store ミラー（settings.json） ─────────────────────────────────────

const STORE_FILE = 'settings.json'
/** store に置くミラー時刻（epoch ms）のキー。取り込み時の新旧判定に使う。 */
const MIRRORED_AT_KEY = '_mirroredAt'
/** localStorage 側のミラー時刻。取り込み時に store 側と比較する。 */
const LS_MIRRORED_AT_KEY = 'splabo:shellMirroredAt'

let storePromise: Promise<Store> | null = null

/** store をロード（autoSave 無効＝明示 save）。失敗時は例外を投げる。 */
function getStore(): Promise<Store> {
  if (!storePromise) {
    storePromise = load(STORE_FILE, { defaults: {}, autoSave: false })
  }
  return storePromise
}

/**
 * 現在の localStorage の設定群を `settings.json` へミラー保存する。
 * 設定保存のたびに呼ぶ。tauri 非搭載環境（ブラウザ dev 等）や store 失敗時は
 * localStorage 保存を妨げないようサイレントに握りつぶす。
 */
export async function mirrorToStore(): Promise<void> {
  try {
    const store = await getStore()
    const now = Date.now()
    for (const key of MIRROR_KEYS) {
      const v = localStorage.getItem(key)
      if (v === null) {
        // localStorage 未設定のキーは store からも消す（削除も同期する）
        await store.delete(key)
      } else {
        await store.set(key, v)
      }
    }
    await store.set(MIRRORED_AT_KEY, now)
    await store.save()
    localStorage.setItem(LS_MIRRORED_AT_KEY, String(now))
  } catch (e) {
    // tauri 非搭載 / 権限未付与などでは無視（localStorage が主）
    console.warn('[settingsStore] mirrorToStore 失敗（無視）:', e)
  }
}

/**
 * 起動時に store が localStorage より新しければ、store の値を localStorage へ書き戻す。
 * 識別子変更（D）後は localStorage が空になるため、migration でコピーされた
 * `settings.json` からこの経路で設定が復元される。
 *
 * 判定: store の `_mirroredAt` > localStorage の `splabo:shellMirroredAt` のとき取り込む。
 * localStorage 側の時刻が無い（＝新プロファイル or 初回）場合も store があれば取り込む。
 *
 * @returns 取り込みを行ったら true。
 */
export async function importFromStoreIfNewer(): Promise<boolean> {
  try {
    const store = await getStore()
    const storeAt = await store.get<number>(MIRRORED_AT_KEY)
    if (typeof storeAt !== 'number') return false // ミラー未生成

    const lsAtRaw = localStorage.getItem(LS_MIRRORED_AT_KEY)
    const lsAt = lsAtRaw === null ? -1 : Number(lsAtRaw)
    if (Number.isFinite(lsAt) && lsAt >= storeAt) return false // localStorage の方が新しい／同時

    for (const key of MIRROR_KEYS) {
      const v = await store.get<string>(key)
      if (typeof v === 'string') {
        localStorage.setItem(key, v)
      }
    }
    localStorage.setItem(LS_MIRRORED_AT_KEY, String(storeAt))
    return true
  } catch (e) {
    console.warn('[settingsStore] importFromStoreIfNewer 失敗（無視）:', e)
    return false
  }
}
