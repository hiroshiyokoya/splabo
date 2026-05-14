import React, { useState, useMemo, useRef, useEffect } from 'react'
import type { GearCategory, GearItem, GearDB } from '../types'
import { findCombo, MAIN_AP, SUB_AP } from '../utils/findCombo'
import type { ComboResult } from '../utils/findCombo'
import { isMainOnly, MAIN_ONLY_SKILL_CATEGORY, getMainOnlySkillSortRank, getStackableSkillSortRank } from '../constants/gearPowerMeta'

export type ComboSlots = {
  head:     GearItem | null
  clothing: GearItem | null
  shoes:    GearItem | null
}

export const emptySlots = (): ComboSlots => ({ head: null, clothing: null, shoes: null })

// 3ギア合計の意味あるスナップ値 (max 57pt)
// メイン=10pt, サブ=3pt, 1ギア最大=19pt, 3ギア合計最大=57pt
// 10a + 3b (0≤a≤3, 0≤b≤9) で作れる値すべて（重複なし・昇順）
const STEP_VALUES = [
   0,  3,  6,  9, 10, 12, 13, 15, 16, 18,
  19, 20, 21, 22, 23, 24, 25, 26, 27, 28,
  29, 30, 31, 32, 33, 34, 35, 36, 37, 38,
  39, 41, 42, 44, 45, 47, 48, 51, 54, 57,
] as const
function stepUp(v: number) {
  const i = STEP_VALUES.indexOf(v as typeof STEP_VALUES[number])
  return i >= 0 && i < STEP_VALUES.length - 1 ? STEP_VALUES[i + 1] : v
}
function stepDown(v: number) {
  const i = STEP_VALUES.indexOf(v as typeof STEP_VALUES[number])
  return i > 0 ? STEP_VALUES[i - 1] : 0
}
/** v を達成するのに最低何メインスロット必要か（不可能なら Infinity） */
function minMainsNeeded(v: number): number {
  for (let a = 0; a <= 3; a++) {
    const rem = v - 10 * a
    if (rem >= 0 && rem % 3 === 0 && rem / 3 <= 9) return a
  }
  return Infinity
}

/** 選択された 3 ギアの合計 AP をスキルID ごとに集計 */
function calcTotalAp(slots: ComboSlots): Map<number, { name: string; ap: number; image: string }> {
  const result = new Map<number, { name: string; ap: number; image: string }>()
  const gears = [slots.head, slots.clothing, slots.shoes].filter(Boolean) as GearItem[]
  const add = (skill: { id: number; name: string; image: string }, pts: number) => {
    if (skill.id === -1) return
    const prev = result.get(skill.id)
    if (prev) prev.ap += pts
    else result.set(skill.id, { name: skill.name, ap: pts, image: skill.image })
  }
  for (const gear of gears) {
    add(gear.primary_skill, MAIN_AP)
    for (const sub of gear.additional_skills) add(sub, SUB_AP)
  }
  return result
}

const CAT_ICON: Record<GearCategory, string> = { head: '🪖', clothing: '👕', shoes: '👟' }
const CAT_LABEL: Record<GearCategory, string> = { head: '頭', clothing: '服', shoes: '靴' }

interface Props {
  data:             GearDB
  slots:            ComboSlots
  onClearSlot:      (cat: GearCategory) => void
  onClearAll:       () => void
  onApplyCombo:     (combo: ComboResult) => void
  /** シートが開いた/閉じたときに通知（peekは閉じた扱い） */
  onIsOpenChange?:  (open: boolean) => void
}

