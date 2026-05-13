import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { useGearDB } from './hooks/useGearDB'
import { GearCard } from './components/GearCard'
import { FilterDrawer, emptyFilter, countActiveFilters } from './components/FilterDrawer'
import type { FilterState } from './components/FilterDrawer'
import type { GearCategory, GearItem, Skill } from './types'
import { isMainOnly, calcSkillPoints, hasMainOnlySkill, MAIN_ONLY_SKILL_CATEGORY, getMainOnlySkillSortRank, getStackableSkillSortRank } from './constants/gearPowerMeta'

const SCROLL_TOP_THRESHOLD = 600
const SCROLL_TOP_HIDE_AFTER_MS = 1000

const TABS: { key: GearCategory; label: string; icon: string }[] = [
  { key: 'head',     label: '頭ギア',  icon: '🪖' },
  { key: 'clothing', label: '服ギア',  icon: '👕' },
  { key: 'shoes',    label: '靴ギア',  icon: '👟' },
]

type SortKey = 'name' | 'rarity' | 'exp' | 'brand' | 'skill'

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'brand',  label: 'ブランド' },
  { key: 'skill',  label: 'メインパワー' },
  { key: 'name',   label: '名前' },
  { key: 'rarity', label: 'レアリティ' },
  { key: 'exp',    label: 'EXP' },
]

function sortItems(items: GearItem[], key: SortKey, category: GearCategory): GearItem[] {
  return [...items].sort((a, b) => {
    switch (key) {
      case 'name':   return a.name.localeCompare(b.name, 'ja')
      case 'rarity': return b.rarity - a.rarity
      case 'exp':    return b.exp - a.exp
      case 'brand':  return a.brand.localeCompare(b.brand, 'ja')
      case 'skill': {
        // 絞り込みパネルと同じ並び: 発動型 → スタック型、各グループ内はID昇順
        const aId = a.primary_skill.id
        const bId = b.primary_skill.id

        const aType = aId === -1 ? 2 : (isMainOnly(aId) ? 0 : 1)
        const bType = bId === -1 ? 2 : (isMainOnly(bId) ? 0 : 1)
        if (aType !== bType) return aType - bType

        if (aType === 0 && bType === 0) {
          const ra = getMainOnlySkillSortRank(aId, category)
          const rb = getMainOnlySkillSortRank(bId, category)
          if (ra !== rb) return ra - rb
        } else if (aType === 1 && bType === 1) {
          const ra = getStackableSkillSortRank(aId)
          const rb = getStackableSkillSortRank(bId)
          if (ra !== rb) return ra - rb
        }

        if (aId !== bId) return aId - bId
        return a.primary_skill.name.localeCompare(b.primary_skill.name, 'ja')
      }
    }
  })
}

function applyFilter(items: GearItem[], filter: FilterState): GearItem[] {
  let result = items

  // メインのみ型: OR で絞り込む
  if (filter.mainOnlyIds.size > 0) {
    result = result.filter(gear =>
      [...filter.mainOnlyIds].some(id => hasMainOnlySkill(gear, id))
    )
  }

  // スタック型: 各スキルの最低pt を満たすもの（AND）
  for (const [skillId, minPts] of filter.skillMinPoints) {
    if (minPts === 0) continue
    result = result.filter(gear => calcSkillPoints(gear, skillId) >= minPts)
  }

  // ブランド: OR で絞り込む
  if (filter.brands.size > 0) {
    result = result.filter(gear => filter.brands.has(gear.brand))
  }

  return result
}

