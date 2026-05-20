import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { Filters, Period, WeaponRecord } from '../types'
import { modeLabel, resultLabel } from '../types'

const MODES   = ['REGULAR', 'BANKARA', 'XMATCH']
const RULES   = ['ナワバリバトル', 'ガチエリア', 'ガチヤグラ', 'ガチホコバトル', 'ガチアサリ']
const RESULTS = ['WIN', 'LOSE', 'DRAW']
const PERIODS: { id: Period; label: string }[] = [
  { id: 'all',    label: '全期間' },
  { id: '30d',    label: '直近30日' },
  { id: '7d',     label: '直近7日' },
  { id: 'custom', label: 'カスタム' },
]

interface Props {
  filters: Filters
  onChange: (f: Filters) => void
}

export function FilterBar({ filters, onChange }: Props) {
  const [weaponList,      setWeaponList]      = useState<WeaponRecord[]>([])
  const [weaponImages,    setWeaponImages]    = useState<Map<string, string>>(new Map())
  const [pickerOpen,      setPickerOpen]      = useState(false)
  const [stageList,       setStageList]       = useState<string[]>([])
  const [stagePickerOpen, setStagePickerOpen] = useState(false)

  useEffect(() => {
    invoke<WeaponRecord[]>('db_list_weapons').then(weapons => {
      const used = weapons.filter(w => w.total > 0)
      setWeaponList(used)
      Promise.all(
        used.map(w =>
          invoke<string | null>('read_image', { kind: 'weapon', name: w.name })
            .then(url => (url ? ([w.name, url] as [string, string]) : null))
            .catch(() => null)
        )
      ).then(results => {
        setWeaponImages(new Map(results.filter((r): r is [string, string] => r !== null)))
      })
    })
    invoke<string[]>('db_stages_used').then(setStageList).catch(() => {})
  }, [])

  function patch<K extends keyof Filters>(key: K, val: Filters[K]) {
    onChange({ ...filters, [key]: val })
  }

  function toggle(key: 'mode' | 'rule' | 'result', val: string) {
    patch(key, filters[key] === val ? null : val)
  }

  function reset() {
    onChange({ period: 'all', mode: null, rule: null, result: null, weapon: [], stage: [], customFrom: null, customTo: null })
    setPickerOpen(false)
    setStagePickerOpen(false)
  }

  const hasFilter = !!(
    filters.period !== 'all' ||
    filters.mode || filters.rule || filters.result ||
    filters.weapon.length > 0 || filters.stage.length > 0
  )

  return (
    <div className="filter-bar">
      <div className="filter-row">
        <FilterGroup label="期間">
          {PERIODS.map(p => (
            <button
              key={p.id}
              className={`filter-btn${filters.period === p.id ? ' active' : ''}`}
              onClick={() => patch('period', p.id)}
            >{p.label}</button>
          ))}
          {filters.period === 'custom' && (
            <span className="custom-date-range">
              <input
                type="date"
                className="custom-date-input"
                value={filters.customFrom ?? ''}
                onChange={e => patch('customFrom', e.target.value || null)}
              />
              <span className="custom-date-sep">〜</span>
              <input
                type="date"
                className="custom-date-input"
                value={filters.customTo ?? ''}
                onChange={e => patch('customTo', e.target.value || null)}
              />
            </span>
          )}
        </FilterGroup>
        <FilterGroup label="モード">
          {MODES.map(m => (
            <button
              key={m}
              className={`filter-btn${filters.mode === m ? ' active' : ''}`}
              onClick={() => toggle('mode', m)}
            >{modeLabel(m)}</button>
          ))}
        </FilterGroup>
      </div>
      <div className="filter-row">
        <FilterGroup label="ルール">
          {RULES.map(r => (
            <button
              key={r}
              className={`filter-btn${filters.rule === r ? ' active' : ''}`}
              onClick={() => toggle('rule', r)}
            >{r}</button>
          ))}
        </FilterGroup>
      </div>
      <div className="filter-row">
        <FilterGroup label="武器">
          <WeaponPicker
            weaponList={weaponList}
            weaponImages={weaponImages}
            selected={filters.weapon}
            open={pickerOpen}
            onToggleOpen={() => setPickerOpen(v => !v)}
            onClose={() => setPickerOpen(false)}
            onToggleWeapon={w => {
              const next = filters.weapon.includes(w)
                ? filters.weapon.filter(x => x !== w)
                : [...filters.weapon, w]
              patch('weapon', next)
            }}
            onToggleCategory={(catWeapons) => {
              const allSelected = catWeapons.every(w => filters.weapon.includes(w))
              const next = allSelected
                ? filters.weapon.filter(w => !catWeapons.includes(w))
                : [...new Set([...filters.weapon, ...catWeapons])]
              patch('weapon', next)
            }}
            onClear={() => patch('weapon', [])}
          />
        </FilterGroup>
        <FilterGroup label="ステージ">
          <StagePicker
            stageList={stageList}
            selected={filters.stage}
            open={stagePickerOpen}
            onToggleOpen={() => setStagePickerOpen(v => !v)}
            onClose={() => setStagePickerOpen(false)}
            onToggleStage={s => {
              const next = filters.stage.includes(s)
                ? filters.stage.filter(x => x !== s)
                : [...filters.stage, s]
              patch('stage', next)
            }}
            onClear={() => patch('stage', [])}
          />
        </FilterGroup>
        <FilterGroup label="結果">
          {RESULTS.map(r => (
            <button
              key={r}
              className={`filter-btn result-btn-${r.toLowerCase()}${filters.result === r ? ' active' : ''}`}
              onClick={() => toggle('result', r)}
            >{resultLabel(r)}</button>
          ))}
        </FilterGroup>
        {hasFilter && (
          <button className="filter-reset-btn" onClick={reset}>✕ リセット</button>
        )}
      </div>
    </div>
  )
}

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="filter-group">
      <span className="filter-group-label">{label}</span>
      {children}
    </div>
  )
}

