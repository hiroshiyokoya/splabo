import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getVersion } from '@tauri-apps/api/app'
import { displayVersion } from '../utils/version'
import { openUrl } from '@tauri-apps/plugin-opener'

const FEEDBACK_FORM_URL =
  'https://docs.google.com/forms/d/e/1FAIpQLSd2m8eNn4HwTjOY1PMnecJvSH95QCJxNi0Lyy1w4zxhIdndrQ/viewform'

interface Props {
  onClose: () => void
}

export function About({ onClose }: Props) {
  const { t } = useTranslation()
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
          <div className="modal-title">{t('about.title')}</div>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body about-body">
          <img className="about-logo" src="/splabo-logo.png" alt="splabo" />
          {version && <div className="about-version">v{displayVersion(version)}</div>}
          <p className="about-desc">
            {t('about.desc')}
          </p>
          <div className="about-links">
            <a
              className="about-link"
              href="https://github.com/hiroshiyokoya"
              onClick={e => { e.preventDefault(); openUrl('https://github.com/hiroshiyokoya').catch(console.error) }}
            >
              @hiroshiyokoya
            </a>
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
              {t('about.feedback')}
            </a>
          </div>
          <div className="about-notice">
            {t('about.notice')}
          </div>
        </div>
      </div>
    </div>
  )
}
