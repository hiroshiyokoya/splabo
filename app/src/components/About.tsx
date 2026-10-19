import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getVersion } from '@tauri-apps/api/app'
import { displayVersion, sourceUrl } from '../utils/version'
import type { NewerRelease } from '../utils/version'
import { openUrl } from '@tauri-apps/plugin-opener'

const FEEDBACK_FORM_URL =
  'https://docs.google.com/forms/d/e/1FAIpQLSd2m8eNn4HwTjOY1PMnecJvSH95QCJxNi0Lyy1w4zxhIdndrQ/viewform'

interface Props {
  onClose: () => void
}

/**
 * 同梱ソフトウェアのライセンス（#534）。`app/public/third-party-licenses.txt` を出す
 * （`tools/licenses/generate.mjs` が作る。リリースはビルドのたびに作り直す）。
 */
function ThirdPartyLicenses({ onClose }: Props) {
  const { t } = useTranslation()
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/third-party-licenses.txt')
      .then(r => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setText)
      .catch(e => setError(String(e)))
  }, [])

  return (
    <div className="modal-overlay" onClick={e => { e.stopPropagation(); onClose() }}>
      <div className="modal-panel licenses-panel" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">{t('about.thirdParty')}</div>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          {error && <p className="licenses-error">{t('about.thirdPartyLoadFailed', { detail: error })}</p>}
          {text !== null && <pre className="licenses-text">{text}</pre>}
        </div>
      </div>
    </div>
  )
}

interface AboutProps extends Props {
  /** 今より新しいリリース。無ければ null（#542） */
  newerRelease: NewerRelease | null
}

export function About({ onClose, newerRelease }: AboutProps) {
  const { t } = useTranslation()
  const [version, setVersion] = useState('')
  const [showLicenses, setShowLicenses] = useState(false)

  useEffect(() => {
    getVersion().then(setVersion).catch(() => setVersion(''))
  }, [])

  // ライセンスを開いているときの Esc は、ライセンスだけ閉じる
  const handleKey = useCallback((e: KeyboardEvent) => {
    if (e.key !== 'Escape') return
    if (showLicenses) setShowLicenses(false)
    else onClose()
  }, [onClose, showLicenses])
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
          {newerRelease && (
            <a
              className="about-link about-update"
              href={newerRelease.url}
              onClick={e => { e.preventDefault(); openUrl(newerRelease.url).catch(console.error) }}
            >
              {t('about.updateAvailable', { version: newerRelease.version })}
            </a>
          )}
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
          <div className="about-license">
            <p>{t('about.license')}</p>
            <div className="about-links">
              <a
                className="about-link"
                href={sourceUrl(version)}
                onClick={e => { e.preventDefault(); openUrl(sourceUrl(version)).catch(console.error) }}
              >
                {t('about.source')}
              </a>
              <a
                className="about-link"
                href="#"
                onClick={e => { e.preventDefault(); setShowLicenses(true) }}
              >
                {t('about.thirdParty')}
              </a>
            </div>
          </div>
          <div className="about-notice">
            {t('about.notice')}
          </div>
        </div>
      </div>
      {showLicenses && <ThirdPartyLicenses onClose={() => setShowLicenses(false)} />}
    </div>
  )
}