export function ComboSheet({ data, slots, onClearSlot, onClearAll, onApplyCombo, onIsOpenChange }: Props) {
  const [isOpen, setIsOpen]             = useState(false)
  const [snapExpanded, setSnapExpanded] = useState(false)
  const [skillPoints, setSkillPoints]   = useState<Map<number, number>>(new Map())
  const sheetRef = useRef<HTMLDivElement>(null)
  const drag     = useRef<{ startY: number; startH: number; moved: boolean } | null>(null)

  useEffect(() => { onIsOpenChange?.(isOpen) }, [isOpen])
  // 発動型: カテゴリごとに選択中のスキルID (null = 未選択)
  const [mainOnlySel, setMainOnlySel] = useState<Record<GearCategory, number | null>>({
    head: null, clothing: null, shoes: null,
  })
  const [comboResults, setComboResults] = useState<ComboResult[] | null>(null)
  const [searching, setSearching]       = useState(false)

  const totalAp   = useMemo(() => calcTotalAp(slots), [slots])
  const anyFilled = slots.head !== null || slots.clothing !== null || slots.shoes !== null

  // DB からスタック型スキル一覧
  const stackableSkills = useMemo(() => {
    const map = new Map<number, { name: string; image: string }>()
    for (const cat of ['head', 'clothing', 'shoes'] as GearCategory[]) {
      for (const gear of data[cat]) {
        const s = gear.primary_skill
        if (s.id !== -1 && !isMainOnly(s.id)) map.set(s.id, { name: s.name, image: s.image })
        for (const sub of gear.additional_skills) {
          if (sub.id !== -1 && !isMainOnly(sub.id)) map.set(sub.id, { name: sub.name, image: sub.image })
        }
      }
    }
    return [...map.entries()]
      .sort(([a], [b]) => getStackableSkillSortRank(a) - getStackableSkillSortRank(b) || a - b)
      .map(([id, { name, image }]) => ({ id, name, image }))
  }, [data])

  // DB から発動型スキル一覧（カテゴリ別）
  const mainOnlyByCategory = useMemo(() => {
    const result: Record<GearCategory, Array<{ id: number; name: string; image: string }>> = {
      head: [], clothing: [], shoes: [],
    }
    const seen = new Set<number>()
    for (const cat of ['head', 'clothing', 'shoes'] as GearCategory[]) {
      for (const gear of data[cat]) {
        const s = gear.primary_skill
        if (s.id !== -1 && isMainOnly(s.id) && !seen.has(s.id)) {
          seen.add(s.id)
          const skillCat = MAIN_ONLY_SKILL_CATEGORY[s.id]
          if (skillCat) {
            const rank = getMainOnlySkillSortRank(s.id, skillCat)
            result[skillCat].push({ id: s.id, name: s.name, image: s.image, rank } as typeof result[GearCategory][number] & { rank: number })
          }
        }
      }
    }
    for (const cat of ['head', 'clothing', 'shoes'] as GearCategory[]) {
      result[cat].sort((a, b) => {
        const ra = getMainOnlySkillSortRank(a.id, cat)
        const rb = getMainOnlySkillSortRank(b.id, cat)
        return ra - rb || a.id - b.id
      })
    }
    return result
  }, [data])

  const activeRequirements =
    [...skillPoints.values()].filter(v => v > 0).length +
    Object.values(mainOnlySel).filter(v => v !== null).length

  // ── AP プール制約ロジック ──
  // 選択中の発動型数（0〜3）。発動型はメインスロット1枠=10APを占有する
  const numMainOnly = (Object.values(mainOnlySel) as (number | null)[]).filter(v => v !== null).length
  // スタック型に使えるAPプール = 空きメインスロット×10 + サブスロット9枠×3
  const stackablePool = (3 - numMainOnly) * 10 + 27
  // 現在スタック型に割り当てたAP合計
  const allocatedStackable = [...skillPoints.values()].reduce((s, v) => s + v, 0)
  // 残りプール（スタック型間で再配分可能）
  const remainingPool = stackablePool - allocatedStackable
  // 発動型を新たに選べるか（残り10AP以上 & 空きカテゴリあり）
  const canSelectMainOnly = remainingPool >= 10
  // スタック型に使えるメインスロット数
  const aAvail = 3 - numMainOnly

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    const h = sheetRef.current?.offsetHeight ?? 320
    drag.current = { startY: e.clientY, startH: h, moved: false }
    if (sheetRef.current) {
      sheetRef.current.style.transition = 'none'
      sheetRef.current.style.height = `${h}px`
    }
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current || !sheetRef.current) return
    const delta = drag.current.startY - e.clientY
    if (Math.abs(delta) > 8) drag.current.moved = true
    sheetRef.current.style.height = `${Math.max(0, Math.min(window.innerHeight * 0.92, drag.current.startH + delta))}px`
  }

  const handlePointerUp = (_e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    const { moved } = drag.current
    drag.current = null
    const currentH = sheetRef.current?.offsetHeight ?? 320
    if (sheetRef.current) {
      sheetRef.current.style.transition = ''
      sheetRef.current.style.height = ''
    }
    if (!moved) {
      // クリック: peek → open、open ↔ expanded をサイクル
      if (!isOpen) { setIsOpen(true); setSnapExpanded(false); return }
      setSnapExpanded(v => !v)
      return
    }
    // ドラッグ: 高さでスナップ先を決定
    if (currentH < 80) { setIsOpen(false); setSnapExpanded(false); return }
    setIsOpen(true)
    setSnapExpanded(currentH >= (320 + Math.round(window.innerHeight * 0.70)) / 2)
  }

  const handlePointerCancel = () => {
    if (!drag.current) return
    drag.current = null
    if (sheetRef.current) {
      sheetRef.current.style.transition = ''
      sheetRef.current.style.height = ''
    }
  }

  const handleGenerate = () => {
    if (searching || activeRequirements === 0) return

    const requirements = [
      // 発動型
      ...(['head', 'clothing', 'shoes'] as GearCategory[])
        .map(cat => mainOnlySel[cat])
        .filter((id): id is number => id !== null)
        .map(skillId => {
          const skills = Object.values(mainOnlyByCategory).flat()
          const skill = skills.find(s => s.id === skillId)
          return { skillId, skillName: skill?.name ?? '', minAp: MAIN_AP }
        }),
      // スタック型
      ...[...skillPoints.entries()]
        .filter(([, pts]) => pts > 0)
        .map(([skillId, minAp]) => {
          const skill = stackableSkills.find(s => s.id === skillId)
          return { skillId, skillName: skill?.name ?? '', minAp }
        }),
    ]

    setSearching(true)
    setTimeout(() => {
      const results = findCombo(data, requirements, 50)
      setComboResults(results)
      setSearching(false)
    }, 0)
  }

  const handleApplyCombo = (combo: ComboResult) => {
    onApplyCombo(combo)
  }

  const handleClearRequirements = () => {
    setSkillPoints(new Map())
    setMainOnlySel({ head: null, clothing: null, shoes: null })
    setComboResults(null)
  }

  const handleClose = () => {
    setIsOpen(false)
    setSnapExpanded(false)
  }

  const toggleMainOnly = (cat: GearCategory, id: number) => {
    setMainOnlySel(prev => ({
      ...prev,
      [cat]: prev[cat] === id ? null : id,
    }))
    setComboResults(null)
  }

  const renderStackableRow = (s: { id: number; name: string; image: string }) => {
    const pts = skillPoints.get(s.id) ?? 0
    const isActive = pts > 0
    // このスキルに割り当てられる上限 = 現在値 + 残りプール
    const maxPts = pts + remainingPool
    const next = stepUp(pts)
    // +ボタン: 合計プール超過 OR 残りメインスロットで達成不可 の場合は無効
    const canStepUp = next !== pts && next <= maxPts && minMainsNeeded(next) <= aAvail
    return (
      <div key={s.id} className={`combo-skill-row ${isActive ? 'combo-skill-row--active' : ''}`}>
        <img className="combo-skill-row__icon" src={`/data/${s.image}`} alt={s.name} />
        <span className="combo-skill-row__name">{s.name}</span>
        <div className="stepper">
          <button className="stepper__btn"
            onClick={() => { const n = stepDown(pts); setSkillPoints(prev => { const m = new Map(prev); m.set(s.id, n); return m }); setComboResults(null) }}
            disabled={pts === 0}
            aria-label={`${s.name} を下げる`}>−</button>
          <span className="stepper__value">{pts === 0 ? '−' : `${pts}pt`}</span>
          <button className="stepper__btn"
            onClick={() => { setSkillPoints(prev => { const m = new Map(prev); m.set(s.id, next); return m }); setComboResults(null) }}
            disabled={!canStepUp}
            aria-label={`${s.name} を上げる`}>＋</button>
        </div>
      </div>
    )
  }

  return (
    <div className="combo-sheet-container">

      {/* ハンドル: シート本体の上に浮く */}
      <div
        className="combo-sheet__handle-row"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        role="button"
        aria-label={isOpen ? (snapExpanded ? '縮小' : 'コンボ探索を閉じる') : 'コンボ探索を開く'}
        style={{ touchAction: 'none' }}
      >
        <div className="combo-sheet__handle" />
      </div>

      {/* シート本体 */}
      <div
        ref={sheetRef}
        className={`combo-sheet${isOpen ? ' combo-sheet--open' : ''}${snapExpanded ? ' combo-sheet--expanded' : ''}`}
        role="dialog"
        aria-label="コンボ探索"
        aria-modal="false"
      >
        {/* ヘッダー */}
        <div className="combo-sheet__header">
          <span className="combo-sheet__title">🎮 コンボ探索</span>
          <div className="combo-sheet__header-actions">
            {anyFilled && (
              <button className="combo-sheet__clear-btn" onClick={() => { onClearAll(); setComboResults(null) }}>
                クリア
              </button>
            )}
            <button className="combo-sheet__close" onClick={handleClose} aria-label="閉じる">✕</button>
          </div>
        </div>

        <div className="combo-sheet__body">

        {/* ── 3スロット（横並び） ── */}
        <div className="combo-slots">
          {(['head', 'clothing', 'shoes'] as GearCategory[]).map(cat => {
            const gear = slots[cat]
            return (
              <div
                key={cat}
                className={`combo-slot ${gear ? 'combo-slot--filled' : 'combo-slot--empty'}`}
                onClick={() => gear && onClearSlot(cat)}
                role={gear ? 'button' : undefined}
                title={gear ? `${gear.name}（クリックで解除）` : `リストから${CAT_LABEL[cat]}ギアを選択`}
              >
                {gear ? (
                  <>
                    <img className="combo-slot__img" src={`/data/${gear.image}`} alt={gear.name} />
                    <div className="combo-slot__info">
                      <div className="combo-slot__brand-row">
                        <img className="combo-slot__brand-logo" src={`/data/${gear.brand_image}`} alt={gear.brand} />
                        <span className="combo-slot__name">{gear.name}</span>
                      </div>
                      <div className="combo-slot__skills">
                        <div className="combo-slot__skill combo-slot__skill--main" title={gear.primary_skill.name}>
                          <img src={`/data/${gear.primary_skill.image}`} alt={gear.primary_skill.name} />
                        </div>
                        {gear.additional_skills.map((s, i) => (
                          <div key={i} className="combo-slot__skill combo-slot__skill--sub" title={s.name}>
                            <img src={`/data/${s.image}`} alt={s.name} />
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="combo-slot__empty-inner">
                    <span className="combo-slot__empty-icon">{CAT_ICON[cat]}</span>
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {/* 合計 AP バー */}
        <div className="combo-ap-bar">
          {totalAp.size > 0 ? (
            <>
              <span className="combo-ap-bar__label">合計 AP</span>
              <div className="combo-ap-chips">
                {[...totalAp.entries()]
                  .sort(([aId, a], [bId, b]) => {
                    const aMain = isMainOnly(aId)
                    const bMain = isMainOnly(bId)
                    if (aMain && !bMain) return -1
                    if (!aMain && bMain) return 1
                    return b.ap - a.ap
                  })
                  .map(([id, { name, ap, image }]) => (
                    <div key={id} className="combo-ap-chip" title={isMainOnly(id) ? name : `${name}: ${ap}pt`}>
                      <img className="combo-ap-chip__icon" src={`/data/${image}`} alt={name} />
                      {!isMainOnly(id) && <span className="combo-ap-chip__val">{ap}pt</span>}
                    </div>
                  ))}
              </div>
            </>
          ) : (
            <span className="combo-ap-bar__empty">ギアを選ぶと合計 AP が表示されます</span>
          )}
        </div>

        {/* ── 展開時のみ：スキル指定 + 生成 + 結果 ── */}
        {snapExpanded && (
          <>
            <div className="combo-skill-section">
              <div className="combo-skill-section__label">
                目標スキル
                {activeRequirements > 0 && (
                  <button className="combo-skill-section__clear" onClick={handleClearRequirements}>
                    クリア
                  </button>
                )}
              </div>

              {/* 発動型3行 */}
              {(['head', 'clothing', 'shoes'] as GearCategory[]).map(cat => {
                const mainSkills = mainOnlyByCategory[cat]
                if (mainSkills.length === 0) return null
                return (
                  <div key={cat} className="combo-main-only-row">
                    <span className="combo-main-only-row__label">{CAT_LABEL[cat]}ギア:</span>
                    <div className="combo-main-only-chips">
                      {mainSkills.map(s => {
                        const isSelected = mainOnlySel[cat] === s.id
                        // 未選択カテゴリへの新規追加は残りプール10以上が必要
                        // 選択済み（デセレクト or 同カテゴリ切替）は常に可
                        const isDisabled = !isSelected && mainOnlySel[cat] === null && !canSelectMainOnly
                        return (
                          <button
                            key={s.id}
                            className={`combo-main-only-chip ${isSelected ? 'combo-main-only-chip--active' : ''}`}
                            onClick={() => !isDisabled && toggleMainOnly(cat, s.id)}
                            disabled={isDisabled}
                            title={isDisabled ? `残りAP不足（あと${10 - remainingPool}pt必要）` : s.name}
                          >
                            <img src={`/data/${s.image}`} alt={s.name} />
                            <span>{s.name}</span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )
              })}

              {/* スタック型 全14個を3列グリッドで */}
              <div className="combo-stackable-grid">
                {stackableSkills.map(s => renderStackableRow(s))}
              </div>
            </div>

            {/* コンボ生成ボタン */}
            <div className="combo-sheet__actions">
              <button
                className="combo-gen-btn"
                onClick={handleGenerate}
                disabled={activeRequirements === 0 || searching}
              >
                {searching ? '🔍 探索中...' : '⚡ コンボ生成'}
              </button>
              {activeRequirements === 0 && (
                <span className="combo-gen-hint">目標スキルを指定してください</span>
              )}
            </div>

            {/* 結果リスト */}
            {comboResults !== null && (
              <div className="combo-results">
                <div className="combo-results__count">
                  {comboResults.length === 0
                    ? '条件に合う組み合わせが見つかりませんでした'
                    : `${comboResults.length} 件の候補（タップで適用）`}
                </div>
                <div className="combo-results__list">
                  {comboResults.map((combo, i) => (
                    <button
                      key={i}
                      className={`combo-result-row ${i === 0 ? 'combo-result-row--best' : ''}`}
                      onClick={() => handleApplyCombo(combo)}
                    >
                      {i === 0 && <span className="combo-result-row__badge">ベスト</span>}
                      <div className="combo-result-row__gears">
                        <img src={`/data/${combo.head.image}`}     alt={combo.head.name}     title={combo.head.name} />
                        <span className="combo-result-row__plus">+</span>
                        <img src={`/data/${combo.clothing.image}`} alt={combo.clothing.name} title={combo.clothing.name} />
                        <span className="combo-result-row__plus">+</span>
                        <img src={`/data/${combo.shoes.image}`}    alt={combo.shoes.name}    title={combo.shoes.name} />
                      </div>
                      <div className="combo-result-row__ap">
                        {Object.entries(combo.totalAp)
                          .sort(([aId, aAp], [bId, bAp]) => {
                            const aMain = isMainOnly(Number(aId))
                            const bMain = isMainOnly(Number(bId))
                            if (aMain && !bMain) return -1
                            if (!aMain && bMain) return 1
                            return bAp - aAp
                          })
                          .map(([skillIdStr, ap]) => {
                            const sid = Number(skillIdStr)
                            const mainOnly = isMainOnly(sid)
                            const info = stackableSkills.find(s => s.id === sid)
                              ?? Object.values(mainOnlyByCategory).flat().find(s => s.id === sid)
                            return info ? (
                              <div key={skillIdStr} className="combo-result-ap-chip">
                                <img src={`/data/${info.image}`} alt={info.name} title={info.name} />
                                {!mainOnly && <span>{ap}pt</span>}
                              </div>
                            ) : null
                          })}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        </div>
      </div>
    </div>
  )
}
