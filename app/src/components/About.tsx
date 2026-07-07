import { useCallback, useEffect } from 'react'
import { getVersion } from '@tauri-apps/api/app'
import { openUrl } from '@tauri-apps/plugin-opener'
import { useState } from 'react'

const FEEDBACK_FORM_URL =
  'https://docs.google.com/forms/d/e/1FAIpQLSd2m8eNn4HwTjOY1PMnecJvSH95QCJxNi0Lyy1w4zxhIdndrQ/viewform'

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
          <div className="modal-title">splabo について</div>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body about-body">
          <img className="about-logo" src="/splabo-logo.png" alt="splabo" />
          {version && <div className="about-version">v{version}</div>}
          <div className="about-author">Author: hiroshiyokoya</div>
          <p className="about-desc">
            Splatoon 3 のバトルデータを記録・分析するデスクトップアプリです。
          </p>
          <div className="about-links">
            <a
              className="about-link"
              href="https://github.com/hiroshiyokoya/splabo"
              onClick={e => { e.preventDefault(); openUrl('https://github.com/hiroshiyokoya/splabo').catch(console.error) }}
            >
              GitHub
            </a>
            <a
              className="about-link"
              href={FEEDBACK_FORM_URL}
              onClick={e => { e.preventDefault(); openUrl(FEEDBACK_FORM_URL).catch(console.error) }}
            >
              フィードバック
            </a>
          </div>
          <div className="about-notice">
            本アプリは非公式ツールです。<br />
            Nintendo / スプラトゥーンとは無関係です。
          </div>
        </div>
      </div>
    </div>
  )
}
