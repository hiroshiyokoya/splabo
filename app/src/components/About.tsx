import { useCallback, useEffect } from 'react'
import { getVersion } from '@tauri-apps/api/app'
import { openUrl } from '@tauri-apps/plugin-opener'
import { useState } from 'react'

interface Props {
  onClose: () => void
}

export function About({ onClose }: Props) {
  const [version, setVersion] = useState('')

  useEffect(() => {
    getVersion().then(setVersion).catch(() => setVersion(''))
  }, [])

  const handleKey = useCallback((e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }, [onClose])
  useEffect(() => {
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [handleKey])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel about-panel" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">chartoon について</div>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body about-body">
          <div className="about-logo">chartoon</div>
          {version && <div className="about-version">v{version}</div>}
          <p className="about-desc">
            Splatoon 3 のバトルデータを記録・分析するデスクトップアプリです。
          </p>
          <div className="about-links">
            <a
              className="about-link"
              href="https://github.com/hiroshiyokoya/chartoon"
              onClick={e => { e.preventDefault(); openUrl('https://github.com/hiroshiyokoya/chartoon').catch(console.error) }}
            >
              GitHub
            </a>
          </div>
          <div className="about-notice">
            本アプリは非公式ツールです。Nintendo / スプラトゥーンとは無関係です。
          </div>
        </div>
      </div>
    </div>
  )
}
