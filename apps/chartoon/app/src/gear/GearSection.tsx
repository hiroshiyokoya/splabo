import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { GearCard } from './components/GearCard'
import { FilterDrawer, emptyFilter, countActiveFilters } from './components/FilterDrawer'
import { ComboSheet, emptySlots } from './components/ComboSheet'
import { useGearDB, saveLastFetchedAt } from './hooks/useGearDB'
import { isTauri } from './utils/tauri'
import type { FilterState } from './components/FilterDrawer'
import type { ComboSlots } from './components/ComboSheet'
import type { ComboResult } from './utils/findCombo'
import type { GearCategory, GearItem, Skill } from './types'
import { isMainOnly, calcSkillPoints, hasMainOnlySkill, MAIN_ONLY_SKILL_CATEGORY, getMainOnlySkillSortRank, getStackableSkillSortRank } from './constants/gearPowerMeta'
import { initAppSettings, loadComboLimit, loadNearLimit } from './utils/appSettings'
import type { ComboLimitValue, NearLimitValue } from './utils/appSettings'
import './gear.css'

// ── データ更新ステート ─────────────────────────────────────────
type UpdatePhase = 'idle' | 'checking' | 'waiting-login' | 'fetching' | 'error'

/** データ更新のクールダウン時間（ミリ秒） */
const UPDATE_COOLDOWN_MS = 5 * 60 * 1000

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
  { key: 'skill',  label: 'ギアパワー' },
  { key: 'name',   label: '名前' },
  { key: 'rarity', label: 'レア度' },
  { key: 'exp',    label: 'ケイケン値' },
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

        // サブキー1: サブパワーの数（多い順）
        const aSubCount = a.additional_skills.filter(s => s.id !== -1).length
        const bSubCount = b.additional_skills.filter(s => s.id !== -1).length
        if (aSubCount !== bSubCount) return bSubCount - aSubCount

        // サブキー2: サブパワーのスキルID順（左から、スタック型表示順）
        for (let i = 0; i < 3; i++) {
          const aSubId = a.additional_skills[i]?.id ?? -1
          const bSubId = b.additional_skills[i]?.id ?? -1
          if (aSubId === bSubId) continue
          if (aSubId === -1) return 1
          if (bSubId === -1) return -1
          const ra = getStackableSkillSortRank(aSubId)
          const rb = getStackableSkillSortRank(bSubId)
          if (ra !== rb) return ra - rb
          if (aSubId !== bSubId) return aSubId - bSubId
        }
        return 0
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

  // アキ枠: N個以上
  if (filter.akiMin > 0) {
    result = result.filter(gear =>
      gear.additional_skills.filter(s => s.id === -1).length >= filter.akiMin
    )
  }

  return result
}

/**
 * ギアセクション（splabo v2.0 Phase B1）。
 *
 * 旧 geartoon 単体アプリの `App.tsx` を chartoon シェルのセクションとして取り込んだもの。
 * ルート要素は `className="gear-root"` で、CSS（gear.css）はこのスコープに閉じている。
 *
 * chartoon シェルへ委譲した要素（本コンポーネントには含めない）:
 *  - ログインフロー（doLoginFlow / start_login / nxapi_setup）→ chartoon 側の deep-link 認証に一本化
 *  - About / Logo / SettingsDialog モーダル → 設定タブ統合は B2 で対応
 *
 * ギア取得（fetch_gear_full）は Phase A2 で Rust GraphQL 化済み。ログイン確認は chartoon の
 * `check_auth_status` を使う。未ログイン・データ無しでもクラッシュせず空状態を描画する。
 */
