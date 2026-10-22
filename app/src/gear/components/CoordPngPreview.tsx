import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

interface Props {
  /** renderElementToPng の結果 */
  dataUrl: string
  filename: string
  onClose: () => void
}

/**
 * スマホ Web 版のコーデ PNG プレビュー（#882）。
 *
 * PC の保存ダイアログは使えず、LAN の http 配信では共有シート（Web Share API）も使えないので、
 * 画像を大きく出して「長押しで写真に保存」してもらう。長押しを知らない人向けに、
 * ダウンロード（iPhone は「ファイル」、Android はダウンロードフォルダ）も並べる。
 */
export function CoordPngPreview({ dataUrl, filename, onClose }: Props) {
  const { t } = useTranslation()
  // data URL のままだと長い文字列を href に持つことになるので、Blob の URL にしてから渡す
  const [blobUrl, setBlobUrl] = useState<string | null>(null)

  useEffect(() => {
    let url: string | null = null
    let cancelled = false
    void fetch(dataUrl)
      .then(res => res.blob())
      .then(blob => {
        if (cancelled) return
        url = URL.createObjectURL(blob)
        setBlobUrl(url)
      })
      .catch(err => console.error('[coord png preview]', err))
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [dataUrl])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const src = blobUrl ?? dataUrl
  const heading = t('gear.saved.pngPreviewHeading')

  return (
    <div className="coord-dialog-overlay" onClick={onClose}>
      <div
        className="coord-dialog coord-png-preview"
        role="dialog"
        aria-modal="true"
        aria-label={heading}
        onClick={e => e.stopPropagation()}
      >
        <div className="coord-dialog__header">{heading}</div>
        <img className="coord-png-preview__img" src={src} alt={heading} />
        <p className="coord-png-preview__hint">{t('gear.saved.pngPreviewHint')}</p>
        <div className="coord-dialog__actions">
          <button type="button" className="coord-btn" onClick={onClose}>{t('gear.saved.close')}</button>
          <a className="coord-btn coord-btn--primary coord-png-preview__download" href={src} download={filename}>
            {t('gear.saved.downloadImage')}
          </a>
        </div>
      </div>
    </div>
  )
}
