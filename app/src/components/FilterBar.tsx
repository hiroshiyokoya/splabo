import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { Filters, Period } from '../types'
import { modeLabel } from '../types'

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
  const [weaponList,   setWeaponList]   = useState<string[]>([])
  const [weaponImages, setWeaponImages] = useState<Map<string, string>>(new Map())
  const [pickerOpen,   setPickerOpen]   = useState(false)

  useEffect(() => {
    invoke<string[]>('db_weapons_used').then(weapons => {
      setWeaponList(weapons)
      Promise.all(
        weapons.map(name =>
          invoke<string | null>('read_image', { kind: 'weapon', name })
            .then(url => (url ? ([name, url] as [string, string]) : null))
            .catch(() => null)
        )
      ).then(results => {
        setWeaponImages(new Map(results.filter((r): r is [string, string] => r !== null)))
      })
    })
  }, [])

  function patch<K extends keyof Filters>(key: K, val: Filters[K]) {
    onChange({ ...filters, [key]: val })
  }

  function toggle(key: 'mode' | 'rule' | 'result', val: string) {
    patch(key, filters[key] === val ? null : val)
  }

  function reset() {
    onChange({ period: 'all', mode: null, rule: null, result: null, weapon: null, customFrom: null, customTo: null })
    setPickerOpen(false)
  }

  const hasFilter = !!(
    filters.period !== 'all' ||
    filters.mode || filters.rule || filters.result || filters.weapon
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
        <FilterGroup label="結果">
          {RESULTS.map(r => (
            <button
              key={r}
              className={`filter-btn result-btn-${r.toLowerCase()}${filters.result === r ? ' active' : ''}`}
              onClick={() => toggle('result', r)}
            >{r}</button>
          ))}
        </FilterGroup>
        <FilterGroup label="武器">
          <WeaponPicker
            weaponList={weaponList}
            weaponImages={weaponImages}
            selected={filters.weapon}
            open={pickerOpen}
            onToggleOpen={() => setPickerOpen(v => !v)}
            onClose={() => setPickerOpen(false)}
            onSelect={w => { patch('weapon', w); setPickerOpen(false) }}
          />
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

function WeaponPicker({
  weaponList, weaponImages, selected, open, onToggleOpen, onClose, onSelect,
}: {
  weaponList: string[]
  weaponImages: Map<string, string>
  selected: string | null
  open: boolean
  onToggleOpen: () => void
  onClose: () => void
  onSelect: (w: string | null) => void
}) {
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handler(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open, onClose])

  return (
    <div className="weapon-picker-wrap" ref={wrapRef}>
      <button className={`filter-btn weapon-trigger${selected ? ' active' : ''}`} onClick={onToggleOpen}>
        {selected ? (
          <span className="weapon-cell">
            {weaponImages.get(selected) && <img src={weaponImages.get(selected)} alt="" className="weapon-icon" />}
            {selected}
          </span>
        ) : '全武器 ▼'}
      </button>
      {open && (
        <div className="weapon-picker-dropdown">
          <button
            className={`weapon-picker-item${selected === null ? ' active' : ''}`}
            onClick={() => onSelect(null)}
          >
            <span style={{ width: 24, display: 'inline-block' }} />
            全武器
          </button>
          <div className="weapon-picker-divider" />
          {weaponList.map(w => (
            <button
              key={w}
              className={`weapon-picker-item${selected === w ? ' active' : ''}`}
              onClick={() => onSelect(w)}
            >
              {weaponImages.get(w) && <img src={weaponImages.get(w)} alt="" className="weapon-icon" />}
              {w}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
