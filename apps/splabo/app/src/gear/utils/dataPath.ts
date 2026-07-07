/**
 * データファイルのパスを解決するユーティリティ。
 *
 * - ブラウザ dev モード: /data/<rel> を返す（vite ミドルウェアが配信）
 * - Tauri モード: asset:// URL を返す（initTauriDataPath で初期化後）
 *
 * useGearDB がデータロード時に initTauriDataPath を呼ぶため、
 * データが表示される時点では必ず初期化済み。
 */

type ConvertFn = (absolutePath: string) => string

let tauriBase: string | null = null
let convertFn: ConvertFn | null = null

/** Tauri モード用に初期化（useGearDB から呼ぶ） */
export function initTauriDataPath(base: string, convert: ConvertFn): void {
  tauriBase = base
  convertFn = convert
}

/**
 * tools/data/ からの相対パスを受け取り、環境に合った URL を返す。
 * @param rel  例: "images/gear_xxx.png"
 */
export function dataPath(rel: string): string {
  if (tauriBase && convertFn) {
    return convertFn(`${tauriBase}/${rel}`)
  }
  return `/data/${rel}`
}
