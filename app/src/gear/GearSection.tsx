import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
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
import { formatInvokeError } from '../utils/notify'
import './gear.css'

// ── 空状態 CTA 用のギア取得ステート ─────────────────────────
// ログイン（waiting-login）は chartoon シェルの deep-link 認証に一本化したため、
// ギアセクションのフェーズは checking（認証確認）→ fetching（取得）→ idle/error のみ。
// データがある通常表示には「データ更新」ボタンは無い（サイドバー「最新データを取得」を使う）。
type UpdatePhase = 'idle' | 'checking' | 'fetching' | 'error'

/** 空状態からのギア再取得クールダウン（ミリ秒） */
const UPDATE_COOLDOWN_MS = 5 * 60 * 1000

const SCROLL_TOP_THRESHOLD = 600
const SCROLL_TOP_HIDE_AFTER_MS = 1000

type SortKey = 'name' | 'rarity' | 'exp' | 'brand' | 'skill'

function gearTabs(t: (key: string) => string): { key: GearCategory; label: string; icon: string }[] {
  return [
    { key: 'head',     label: t('gear.tab.head'),     icon: '🪖' },
    { key: 'clothing', label: t('gear.tab.clothing'), icon: '👕' },
    { key: 'shoes',    label: t('gear.tab.shoes'),    icon: '👟' },
  ]
}

function sortOptions(t: (key: string) => string): { key: SortKey; label: string }[] {
  return [
    { key: 'brand',  label: t('gear.sort.brand') },
    { key: 'skill',  label: t('gear.sort.skill') },
    { key: 'name',   label: t('gear.sort.name') },
    { key: 'rarity', label: t('gear.sort.rarity') },
    { key: 'exp',    label: t('gear.sort.exp') },
  ]
}

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
 * ギアセクション（splabo v0.8 Phase B1）。
 *
 * 旧 geartoon 単体アプリの `App.tsx` を chartoon シェルのセクションとして取り込んだもの。
 * ルート要素は `className="gear-root"` で、CSS（gear.css）はこのスコープに閉じている。
 *
 * シェルへ委譲済み（本コンポーネントには含めない）:
 *  - ログインフロー（doLoginFlow / start_login / nxapi_setup）→ deep-link 認証に一本化
 *  - About / Logo / SettingsDialog モーダル → 設定タブへ統合済み
 *
 * ギア取得（fetch_gear_full）は Phase A2 で Rust GraphQL 化済み。ログイン確認は
 * `check_auth_status` を使う。未ログイン・データ無しでもクラッシュせず空状態を描画する。
 */
export function GearSection() {
  const { t } = useTranslation()
  const { data, loading, error, lastFetchedAt, reload } = useGearDB()
  const tabs = useMemo(() => gearTabs(t), [t])
  const sortOpts = useMemo(() => sortOptions(t), [t])
  const [activeTab, setActiveTab]   = useState<GearCategory>('head')

  // マウント後に保存済みテーマ・密度を `.gear-root` に適用（chartoon の :root は汚さない）
  useEffect(() => {
    initAppSettings()
  }, [])

  // どこからギアを取得しても（サイドバーの「最新データを取得」/ 空状態の「認証・データ取得」/
  // 起動時・自動取得 / コンパニオン更新）、Rust が発火する gear_updated イベントで
  // 最終取得日時の更新と一覧の再読み込みを一元化する。
  useEffect(() => {
    if (!isTauri()) return
    let un: (() => void) | undefined
    void import('@tauri-apps/api/event').then(({ listen }) =>
      listen('gear_updated', () => {
        saveLastFetchedAt(new Date())
        reload()
      }).then((fn) => { un = fn })
    )
    return () => { un?.() }
  }, [reload])

  // ── 空状態 CTA のギア取得フロー ────────────────────────────
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
        // ログインは設定タブに委譲。ここでは案内のみ。
        setUpdateError(t('errors.gearNotLoggedInMessage'))
        setUpdatePhase('error')
        return
      }

      // 2. SplatNet3 からギアデータを取得（Phase A2 の Rust GraphQL 経路）
      setUpdatePhase('fetching')
      await invoke('fetch_gear_full')

      // 3. 取得成功。lastFetchedAt の更新と一覧の再読み込みは gear_updated イベント経由で
      //    行う（サイドバーの一括取得など取得元を問わず同じ経路で反映するため）。
      setUpdatePhase('idle')
    } catch (e) {
      setUpdateError(formatInvokeError(e))
      setUpdatePhase('error')
    }
  }, [updatePhase, isCoolingDown, t])
  const [sortKey, setSortKey]       = useState<SortKey>('brand')
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

  if (loading) return <div className="gear-root"><div className="status">{t('gear.loading')}</div></div>
  if (error || !data) {
    return (
      <div className="gear-root">
        <div className="empty-state">
          <div className="empty-state__icon">{error ? '⚠️' : '📭'}</div>
          <p className="empty-state__title">
            {error ? t('gear.loadFailed') : t('gear.noData')}
          </p>
          <p className="empty-state__body">
            {error && <><span className="empty-state__detail">{error}</span><br /></>}
            {t('gear.emptyHint')}
          </p>
          {isTauri() && (
            <button
              type="button"
              className={`app-db-refresh app-db-refresh--empty-cta${updatePhase !== 'idle' && updatePhase !== 'error' ? ' app-db-refresh--busy' : ''}`}
              onClick={handleDataUpdate}
              disabled={(updatePhase !== 'idle' && updatePhase !== 'error') || isCoolingDown}
            >
              {updatePhase === 'checking' ? t('gear.fetchChecking') :
               updatePhase === 'fetching' ? t('gear.fetchFetching') :
               t('gear.fetchCta')}
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
                aria-label={t('gear.dismissError')}
              >✕</button>
            </p>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="gear-root">
      <div className={`gear-app${comboOpen ? ' gear-app--combo-open' : ''}`}>
        <div ref={appTopRef} className="app-top app-top--sticky">
          {/* 旧アプリ名はメニュー側の「ギア (Geartoon)」に一本化したのでヘッダーごと畳んだ（#419）。
              中身だった総数カウンターは、各タブのバッジ（頭/服/靴それぞれの件数）と
              重複するので出さない。 */}
          <nav className="tabs">
            {tabs.map(({ key, label, icon }) => (
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
              className={`gear-filter-btn ${activeFilterCount > 0 ? 'gear-filter-btn--active' : ''}`}
              onClick={() => setDrawerOpen(true)}
              aria-label={t('gear.filterBtn')}
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
              {t('gear.filterBtn')}
              {activeFilterCount > 0 && (
                <span className="gear-filter-btn__badge">{activeFilterCount}</span>
              )}
            </button>

            <select
              className="sort-select"
              value={sortKey}
              onChange={e => setSortKey(e.target.value as SortKey)}
              aria-label={t('gear.sort.aria')}
            >
              {sortOpts.map(({ key, label }) => (
                <option key={key} value={key}>{label}</option>
              ))}
            </select>
          </nav>
        </div>

        {/* 絞り込み結果カウント */}
        {activeFilterCount > 0 && (
          <div className="filter-result">
            {t('gear.filterResult', { shown: items.length, total: data[activeTab].length })}
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
            <div className="status">{t('gear.noMatch')}</div>
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
            aria-label={t('gear.scrollTop')}
            title={t('gear.scrollTop')}
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
