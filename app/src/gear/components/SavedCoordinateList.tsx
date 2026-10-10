import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { GearDB, Skill } from '../types'
import type { ResolvedCoordinate, SavedCoordinate } from '../utils/savedCoordinates'
import { GEAR_CATEGORIES, resolveCoordinate, sortApEntries, totalApBySkill } from '../utils/savedCoordinates'
import { isMainOnly } from '../constants/gearPowerMeta'
import { skillDisplayName } from '../utils/skillDisplayName'
import { gearItemDisplayName } from '../utils/gearItemDisplayName'

/** 削除ボタンの「もう一度押すと削除」を保つ時間(ms) */
const DELETE_CONFIRM_MS = 3000

interface Props {
  data: GearDB
  coordinates: SavedCoordinate[]
  onApply: (resolved: ResolvedCoordinate) => void
  onEdit: (coord: SavedCoordinate) => void
  onDelete: (coord: SavedCoordinate) => void
  /** 今のギアパワーでスナップショットを取り直す */
  onResave: (coord: SavedCoordinate, resolved: ResolvedCoordinate) => void
}

/** 保存コーデの一覧（ギアタブの「保存コーデ」・#782） */
export function SavedCoordinateList({ data, coordinates, onApply, onEdit, onDelete, onResave }: Props) {
  const { t } = useTranslation()
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => { if (confirmTimer.current) clearTimeout(confirmTimer.current) }, [])

  const skillById = useMemo(() => {
    const map = new Map<number, Skill>()
    for (const cat of GEAR_CATEGORIES) {
      for (const gear of data[cat]) {
        for (const s of [gear.primary_skill, ...gear.additional_skills]) map.set(s.id, s)
      }
    }
    return map
  }, [data])

  const rows = useMemo(
    () => [...coordinates]
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map(coord => ({ coord, resolved: resolveCoordinate(coord, data) })),
    [coordinates, data],
  )

  const handleDelete = (coord: SavedCoordinate) => {
    if (confirmingId === coord.id) {
      if (confirmTimer.current) clearTimeout(confirmTimer.current)
      setConfirmingId(null)
      onDelete(coord)
      return
    }
    setConfirmingId(coord.id)
    if (confirmTimer.current) clearTimeout(confirmTimer.current)
    confirmTimer.current = setTimeout(() => setConfirmingId(null), DELETE_CONFIRM_MS)
  }

  if (rows.length === 0) {
    return <div className="status coord-empty">{t('gear.saved.empty')}</div>
  }

  return (
    <div className="coord-list">
      {rows.map(({ coord, resolved }) => {
        const anyChanged = GEAR_CATEGORIES.some(cat => resolved[cat].changed)
        const anyMissing = GEAR_CATEGORIES.some(cat => resolved[cat].gear === null)
        const ap = sortApEntries(totalApBySkill(GEAR_CATEGORIES.map(cat => resolved[cat].gear)))
        return (
          <div key={coord.id} className="coord-card">
            <button
              type="button"
              className="coord-card__main"
              onClick={() => onApply(resolved)}
              title={t('gear.saved.apply')}
            >
              <div className="coord-card__gears">
                {GEAR_CATEGORIES.map(cat => {
                  const { gear, ref, changed } = resolved[cat]
                  if (!gear) {
                    return (
                      <div key={cat} className="coord-card__gear coord-card__gear--missing" title={ref.name}>
                        <span className="coord-gear-missing">{t('gear.saved.missing')}</span>
                      </div>
                    )
                  }
                  const name = gearItemDisplayName(gear)
                  return (
                    <div key={cat} className={`coord-card__gear${changed ? ' coord-card__gear--changed' : ''}`} title={name}>
                      <img src={gear.image} alt={name} />
                    </div>
                  )
                })}
              </div>
              <div className="coord-card__body">
                <div className="coord-card__title">{coord.title}</div>
                {coord.memo && <div className="coord-card__memo">{coord.memo}</div>}
                <div className="coord-card__ap">
                  {ap.map(([id, pts]) => {
                    const skill = skillById.get(id)
                    const name = skillDisplayName({ id, name: skill?.name ?? '' }, t)
                    return (
                      <div key={id} className="combo-result-ap-chip" title={name}>
                        {skill ? <img src={skill.image} alt={name} /> : <span className="combo-result-ap-chip__id">{id}</span>}
                        {!isMainOnly(id) && <span>{t('gear.combo.points', { count: pts })}</span>}
                      </div>
                    )
                  })}
                </div>
                {anyMissing && <div className="coord-card__warn">{t('gear.saved.missingWarn')}</div>}
                {anyChanged && <div className="coord-card__warn">{t('gear.saved.changed')}</div>}
              </div>
            </button>
            <div className="coord-card__actions">
              {anyChanged && !anyMissing && (
                <button type="button" className="coord-btn" onClick={() => onResave(coord, resolved)}>
                  {t('gear.saved.resave')}
                </button>
              )}
              <button type="button" className="coord-btn" onClick={() => onEdit(coord)}>
                {t('gear.saved.edit')}
              </button>
              <button
                type="button"
                className={`coord-btn coord-btn--danger${confirmingId === coord.id ? ' coord-btn--confirm' : ''}`}
                onClick={() => handleDelete(coord)}
              >
                {confirmingId === coord.id ? t('gear.saved.deleteConfirm') : t('gear.saved.delete')}
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
