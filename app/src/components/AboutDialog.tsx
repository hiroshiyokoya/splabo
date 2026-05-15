import { useEffect, useState } from 'react'

// TauriアプリではgetVersion()、ブラウザ開発時はpackage.jsonのversionにフォールバック
async function resolveVersion(): Promise<string> {
  try {
    const { getVersion } = await import('@tauri-apps/api/app')
    return await getVersion()
  } catch {
    return '0.1.0'
  }
}

interface Props {
  open: boolean
  onClose: () => void
}

export function AboutDialog({ open, onClose }: Props) {
  const [version, setVersion] = useState<string>('')

  useEffect(() => {
    resolveVersion().then(setVersion)
  }, [])

  // Escキーで閉じる
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  return (
    <>
      {/* Overlay */}
      <div
        className={`about-overlay${open ? ' about-overlay--visible' : ''}`}
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Dialog */}
      <div
        className={`about-dialog${open ? ' about-dialog--open' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="geartoon について"
      >
        {/* Close button */}
        <button className="about-close" onClick={onClose} aria-label="閉じる">✕</button>

        {/* Logo + App name */}
        <div className="about-header">
          <img src="/favicon.png" alt="geartoon logo" className="about-logo" />
          <div className="about-title-group">
            <h2 className="about-appname">geartoon</h2>
            {version && <span className="about-version">v{version}</span>}
          </div>
        </div>

        <p className="about-subtitle">Splatoon 3 Gear Wardrobe</p>

        <div className="about-divider" />

        {/* Author + Repo */}
        <div className="about-meta">
          <div className="about-meta__row">
            <span className="about-meta__label">Author</span>
            <a
              className="about-meta__value about-link"
              href="https://github.com/hiroshiyokoya"
              target="_blank"
              rel="noreferrer"
            >
              hiroshiyokoya
            </a>
          </div>
          <div className="about-meta__row">
            <span className="about-meta__label">Repository</span>
            <a
              className="about-meta__value about-link"
              href="https://github.com/hiroshiyokoya/geartoon"
              target="_blank"
              rel="noreferrer"
            >
              github.com/hiroshiyokoya/geartoon
            </a>
          </div>
          <div className="about-meta__row">
            <span className="about-meta__label">License</span>
            <span className="about-meta__value">MIT License</span>
          </div>
        </div>

        <div className="about-divider" />

        {/* Disclaimer */}
        <p className="about-disclaimer">
          geartoon は非公式のファンツールです。任天堂株式会社、およびスプラトゥーンシリーズとは一切関係ありません。
          Splatoon™ は任天堂株式会社の商標です。
        </p>
      </div>
    </>
  )
}

// Tauriのメニューイベントをリッスンしてコールバックを呼ぶ
// ブラウザ開発時は何もしない
export async function listenAboutMenuEvent(onAbout: () => void): Promise<() => void> {
  try {
    const { listen } = await import('@tauri-apps/api/event')
    const unlisten = await listen('show-about', onAbout)
    return unlisten
  } catch {
    return () => {}
  }
}
