import { useMemo } from 'react'
import type { GearCategory, Skill } from '../types'
import { isMainOnly, MAIN_ONLY_SKILL_CATEGORY, getMainOnlySkillSortRank, getStackableSkillSortRank } from '../constants/gearPowerMeta'

// スタック型のスナップ値（スプラ仕様: サブ3pt × 最大3 + メイン10pt）
const STEP_VALUES = [0, 3, 6, 9, 10, 13, 16, 19] as const

export interface FilterState {
  /** メインのみ型: ON にしたスキルID */
  mainOnlyIds: Set<number>
  /** スタック型: skillId → 最低pt（0 または未登録 = フィルターなし） */
  skillMinPoints: Map<number, number>
  /** ブランド絞り込み */
  brands: Set<string>
  /** アキ枠の最低個数（0 = フィルターなし） */
  akiMin: number
}

export function emptyFilter(): FilterState {
  return {
    mainOnlyIds: new Set(),
    skillMinPoints: new Map(),
    brands: new Set(),
    akiMin: 0,
  }
}

/** アクティブなフィルター数（バッジ用） */
export function countActiveFilters(f: FilterState): number {
  const activePoints = [...f.skillMinPoints.values()].filter(v => v > 0).length
  return f.mainOnlyIds.size + activePoints + f.brands.size + (f.akiMin > 0 ? 1 : 0)
}

export interface BrandFilterOption {
  name: string
  image: string
}

interface Props {
  open: boolean
  onClose: () => void
  activeTab: GearCategory
  allSkills: Skill[]
  allBrands: BrandFilterOption[]
  filter: FilterState
  onToggleMainOnly: (id: number) => void
  onSetSkillPoints: (id: number, points: number) => void
  onSetAkiMin: (n: number) => void
  onToggleBrand: (brand: string) => void
  onClearBrands: () => void
  onReset: () => void
}

function stepUp(current: number): number {
  const idx = STEP_VALUES.indexOf(current as typeof STEP_VALUES[number])
  return idx < STEP_VALUES.length - 1 ? STEP_VALUES[idx + 1] : current
}

function stepDown(current: number): number {
  const idx = STEP_VALUES.indexOf(current as typeof STEP_VALUES[number])
  return idx > 0 ? STEP_VALUES[idx - 1] : 0
}

function stepMax(maxAllowed: number): number {
  return [...STEP_VALUES].filter(x => x <= maxAllowed).pop() ?? 0
}

