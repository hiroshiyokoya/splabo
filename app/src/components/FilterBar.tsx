import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { Filters, Period, WeaponRecord } from '../types'
import { modeLabel, ruleLabel, resultLabel, RULE_LABELS } from '../types'

const MODES   = ['regular', 'bankara', 'x', 'splatfest']
const RULES   = Object.keys(RULE_LABELS)   // ['turf_war', 'area', 'yagura', 'hoko', 'asari']
const RESULTS = ['win', 'lose', 'draw']

interface StageInfo { id: string; name: string }
const PERIODS: { id: Period; label: string }[] = [
  { id: 'all',            label: '全期間' },
  { id: 'current_season', label: '今シーズン' },
  { id: '30d',            label: '直近30日' },
  { id: '7d',             label: '直近7日' },
  { id: 'custom',         label: 'カスタム' },
]

interface Props {
  filters: Filters
  onChange: (f: Filters) => void
}

export function FilterBar({ filters, onChange }: Props) {
  const [weaponList,      setWeaponList]      = useState<WeaponRecord[]>([])
  const [weaponImages,    setWeaponImages]    = useState<Map<string, string>>(new Map())
  const [pickerOpen,      setPickerOpen]      = useState(false)
  const [stageList,       setStageList]       = useState<StageInfo[]>([])
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
    invoke<StageInfo[]>('db_stages_used').then(setStageList).catch(() => {})
  }, [])

  function patch<K extends keyof Filters>(key: K, val: Filters[K]) {
    onChange({ ...filters, [key]: val })
  }

  function toggle(key: 'mode' | 'rule' | 'result', val: string) {
    patch(key, filters[key] === val ? null : val)
  }

  // モードとルールに不整合な組み合わせが生まれたら、もう片方を解除する。
  // 自動セット（レギュラー → ナワバリ等）はしない。
  const GACHI_RULES     = ['area', 'yagura', 'hoko', 'asari']
  const BANKARA_MODES   = ['bankara', 'bankara_challenge', 'bankara_open']
  const SPLATFEST_MODES = ['splatfest', 'splatfest_open', 'splatfest_challenge']
  function toggleMode(m: string) {
    // 同じ値を再クリックなら解除（連動なし）
    if (filters.mode === m) {
      onChange({ ...filters, mode: null })
      return
    }
    let nextRule = filters.rule
    if ((m === 'regular' || m === 'splatfest') && GACHI_RULES.includes(filters.rule ?? '')) {
      nextRule = null              // レギュラー/フェス選択 → ガチ系ルール解除（どちらもナワバリ）
    } else if ((m === 'bankara' || m === 'x') && filters.rule === 'turf_war') {
      nextRule = null              // ガチ系モード選択 → ナワバリ解除
    }
    onChange({ ...filters, mode: m, rule: nextRule })
  }
  // フェスボタンは 4 状態を循環（バンカラと同じ流儀）：
  //   非選択 → splatfest（両方）→ splatfest_open → splatfest_challenge → 非選択
  function cycleSplatfest() {
    const next: string | null =
      filters.mode === 'splatfest'           ? 'splatfest_open' :
      filters.mode === 'splatfest_open'      ? 'splatfest_challenge' :
      filters.mode === 'splatfest_challenge' ? null :
      /* 非選択 or 他モード */                 'splatfest'
    // フェスはナワバリなので、ガチ系ルールが選ばれていたら外す
    const nextRule = (next !== null && GACHI_RULES.includes(filters.rule ?? '')) ? null : filters.rule
    onChange({ ...filters, mode: next, rule: nextRule })
  }
  // バンカラボタンは 4 状態を循環：
  //   非選択 → bankara（両方）→ bankara_challenge → bankara_open → 非選択
  function cycleBankara() {
    const next: string | null =
      filters.mode === 'bankara'           ? 'bankara_challenge' :
      filters.mode === 'bankara_challenge' ? 'bankara_open' :
      filters.mode === 'bankara_open'      ? null :
      /* 非選択 or 他モード */              'bankara'
    // バンカラ系を選ぶ場合、ナワバリは外す（既存連動と整合）
    const nextRule = (next !== null && filters.rule === 'turf_war') ? null : filters.rule
    onChange({ ...filters, mode: next, rule: nextRule })
  }
  function toggleRule(r: string) {
    if (filters.rule === r) {
      onChange({ ...filters, rule: null })
      return
    }
    let nextMode = filters.mode
    if (r === 'turf_war' && (BANKARA_MODES.includes(filters.mode ?? '') || filters.mode === 'x')) {
      nextMode = null              // ナワバリ選択 → バンカラ系/Xマッチ解除（フェスはナワバリなので残す）
    } else if (GACHI_RULES.includes(r) && (filters.mode === 'regular' || SPLATFEST_MODES.includes(filters.mode ?? ''))) {
      nextMode = null              // ガチ系ルール選択 → レギュラー/フェス解除
    }
    onChange({ ...filters, rule: r, mode: nextMode })
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
          {MODES.map(m => {
            if (m === 'bankara') {
              // バンカラは 4 状態循環ボタン：非選択 → 両方 → チャレンジ → オープン → 非選択
              const isActive = BANKARA_MODES.includes(filters.mode ?? '')
              const label    = isActive ? modeLabel(filters.mode!) : 'バンカラ'
              return (
                <button
                  key={m}
                  className={`filter-btn${isActive ? ' active' : ''}`}
                  onClick={cycleBankara}
                >{label}</button>
              )
            }
            if (m === 'splatfest') {
              // フェスも 4 状態循環ボタン：非選択 → 両方 → オープン → チャレンジ → 非選択
              const isActive = SPLATFEST_MODES.includes(filters.mode ?? '')
              const label    = isActive ? modeLabel(filters.mode!) : 'フェス'
              return (
                <button
                  key={m}
                  className={`filter-btn${isActive ? ' active' : ''}`}
                  onClick={cycleSplatfest}
                >{label}</button>
              )
            }
            return (
              <button
                key={m}
                className={`filter-btn${filters.mode === m ? ' active' : ''}`}
                onClick={() => toggleMode(m)}
              >{modeLabel(m)}</button>
            )
          })}
        </FilterGroup>
      </div>
      <div className="filter-row">
        <FilterGroup label="ルール">
          {RULES.map(r => (
            <button
              key={r}
              className={`filter-btn${filters.rule === r ? ' active' : ''}`}
              onClick={() => toggleRule(r)}
            >{ruleLabel(r)}</button>
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
            onToggleStage={id => {
              const next = filters.stage.includes(id)
                ? filters.stage.filter(x => x !== id)
                : [...filters.stage, id]
              patch('stage', next)
            }}
            onClear={() => patch('stage', [])}
          />
        </FilterGroup>
        <FilterGroup label="結果">
          {RESULTS.map(r => (
            <button
              key={r}
              className={`filter-btn result-btn-${r}${filters.result === r ? ' active' : ''}`}
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
  stageList: StageInfo[]
  selected: string[]
  open: boolean
  onToggleOpen: () => void
  onClose: () => void
  onToggleStage: (id: string) => void
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
              key={s.id}
              className={`weapon-picker-item${selected.includes(s.id) ? ' active' : ''}`}
              onClick={() => onToggleStage(s.id)}
            >
              <span className="stage-check">{selected.includes(s.id) ? '✓' : ' '}</span>
              {s.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