export function GearSection() {
  const { data, loading, error, lastFetchedAt, reload } = useGearDB()
  const [activeTab, setActiveTab]   = useState<GearCategory>('head')

  // マウント後に保存済みテーマ・密度を `.gear-root` に適用（chartoon の :root は汚さない）
  useEffect(() => {
    initAppSettings()
  }, [])

  // ── データ更新フロー ──────────────────────────────────────
  const [updatePhase, setUpdatePhase] = useState<UpdatePhase>('idle')
  const [updateError, setUpdateError] = useState<string | null>(null)

  // クールダウン: lastFetchedAt から UPDATE_COOLDOWN_MS 経過するまで更新不可
  // now を state として持ち、クールダウン終了時に setTimeout で再レンダリングする
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!lastFetchedAt) return
    const remaining = lastFetchedAt.getTime() + UPDATE_COOLDOWN_MS - Date.now()
    if (remaining <= 0) return
    const id = setTimeout(() => setNow(Date.now()), remaining + 100)
    return () => clearTimeout(id)
  }, [lastFetchedAt])

  const cooldownRemainingMs = lastFetchedAt
    ? Math.max(0, lastFetchedAt.getTime() + UPDATE_COOLDOWN_MS - now)
    : 0
  const isCoolingDown = cooldownRemainingMs > 0

  const handleDataUpdate = useCallback(async () => {
    if (!isTauri()) return
    if (updatePhase !== 'idle' && updatePhase !== 'error') return
    if (isCoolingDown) return

    setUpdatePhase('checking')
    setUpdateError(null)

    try {
      const { invoke } = await import('@tauri-apps/api/core')

      // 1. chartoon 認証（Nintendo ログイン）済みか確認
      //    未ログインなら chartoon シェル（設定タブ）でのログインを促す。
      //    B1 ではギアセクション内にログインフローは持たない（認証は chartoon 側に一本化）。
      const loggedIn = await invoke<boolean>('check_auth_status').catch(() => false)

      if (!loggedIn) {
        // TODO(B1): ログインは chartoon 設定タブに委譲。ここでは案内のみ。
        setUpdateError('Nintendo アカウントにログインしていません。「設定」タブからログインしてください。')
        setUpdatePhase('error')
        return
      }

      // 2. SplatNet3 からギアデータを取得（Phase A2 の Rust GraphQL 経路）
      setUpdatePhase('fetching')
      await invoke('fetch_gear_full')

      // 3. 取得日時を保存してから UI を再読み込み
      saveLastFetchedAt(new Date())
      reload()
      setUpdatePhase('idle')
    } catch (e) {
      setUpdateError(String(e))
      setUpdatePhase('error')
    }
  }, [updatePhase, isCoolingDown, reload])
  const [sortKey, setSortKey]       = useState<SortKey>('name')
  const [drawerOpen, setDrawerOpen]       = useState(false)
  const [comboLimit] = useState<ComboLimitValue>(loadComboLimit)
  const [nearLimit]  = useState<NearLimitValue>(loadNearLimit)

  const [filter, setFilter]               = useState<FilterState>(emptyFilter)
  const [comboOpen, setComboOpen]   = useState(false)
  const [comboSlots, setComboSlots] = useState<ComboSlots>(emptySlots)
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

  // アキ枠スキル画像（スキル辞書の id:-1 エントリから取得）
  const emptySkillImage = data?.skills?.[-1]?.image ?? ''

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

  /** 全ブランド（五十音順・重複なし、ロゴは代表ギアの brand_image） */
  const allBrands = useMemo(() => {
    if (!data) return [] as { name: string; image: string }[]
    const imageByBrand = new Map<string, string>()
    for (const cat of ['head', 'clothing', 'shoes'] as GearCategory[]) {
      for (const gear of data[cat]) {
        if (!imageByBrand.has(gear.brand)) imageByBrand.set(gear.brand, gear.brand_image)
      }
    }
    return [...imageByBrand.entries()]
      .map(([name, image]) => ({ name, image }))
      .sort((a, b) => a.name.localeCompare(b.name, 'ja'))
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

  const handleSetAkiMin = useCallback((n: number) =>
    setFilter(prev => ({ ...prev, akiMin: n })), [])

  const handleReset = useCallback(() => setFilter(emptyFilter()), [])

  // ── コーデ ──────────────────────────────────────────────────

  /** カードタップ → 現在タブのスロットに入れる（タブは自動遷移しない） */
  const handleSelectForCombo = useCallback((gear: GearItem) => {
    setComboSlots(prev => ({ ...prev, [activeTab]: gear }))
  }, [activeTab])

  const handleRestoreComboSlot = useCallback((cat: GearCategory, gear: GearItem) => {
    setComboSlots(prev => ({ ...prev, [cat]: gear }))
  }, [])

  /** スロット解除 → そのカテゴリのタブに戻して再選択しやすくする */
  const handleClearComboSlot = useCallback((cat: GearCategory) => {
    setComboSlots(prev => ({ ...prev, [cat]: null }))
    setActiveTab(cat)
  }, [])

  const handleClearAllComboSlots = useCallback(() => {
    setComboSlots(emptySlots())
  }, [])

  /** コーデ候補をタップしてスロットに適用 */
  const handleApplyCombo = useCallback((combo: ComboResult) => {
    setComboSlots({ head: combo.head, clothing: combo.clothing, shoes: combo.shoes })
  }, [])

  const activeFilterCount = countActiveFilters(filter)

  if (loading) return <div className="gear-root"><div className="status">ギアデータを読み込み中...</div></div>
  if (error || !data) {
    return (
      <div className="gear-root">
        <div className="empty-state">
          <div className="empty-state__icon">{error ? '⚠️' : '📭'}</div>
          <p className="empty-state__title">
            {error ? 'データの読み込みに失敗しました' : 'ギアデータがありません'}
          </p>
          <p className="empty-state__body">
            {error && <><span className="empty-state__detail">{error}</span><br /></>}
            「データ更新」ボタンから SplatNet3 のギアデータを取得してください。
          </p>
          {isTauri() && (
            <button
              type="button"
              className={`app-db-refresh app-db-refresh--empty-cta${updatePhase !== 'idle' && updatePhase !== 'error' ? ' app-db-refresh--busy' : ''}`}
              onClick={handleDataUpdate}
              disabled={(updatePhase !== 'idle' && updatePhase !== 'error') || isCoolingDown}
            >
              {updatePhase === 'checking' ? '確認中...' :
               updatePhase === 'waiting-login' ? 'ログイン待機中...' :
               updatePhase === 'fetching' ? 'データ取得中...' :
               '認証・データ取得'}
            </button>
          )}
          {updateError && (
            <p className="app-update-error" role="alert">
              <span className="app-update-error__icon">⚠️</span>
              {updateError}
              <button
                type="button"
                className="app-update-error__dismiss"
                onClick={() => { setUpdateError(null); setUpdatePhase('idle') }}
                aria-label="エラーを閉じる"
              >✕</button>
            </p>
          )}
        </div>
      </div>
    )
  }

  const total = data.head.length + data.clothing.length + data.shoes.length

  return (
    <div className="gear-root">
      <div className={`app${comboOpen ? ' app--combo-open' : ''}`}>
        <div ref={appTopRef} className="app-top app-top--sticky">
          <header className="app-header">
            <div className="app-header__left">
              <p className="app-subtitle">Splatoon 3 Gear Wardrobe</p>
            </div>
            <div className="app-header__right">
              <div className="app-header__toolbar">
                <span
                  className="app-db-counter"
                  aria-label={`データに収録されている全ギアは ${total.toLocaleString()} 件です`}
                >
                  {`全${total.toLocaleString()}ギア取得`}
                </span>
                <button
                  type="button"
                  className={`app-db-refresh${updatePhase !== 'idle' && updatePhase !== 'error' ? ' app-db-refresh--busy' : ''}`}
                  onClick={handleDataUpdate}
                  disabled={(updatePhase !== 'idle' && updatePhase !== 'error') || isCoolingDown}
                  title={
                    !isTauri() ? 'Tauri アプリ上でのみ利用できます' :
                    isCoolingDown ? '前回の更新から5分以内は再更新できません' :
                    updatePhase === 'waiting-login' ? 'ブラウザでログイン中... 完了後に自動的に続行します' :
                    updatePhase === 'fetching' ? 'SplatNet3 からデータを取得中...' :
                    updatePhase === 'checking' ? 'ログイン状態を確認中...' :
                    'SplatNet3 からギアデータを取得する'
                  }
                >
                  {updatePhase === 'checking' ? '確認中...' :
                   updatePhase === 'waiting-login' ? 'ログイン待機中...' :
                   updatePhase === 'fetching' ? 'データ取得中...' :
                   'データ更新'}
                </button>
              </div>
              {updateError && (
                <p className="app-update-error" role="alert">
                  <span className="app-update-error__icon">⚠️</span>
                  {updateError}
                  <button
                    type="button"
                    className="app-update-error__dismiss"
                    onClick={() => { setUpdateError(null); setUpdatePhase('idle') }}
                    aria-label="エラーを閉じる"
                  >✕</button>
                </p>
              )}
              <p className="app-db-meta">
                <span className="app-db-meta__inner">
                  <span className="app-db-meta__label">最終更新:</span>
                  <span className="app-db-meta__value">
                    {lastFetchedAt
                      ? lastFetchedAt.toLocaleString('ja-JP', {
                          year: 'numeric',
                          month: '2-digit',
                          day: '2-digit',
                          hour: '2-digit',
                          minute: '2-digit',
                          second: '2-digit',
                        })
                      : '—'}
                  </span>
                </span>
              </p>
            </div>
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

        <div className={`gear-grid${comboOpen ? ' gear-grid--combo-mode' : ''}`}>
          {items.map((gear) => (
            <GearCard
              key={gear.id}
              gear={gear}
              selected={comboOpen && comboSlots[activeTab]?.id === gear.id}
              onSelect={comboOpen ? () => handleSelectForCombo(gear) : undefined}
            />
          ))}
          {items.length === 0 && (
            <div className="status">該当するギアがありません</div>
          )}
        </div>

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

        <ComboSheet
          data={data}
          slots={comboSlots}
          onClearSlot={handleClearComboSlot}
          onRestoreSlot={handleRestoreComboSlot}
          onClearAll={handleClearAllComboSlots}
          onApplyCombo={handleApplyCombo}
          onIsOpenChange={setComboOpen}
          emptySkillImage={emptySkillImage}
          comboLimit={comboLimit}
          nearLimit={nearLimit}
        />

        <FilterDrawer
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          activeTab={activeTab}
          allSkills={allSkills}
          allBrands={allBrands}
          filter={filter}
          onToggleMainOnly={handleToggleMainOnly}
          onSetSkillPoints={handleSetSkillPoints}
          onSetAkiMin={handleSetAkiMin}
          onToggleBrand={handleToggleBrand}
          onClearBrands={handleClearBrands}
          onReset={handleReset}
          emptySkillImage={emptySkillImage}
        />
      </div>
    </div>
  )
}
