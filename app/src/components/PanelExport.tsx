/**
 * パネルを画像として保存する導線（#500）。
 *
 * - `PanelExportButton` … パネルのヘッダに置く保存ボタン。押すと保存ダイアログが出る。
 * - `PanelExportCaption` … 画像にだけ入る「タイトル下の絞り込み条件」ブロック。
 *   画面では非表示（`.is-exporting` のときだけ表示）なので、通常のレイアウトは変わらない。
 */
import { useState, type RefObject } from 'react'
import { EXPORT_HIDE_CLASS, savePanelAsJpeg } from '../utils/panelExport'

interface ButtonProps {
  /** キャプチャ対象（パネルの外枠）。 */
  targetRef: RefObject<HTMLElement | null>
  /** ファイル名に入る画面名。例: 'ダッシュボード' */
  screen: string
  /** ファイル名に入るパネル名。例: '武器別 バトル数 & 勝率' */
  panel: string
}

export function PanelExportButton({ targetRef, screen, panel }: ButtonProps) {
  const [busy, setBusy] = useState(false)

  async function handleClick() {
    const node = targetRef.current
    if (!node || busy) return
    setBusy(true)
    try {
      await savePanelAsJpeg(node, screen, panel)
    } catch (e) {
      console.error('[PanelExport] 画像の保存に失敗:', e)
      window.alert(`画像の保存に失敗しました。\n${String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      className={`panel-export-btn ${EXPORT_HIDE_CLASS}`}
      onClick={handleClick}
      disabled={busy}
      aria-label="画像として保存"
      title="このパネルを JPEG 画像として保存"
    >
      {busy ? <span className="panel-export-btn__spinner" /> : <DownloadIcon />}
    </button>
  )
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
      <path
        d="M8 1.5v7.6M4.8 6.3 8 9.5l3.2-3.2M2.5 11.5v1.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-1.5"
        fill="none" stroke="currentColor" strokeWidth="1.4"
        strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  )
}

/** タイトル直下に入る絞り込み条件。`describeFilters` などで作った 1 行を渡す。 */
export function PanelExportCaption({ conditions }: { conditions: string }) {
  return (
    <div className="panel-export-caption" aria-hidden="true">{conditions}</div>
  )
}

/** パネル末尾に入る短い注釈。パネル上の長文注釈をそのまま渡さないこと。 */
export function PanelExportNote({ note }: { note: string }) {
  return (
    <div className="panel-export-note" aria-hidden="true">{note}</div>
  )
}
