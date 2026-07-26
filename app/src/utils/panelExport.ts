/**
 * パネルを JPEG 画像として保存する（#500）。
 *
 * 画面に出ているパネルをそのままラスタライズするので、テーマ色や凡例は表示と一致する。
 * 表示にしかない要素（操作ボタン・長い注釈）は `EXPORT_HIDE_CLASS` を付けて除外し、
 * 画像にしか無い要素（絞り込み条件のキャプション）は `.is-exporting` 中だけ表示する。
 *
 * JPEG は透過を持てないため、キャプチャ前に必ず不透明な背景色を敷く。
 */
import { toJpeg } from 'html-to-image'
import { invoke } from '@tauri-apps/api/core'

/** 画像に写したくない操作 UI に付けるクラス。 */
export const EXPORT_HIDE_CLASS = 'panel-export-hide'

/** キャプチャ中だけパネルのルートに付くクラス。CSS はこれを見てキャプションを出す。 */
const EXPORTING_CLASS = 'is-exporting'

/** Windows / macOS のどちらでも使えないファイル名文字を落とす。 */
function sanitizeFilenamePart(s: string): string {
  return s
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** `splabo-環境分析-武器散布図-2026-07-26.jpg` 形式のファイル名。 */
export function buildPanelImageFilename(screen: string, panel: string, now = new Date()): string {
  const date = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-')
  const parts = ['splabo', screen, panel, date].map(sanitizeFilenamePart).filter(Boolean)
  return `${parts.join('-')}.jpg`
}

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

/** レイアウト変更（キャプション表示）が反映されてから描画するために 2 フレーム待つ。 */
function nextFrames(): Promise<void> {
  return new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}

/**
 * パネルを JPEG にして保存ダイアログへ渡す。
 * 戻り値は保存先パス。キャンセルされたら null。
 */
export async function savePanelAsJpeg(node: HTMLElement, screen: string, panel: string): Promise<string | null> {
  node.classList.add(EXPORTING_CLASS)
  try {
    await nextFrames()
    const dataUrl = await toJpeg(node, {
      quality:         0.92,
      // 等倍だと軸ラベルがつぶれる。2 倍なら 420px 幅のカードでも十分読める。
      pixelRatio:      2,
      backgroundColor: cssVar('--surface', '#1b1f27'),
      // 既定では index.html が読む Google Fonts を毎回ダウンロードして埋め込もうとする。
      // パネル内は system-ui 系しか使っておらず、オフラインでは失敗するだけなので飛ばす。
      skipFonts:       true,
      filter: (el) => !(el instanceof Element) || !el.classList.contains(EXPORT_HIDE_CLASS),
    })
    const dataBase64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
    return await invoke<string | null>('save_panel_image', {
      filename: buildPanelImageFilename(screen, panel),
      dataBase64,
    })
  } finally {
    node.classList.remove(EXPORTING_CLASS)
  }
}