export function FilterDrawer({
  open,
  onClose,
  activeTab,
  allSkills,
  allBrands,
  filter,
  onToggleMainOnly,
  onSetSkillPoints,
  onSetAkiMin,
  onToggleBrand,
  onClearBrands,
  onReset,
}: Props) {
  // 現在のタブに対応する発動型スキルのみ表示
  const mainOnlySkills = useMemo(
    () => allSkills
      .filter(s => isMainOnly(s.id) && MAIN_ONLY_SKILL_CATEGORY[s.id] === activeTab)
      .toSorted((a, b) => {
        const ra = getMainOnlySkillSortRank(a.id, activeTab)
        const rb = getMainOnlySkillSortRank(b.id, activeTab)
        if (ra !== rb) return ra - rb
        return a.id - b.id
      }),
    [allSkills, activeTab],
  )
  const stackableSkills = useMemo(
    () => allSkills
      .filter(s => !isMainOnly(s.id))
      .toSorted((a, b) => {
        const ra = getStackableSkillSortRank(a.id)
        const rb = getStackableSkillSortRank(b.id)
        if (ra !== rb) return ra - rb
        return a.id - b.id
      }),
    [allSkills],
  )
  const activeCount = countActiveFilters(filter)

  // 発動型 = 10pt 固定。スタック型との合計が 19pt を超えないよう制限
  const mainOnlyPts = filter.mainOnlyIds.size > 0 ? 10 : 0
  const stackTotalPts = [...filter.skillMinPoints.values()].reduce((sum, v) => sum + v, 0)
  // アキ枠はサブスロット相当（×3pt）としてバジェットから差し引く
  const ptsBudget = 19 - mainOnlyPts - filter.akiMin * 3
  // スタック型で10pt以上使っている = メインスロット使用中 → 発動型は選べない
  const mainSlotUsedByStack = stackTotalPts >= 10

  return (
    <>
      {/* オーバーレイ */}
      <div
        className={`drawer-overlay ${open ? 'drawer-overlay--visible' : ''}`}
        onClick={onClose}
        aria-hidden="true"
      />

      {/* ドロワー本体 */}
      <div
        className={`drawer ${open ? 'drawer--open' : ''}`}
        role="dialog"
        aria-label="絞り込み設定"
        aria-modal="true"
      >
        {/* ヘッダー */}
        <div className="drawer-header">
          <span className="drawer-title">絞り込み</span>
          <div className="drawer-header__actions">
            {activeCount > 0 && (
              <button className="drawer-reset" onClick={onReset}>
                リセット
              </button>
            )}
            <button className="drawer-close" onClick={onClose} aria-label="閉じる">
              ✕
            </button>
          </div>
        </div>

        {/* 本文 */}
        <div className="drawer-body">

          {/* 発動型 */}
          <section className="drawer-section">
            <div className="drawer-section__label">
              発動型
              <span className="drawer-section__note">1つだけ選択</span>
            </div>
            <div className="skill-chips">
              {mainOnlySkills.map(s => {
                const isActive = filter.mainOnlyIds.has(s.id)
                const isDisabled = !isActive && mainSlotUsedByStack
                return (
                  <button
                    key={s.id}
                    className={`skill-chip ${isActive ? 'skill-chip--active' : ''} ${isDisabled ? 'skill-chip--disabled' : ''}`}
                    onClick={() => !isDisabled && onToggleMainOnly(s.id)}
                    disabled={isDisabled}
                    title={s.name}
                  >
                    <img src={`/data/${s.image}`} alt="" aria-hidden="true" />
                    <span>{s.name}</span>
                  </button>
                )
              })}
            </div>
          </section>

          {/* スタック型 */}
          <section className="drawer-section">
            <div className="drawer-section__label">
              スタック型
              <span className="drawer-section__note">メイン 10pt / サブ 3pt</span>
            </div>
            <div className="skill-chips">
              {stackableSkills.map(s => {
                const pts = filter.skillMinPoints.get(s.id) ?? 0
                const isActive = pts > 0
                const nextPts = stepUp(pts)
                const disableIncrease = nextPts === pts || (stackTotalPts - pts + nextPts) > ptsBudget
                return (
                  <div
                    key={s.id}
                    className={`skill-chip skill-chip--stepper ${isActive ? 'skill-chip--active' : ''}`}
                  >
                    <img src={`/data/${s.image}`} alt="" aria-hidden="true" />
                    <span className="skill-chip__name">{s.name}</span>
                    <div className="stepper">
                      <button
                        className="stepper__btn"
                        onClick={e => onSetSkillPoints(s.id, e.shiftKey ? 0 : stepDown(pts))}
                        disabled={pts === 0}
                        aria-label={`${s.name} を下げる`}
                      >
                        −
                      </button>
                      <span className="stepper__value">
                        {pts === 0 ? '−' : `${pts}pt`}
                      </span>
                      <button
                        className="stepper__btn"
                        onClick={e => onSetSkillPoints(s.id, e.shiftKey ? stepMax(ptsBudget - (stackTotalPts - pts)) : stepUp(pts))}
                        disabled={disableIncrease}
                        aria-label={`${s.name} を上げる`}
                      >
                        ＋
                      </button>
                    </div>
                  </div>
                )
              })}
              {/* アキ枠（スタック型と同列） */}
              <div className={`skill-chip skill-chip--stepper ${filter.akiMin > 0 ? 'skill-chip--active' : ''}`}>
                <img src="/data/images/skill/dc937b59892604f5a86ac96936cd7ff09e25f18ae6b758e8014a24c7fa039e91_0.png" alt="" aria-hidden="true" />
                <span className="skill-chip__name">アキ</span>
                <div className="stepper">
                  <button
                    className="stepper__btn"
                    onClick={e => onSetAkiMin(e.shiftKey ? 0 : Math.max(0, filter.akiMin - 1))}
                    disabled={filter.akiMin === 0}
                    aria-label="アキ枠を減らす"
                  >−</button>
                  <span className="stepper__value">{filter.akiMin === 0 ? '−' : filter.akiMin}</span>
                  <button
                    className="stepper__btn"
                    onClick={e => onSetAkiMin(e.shiftKey ? 3 : Math.min(3, filter.akiMin + 1))}
                    disabled={filter.akiMin >= 3 || ptsBudget - 3 < 0}
                    aria-label="アキ枠を増やす"
                  >＋</button>
                </div>
              </div>
            </div>
          </section>

          {/* ブランド */}
          <section className="drawer-section">
            <div className="drawer-section__label">
              ブランド
              {filter.brands.size > 0 && (
                <button
                  className="drawer-section__clear"
                  onClick={onClearBrands}
                >
                  クリア
                </button>
              )}
            </div>
            <div className="brand-chips">
              {allBrands.map(({ name, image }) => (
                <button
                  key={name}
                  type="button"
                  className={`brand-chip ${filter.brands.has(name) ? 'brand-chip--active' : ''}`}
                  onClick={() => onToggleBrand(name)}
                  title={name}
                >
                  <img className="brand-chip__logo" src={`/data/${image}`} alt="" aria-hidden="true" />
                  <span className="brand-chip__label">{name}</span>
                </button>
              ))}
            </div>
          </section>

        </div>
      </div>
    </>
  )
}