function App() {
  const { data, loading, error } = useGearDB()
  const [activeTab, setActiveTab]   = useState<GearCategory>('head')
  const [sortKey, setSortKey]       = useState<SortKey>('name')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [filter, setFilter]         = useState<FilterState>(emptyFilter)
  const [showScrollTop, setShowScrollTop] = useState(false)
  const appTopRef = useRef<HTMLDivElement | null>(null)
  const scrollTopHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scrollTopHoverRef = useRef(false)

  useEffect(() => {
    const threshold = SCROLL_TOP_THRESHOLD
    const hideAfterMs = SCROLL_TOP_HIDE_AFTER_MS

    const clearHideTimer = () => {
      if (scrollTopHideTimerRef.current != null) {
        clearTimeout(scrollTopHideTimerRef.current)
        scrollTopHideTimerRef.current = null
      }
    }

    const armHideTimer = () => {
      clearHideTimer()
      scrollTopHideTimerRef.current = setTimeout(() => {
        scrollTopHideTimerRef.current = null
        if (!scrollTopHoverRef.current) setShowScrollTop(false)
      }, hideAfterMs)
    }

    const onScroll = () => {
      const y = window.scrollY
      if (y > threshold) {
        setShowScrollTop(true)
        if (!scrollTopHoverRef.current) armHideTimer()
      } else {
        clearHideTimer()
        setShowScrollTop(false)
      }
    }

    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      clearHideTimer()
      window.removeEventListener('scroll', onScroll)
    }
  }, [])

  useEffect(() => {
    const el = appTopRef.current
    if (!el) return

    const update = () => {
      const h = Math.ceil(el.getBoundingClientRect().height)
      document.documentElement.style.setProperty('--app-top-height', `${h}px`)
    }

    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('resize', update)
      ro.disconnect()
    }
  }, [])

  // 全スキル一覧（id 昇順・重複なし）
  const allSkills = useMemo<Skill[]>(() => {
    if (!data) return []
    const map = new Map<number, Skill>()
    for (const cat of ['head', 'clothing', 'shoes'] as GearCategory[]) {
      for (const gear of data[cat]) {
        if (gear.primary_skill.id !== -1) map.set(gear.primary_skill.id, gear.primary_skill)
        for (const s of gear.additional_skills) {
          if (s.id !== -1) map.set(s.id, s)
        }
      }
    }
    return [...map.values()].sort((a, b) => a.id - b.id)
  }, [data])

  // 全ブランド一覧（五十音順・重複なし）
  const allBrands = useMemo<string[]>(() => {
    if (!data) return []
    const set = new Set<string>()
    for (const cat of ['head', 'clothing', 'shoes'] as GearCategory[]) {
      for (const gear of data[cat]) set.add(gear.brand)
    }
    return [...set].sort((a, b) => a.localeCompare(b, 'ja'))
  }, [data])

  const items = useMemo(() => {
    if (!data) return []
    return sortItems(applyFilter(data[activeTab], filter), sortKey, activeTab)
  }, [data, activeTab, sortKey, filter])

  const handleToggleMainOnly = useCallback((id: number) => {
    setFilter(prev => {
      // シングルセレクト: 選択済みならOFF、未選択なら差し替え
      const next = prev.mainOnlyIds.has(id) ? new Set<number>() : new Set([id])
      return { ...prev, mainOnlyIds: next }
    })
  }, [])

  const handleSetSkillPoints = useCallback((id: number, points: number) => {
    setFilter(prev => {
      const next = new Map(prev.skillMinPoints)
      next.set(id, points)
      return { ...prev, skillMinPoints: next }
    })
  }, [])

  const handleToggleBrand = useCallback((brand: string) => {
    setFilter(prev => {
      const next = new Set(prev.brands)
      next.has(brand) ? next.delete(brand) : next.add(brand)
      return { ...prev, brands: next }
    })
  }, [])

  const handleClearBrands = useCallback(() =>
    setFilter(prev => ({ ...prev, brands: new Set() })), [])

  const handleReset = useCallback(() => setFilter(emptyFilter()), [])

  const activeFilterCount = countActiveFilters(filter)

  if (loading) return <div className="status">ギアデータを読み込み中...</div>
  if (error)   return <div className="status status--error">エラー: {error}</div>
  if (!data)   return null

  const total = data.head.length + data.clothing.length + data.shoes.length

  return (
    <div className="app">
      <div ref={appTopRef} className="app-top app-top--sticky">
        <header className="app-header">
          <div className="app-header__left">
            <img src="/geartoon-logo.png" alt="geartoon" height="68" style={{ display: 'block' }} />
            <p className="app-subtitle">Splatoon 3 Gear Wardrobe</p>
          </div>
          <span className="app-count">{total.toLocaleString()} ギア</span>
        </header>

        <div className="header-divider" />

        <nav className="tabs">
          {TABS.map(({ key, label, icon }) => (
            <button
              key={key}
              className={`tab ${activeTab === key ? 'tab--active' : ''}`}
              onClick={() => {
                setActiveTab(key)
                // タブ切り替え時: 新しいタブに対応しない発動型フィルターをクリア
                setFilter(prev => {
                  if (prev.mainOnlyIds.size === 0) return prev
                  const [selectedId] = prev.mainOnlyIds
                  if (MAIN_ONLY_SKILL_CATEGORY[selectedId] === key) return prev
                  return { ...prev, mainOnlyIds: new Set() }
                })
              }}
            >
              <span className="tab__icon">{icon}</span>
              {label}
              <span className="tab__badge">{data[key].length}</span>
            </button>
          ))}

          <button
            className={`filter-btn ${activeFilterCount > 0 ? 'filter-btn--active' : ''}`}
            onClick={() => setDrawerOpen(true)}
            aria-label="絞り込み"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
              style={{ flexShrink: 0 }}
            >
              <path
                d="M3 5h18l-7 8v6l-4 2v-8L3 5z"
                fill="currentColor"
              />
            </svg>
            絞り込み
            {activeFilterCount > 0 && (
              <span className="filter-btn__badge">{activeFilterCount}</span>
            )}
          </button>

          <select
            className="sort-select"
            value={sortKey}
            onChange={e => setSortKey(e.target.value as SortKey)}
            aria-label="並び替え"
          >
            {SORT_OPTIONS.map(({ key, label }) => (
              <option key={key} value={key}>{label}</option>
            ))}
          </select>
        </nav>
      </div>

      {/* 絞り込み結果カウント */}
      {activeFilterCount > 0 && (
        <div className="filter-result">
          {items.length} 件 / {data[activeTab].length} 件
        </div>
      )}

      <div className="gear-grid">
        {items.map((gear) => (
          <GearCard key={gear.id} gear={gear} />
        ))}
        {items.length === 0 && (
          <div className="status">該当するギアがありません</div>
        )}
      </div>

      <footer className="app-footer">
        <span className="app-footer__copy">
          © 2026{' '}
          <a
            className="app-footer__copy-link"
            href="https://github.com/hiroshiyokoya/geartoon"
            target="_blank"
            rel="noreferrer"
          >
            hiroshiyokoya
          </a>
        </span>
        <span className="app-footer__divider">·</span>
        <span className="app-footer__note">geartoon — personal gear wardrobe for Splatoon 3</span>
      </footer>

      {showScrollTop && (
        <button
          className="scroll-top scroll-top--below-sticky"
          onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
          onMouseEnter={() => {
            scrollTopHoverRef.current = true
            if (scrollTopHideTimerRef.current != null) {
              clearTimeout(scrollTopHideTimerRef.current)
              scrollTopHideTimerRef.current = null
            }
          }}
          onMouseLeave={() => {
            scrollTopHoverRef.current = false
            if (window.scrollY > SCROLL_TOP_THRESHOLD) {
              scrollTopHideTimerRef.current = setTimeout(() => {
                scrollTopHideTimerRef.current = null
                if (!scrollTopHoverRef.current) setShowScrollTop(false)
              }, SCROLL_TOP_HIDE_AFTER_MS)
            }
          }}
          aria-label="一番上に戻る"
          title="一番上に戻る"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M12 19V7"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
            />
            <path
              d="M7 11l5-5 5 5"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      )}

      <FilterDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        activeTab={activeTab}
        allSkills={allSkills}
        allBrands={allBrands}
        filter={filter}
        onToggleMainOnly={handleToggleMainOnly}
        onSetSkillPoints={handleSetSkillPoints}
        onToggleBrand={handleToggleBrand}
        onClearBrands={handleClearBrands}
        onReset={handleReset}
      />
    </div>
  )
}

export default App
