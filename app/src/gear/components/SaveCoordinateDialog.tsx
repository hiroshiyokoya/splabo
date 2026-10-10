import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { GearItem } from '../types'
import { GEAR_CATEGORIES } from '../utils/savedCoordinates'
import { gearItemDisplayName } from '../utils/gearItemDisplayName'

interface Props {
  /** 'new' = 保存、'edit' = タイトル・メモの編集 */
  mode: 'new' | 'edit'
  initialTitle: string
  initialMemo: string
  /** 見出しの下に出すギア（手放したギアは null） */
  gears: Record<'head' | 'clothing' | 'shoes', GearItem | null>
  error?: string | null
  saving?: boolean
  onSave: (title: string, memo: string) => void
  onClose: () => void
}

/** 保存コーデのタイトル・メモ入力（#782） */
export function SaveCoordinateDialog({ mode, initialTitle, initialMemo, gears, error, saving, onSave, onClose }: Props) {
  const { t } = useTranslation()
  const [title, setTitle] = useState(initialTitle)
  const [memo, setMemo] = useState(initialMemo)
  const titleRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    titleRef.current?.focus()
    titleRef.current?.select()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const canSave = title.trim() !== '' && !saving
  const submit = () => { if (canSave) onSave(title, memo) }

  return (
    <div className="coord-dialog-overlay" onClick={onClose}>
      <div
        className="coord-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={mode === 'new' ? t('gear.saved.saveHeading') : t('gear.saved.editHeading')}
        onClick={e => e.stopPropagation()}
      >
        <div className="coord-dialog__header">
          {mode === 'new' ? t('gear.saved.saveHeading') : t('gear.saved.editHeading')}
        </div>

        <div className="coord-dialog__gears">
          {GEAR_CATEGORIES.map(cat => {
            const gear = gears[cat]
            return gear
              ? <img key={cat} src={gear.image} alt={gearItemDisplayName(gear)} title={gearItemDisplayName(gear)} />
              : <span key={cat} className="coord-gear-missing">{t('gear.saved.missing')}</span>
          })}
        </div>

        <label className="coord-dialog__field">
          <span>{t('gear.saved.titleLabel')}</span>
          <input
            ref={titleRef}
            type="text"
            value={title}
            maxLength={60}
            onChange={e => setTitle(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) submit() }}
          />
        </label>

        <label className="coord-dialog__field">
          <span>{t('gear.saved.memoLabel')}</span>
          <textarea
            value={memo}
            rows={4}
            maxLength={1000}
            placeholder={t('gear.saved.memoPlaceholder')}
            onChange={e => setMemo(e.target.value)}
          />
        </label>

        {error && <p className="coord-dialog__error" role="alert">{error}</p>}

        <div className="coord-dialog__actions">
          <button type="button" className="coord-btn" onClick={onClose}>{t('gear.saved.cancel')}</button>
          <button type="button" className="coord-btn coord-btn--primary" onClick={submit} disabled={!canSave}>
            {t('gear.saved.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