function useOutsideClose(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open, onClose])
  return ref
}

function WeaponPicker({
  weaponList, weaponImages, selected, open, onToggleOpen, onClose, onToggleWeapon, onToggleCategory, onClear,
}: {
  weaponList: WeaponRecord[]
  weaponImages: Map<string, string>
  selected: string[]
  open: boolean
  onToggleOpen: () => void
  onClose: () => void
  onToggleWeapon: (w: string) => void
  onToggleCategory: (catWeapons: string[]) => void
  onClear: () => void
}) {
  const wrapRef = useOutsideClose(open, onClose)

  const categories = [...new Set(weaponList.map(w => w.category).filter(Boolean))]
  const uncategorized = weaponList.filter(w => !w.category)

  const label = selected.length === 0 ? '全武器 ▼' : `${selected.length}件選択 ▼`

  return (
    <div className="weapon-picker-wrap" ref={wrapRef}>
      <button className={`filter-btn weapon-trigger${selected.length > 0 ? ' active' : ''}`} onClick={onToggleOpen}>
        {label}
      </button>
      {open && (
        <div className="weapon-picker-dropdown">
          <button className={`weapon-picker-item${selected.length === 0 ? ' active' : ''}`} onClick={onClear}>
            全武器
          </button>
          <div className="weapon-picker-divider" />
          {categories.map(cat => {
            const catWeapons = weaponList.filter(w => w.category === cat)
            const selCount = catWeapons.filter(w => selected.includes(w.name)).length
            const allSel = selCount === catWeapons.length
            return (
              <div key={cat}>
                <button
                  className="weapon-category-header"
                  onClick={() => onToggleCategory(catWeapons.map(w => w.name))}
                >
                  <span className="stage-check">{allSel ? '✓' : selCount > 0 ? '−' : ' '}</span>
                  {cat}
                  <span className="category-count">{selCount > 0 ? `${selCount}/` : ''}{catWeapons.length}</span>
                </button>
                {catWeapons.map(w => (
                  <button
                    key={w.name}
                    className={`weapon-picker-item weapon-picker-item--indent${selected.includes(w.name) ? ' active' : ''}`}
                    onClick={() => onToggleWeapon(w.name)}
                  >
                    <span className="stage-check">{selected.includes(w.name) ? '✓' : ' '}</span>
                    {weaponImages.get(w.name) && <img src={weaponImages.get(w.name)} alt="" className="weapon-icon" />}
                    {w.name}
                  </button>
                ))}
              </div>
            )
          })}
          {uncategorized.map(w => (
            <button
              key={w.name}
              className={`weapon-picker-item${selected.includes(w.name) ? ' active' : ''}`}
              onClick={() => onToggleWeapon(w.name)}
            >
              <span className="stage-check">{selected.includes(w.name) ? '✓' : ' '}</span>
              {weaponImages.get(w.name) && <img src={weaponImages.get(w.name)} alt="" className="weapon-icon" />}
              {w.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function StagePicker({
  stageList, selected, open, onToggleOpen, onClose, onToggleStage, onClear,
}: {
  stageList: string[]
  selected: string[]
  open: boolean
  onToggleOpen: () => void
  onClose: () => void
  onToggleStage: (s: string) => void
  onClear: () => void
}) {
  const wrapRef = useOutsideClose(open, onClose)

  const label = selected.length === 0 ? '全ステージ ▼' : `${selected.length}件選択 ▼`

  return (
    <div className="weapon-picker-wrap" ref={wrapRef}>
      <button className={`filter-btn weapon-trigger${selected.length > 0 ? ' active' : ''}`} onClick={onToggleOpen}>
        {label}
      </button>
      {open && (
        <div className="weapon-picker-dropdown">
          <button className={`weapon-picker-item${selected.length === 0 ? ' active' : ''}`} onClick={onClear}>
            全ステージ
          </button>
          <div className="weapon-picker-divider" />
          {stageList.map(s => (
            <button
              key={s}
              className={`weapon-picker-item${selected.includes(s) ? ' active' : ''}`}
              onClick={() => onToggleStage(s)}
            >
              <span className="stage-check">{selected.includes(s) ? '✓' : ' '}</span>
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
