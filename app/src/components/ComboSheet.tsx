import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react'
import type { GearCategory, GearItem, GearDB } from '../types'
import { findCombo, MAIN_AP, SUB_AP, getComboSortKey, comboBestBadgeKeysEqual } from '../utils/findCombo'
import type { ComboResult, ComboSortKey } from '../utils/findCombo'
import { isMainOnly, MAIN_ONLY_SKILL_CATEGORY, getMainOnlySkillSortRank, getStackableSkillSortRank } from '../constants/gearPowerMeta'

export type ComboSlots = {
  head:     GearItem | null
  clothing: GearItem | null
  shoes:    GearItem | null
}

export const emptySlots = (): ComboSlots => ({ head: null, clothing: null, shoes: null })

/** 削除直後に表示する UNDO ボタンの表示時間（ms） */
const UNDO_BTN_MS = 4500

// 3ギア合計の意味あるスナップ値 (max 57pt)
// メイン=10pt, サブ=3pt, 1ギア最大=19pt, 3ギア合計最大=57pt
// 10a + 3b (0≤a≤3, 0≤b≤9) で作れる値すべて（重複なし・昇順）
const STEP_VALUES = [
   0,  3,  6,  9, 10, 12, 13, 15, 16, 18,
  19, 20, 21, 22, 23, 24, 25, 26, 27, 28,
  29, 30, 31, 32, 33, 34, 35, 36, 37, 38,
  39, 41, 42, 44, 45, 47, 48, 51, 54, 57,
] as const
/** v より大きく、aAvail 以下のメインスロットで達成可能な最小の STEP_VALUE を返す */
function stepUp(v: number, aAvail: number = 3, maxPts: number = 57) {
  return STEP_VALUES.find(x => x > v && x <= maxPts && minMainsNeeded(x) <= aAvail) ?? v
}
/** v より小さく、aAvail 以下のメインスロットで達成可能な最大の STEP_VALUE を返す */
function stepDown(v: number, aAvail: number = 3) {
  return [...STEP_VALUES].reverse().find(x => x < v && minMainsNeeded(x) <= aAvail) ?? 0
}
/** aAvail・maxPts 制約の中で達成可能な最大の STEP_VALUE を返す */
function stepMax(aAvail: number, maxPts: number) {
  return [...STEP_VALUES].reverse().find(x => x <= maxPts && minMainsNeeded(x) <= aAvail) ?? 0
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
  onRestoreSlot:    (cat: GearCategory, gear: GearItem) => void
  onClearAll:       () => void
  onApplyCombo:     (combo: ComboResult) => void
  /** シートが開いた/閉じたときに通知（peekは閉じた扱い） */
  onIsOpenChange?:  (open: boolean) => void
}

export function ComboSheet({ data, slots, onClearSlot, onRestoreSlot, onClearAll, onApplyCombo, onIsOpenChange }: Props) {
  const [isOpen, setIsOpen]             = useState(false)
  const [snapExpanded, setSnapExpanded] = useState(false)
  const [skillPoints, setSkillPoints]   = useState<Map<number, number>>(new Map())
  /** スロット解除直後のみ: 同スロットを再タップで戻すためのスナップショット */
  const [slotUndo, setSlotUndo] = useState<ComboSlots>(emptySlots())
  /** 削除直後のみ true: 丸い UNDO ボタンを表示 */
  const [undoBtnFlash, setUndoBtnFlash] = useState<Record<GearCategory, boolean>>({
    head: false,
    clothing: false,
    shoes: false,
  })
  const sheetRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ startY: number; startH: number; moved: boolean } | null>(null)
  /** 削除直後に表示する UNDO ボタンを消すタイマー（カテゴリ別） */
  const undoBtnTimers = useRef<Partial<Record<GearCategory, ReturnType<typeof setTimeout>>>>({})
  /** スタック型ステッパ長押し: 遅延後に連続変更 */
  const stepperHoldRef = useRef<{ t?: ReturnType<typeof setTimeout>; i?: ReturnType<typeof setInterval> } | null>(null)
  /** 長押しで連続したあと発火する click を1回無視する */
  const stepperIgnoreClickRef = useRef(false)
  /** 長押し tick 内で参照する最新のプール・aAvail（毎レンダーで更新） */
  const comboStepperCtxRef = useRef({ skillPoints, remainingPool: 0, aAvail: 3 })

  useEffect(() => { onIsOpenChange?.(isOpen) }, [isOpen])

  // リストから別ギアが入ったら UNDO スナップショットを破棄。埋まったら UNDO ボタン表示も止める
  useEffect(() => {
    setSlotUndo(prev => {
      const next = { ...prev }
      let dirty = false
      for (const cat of ['head', 'clothing', 'shoes'] as GearCategory[]) {
        const g = slots[cat]
        const u = prev[cat]
        if (g && u && g.id !== u.id) {
          next[cat] = null
          dirty = true
        }
      }
      return dirty ? next : prev
    })
    setUndoBtnFlash(prev => {
      const next = { ...prev }
      let dirty = false
      for (const cat of ['head', 'clothing', 'shoes'] as GearCategory[]) {
        if (slots[cat] && prev[cat]) {
          const t = undoBtnTimers.current[cat]
          if (t != null) {
            clearTimeout(t)
            delete undoBtnTimers.current[cat]
          }
          next[cat] = false
          dirty = true
        }
      }
      return dirty ? next : prev
    })
  }, [slots])

  useEffect(() => {
    return () => {
      for (const cat of ['head', 'clothing', 'shoes'] as GearCategory[]) {
        const t = undoBtnTimers.current[cat]
        if (t != null) clearTimeout(t)
      }
      undoBtnTimers.current = {}
    }
  }, [])

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

  /** 候補行の全スキル表示用（DB上の id → 名称・アイコン） */
  const skillInfoById = useMemo(() => {
    const map = new Map<number, { name: string; image: string }>()
    for (const cat of ['head', 'clothing', 'shoes'] as GearCategory[]) {
      for (const gear of data[cat]) {
        for (const s of [gear.primary_skill, ...gear.additional_skills]) {
          if (s.id !== -1) map.set(s.id, { name: s.name, image: s.image })
        }
      }
    }
    return map
  }, [data])

  /** リスト先頭の満たす候補と targetSum・allSum が同じなら「ベスト」（単体AP配列は見ない） */
  const bestPerfectSortKeys = useMemo((): ComboSortKey | null => {
    if (comboResults === null) return null
    const firstPerfect = comboResults.find(c => c.matchKind !== 'near')
    return firstPerfect ? getComboSortKey(firstPerfect) : null
  }, [comboResults])

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

  comboStepperCtxRef.current = { skillPoints, remainingPool, aAvail }

  const clearStepperHold = useCallback(() => {
    const h = stepperHoldRef.current
    if (!h) return
    if (h.t != null) clearTimeout(h.t)
    if (h.i != null) clearInterval(h.i)
    stepperHoldRef.current = null
  }, [])

  const STEP_HOLD_MS = 340
  const STEP_REPEAT_MS = 82

  const startStepperHold = useCallback((skillId: number, dir: 'up' | 'down') => {
    stepperIgnoreClickRef.current = false
    clearStepperHold()
    const t = setTimeout(() => {
      stepperIgnoreClickRef.current = true
      const tick = () => {
        const ctx = comboStepperCtxRef.current
        const pts = ctx.skillPoints.get(skillId) ?? 0
        if (dir === 'down') {
          const n = stepDown(pts, ctx.aAvail)
          if (n === pts) {
            clearStepperHold()
            return
          }
          setSkillPoints(prev => {
            const m = new Map(prev)
            m.set(skillId, n)
            return m
          })
        }
        else {
          const maxPts = pts + ctx.remainingPool
          const next = stepUp(pts, ctx.aAvail, maxPts)
          if (next === pts) {
            clearStepperHold()
            return
          }
          setSkillPoints(prev => {
            const m = new Map(prev)
            m.set(skillId, next)
            return m
          })
        }
        setComboResults(null)
      }
      tick()
      const i = setInterval(tick, STEP_REPEAT_MS)
      stepperHoldRef.current = { i }
    }, STEP_HOLD_MS)
    stepperHoldRef.current = { t }
  }, [clearStepperHold])

  useEffect(() => () => clearStepperHold(), [clearStepperHold])

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

  const handleClearRequirements = () => {
    setSkillPoints(new Map())
    setMainOnlySel({ head: null, clothing: null, shoes: null })
    setComboResults(null)
  }

  const toggleMainOnly = (cat: GearCategory, id: number) => {
    setMainOnlySel(prev => ({
      ...prev,
      [cat]: prev[cat] === id ? null : id,
    }))
    setComboResults(null)
  }

  const clearUndoFlashTimer = (cat: GearCategory) => {
    const t = undoBtnTimers.current[cat]
    if (t != null) {
      clearTimeout(t)
      delete undoBtnTimers.current[cat]
    }
  }

  /** 埋まっているスロットの削除ボタン用 */
  const handleRemoveSlot = (cat: GearCategory) => {
    const g = slots[cat]
    if (!g) return
    setSlotUndo(prev => ({ ...prev, [cat]: g }))
    onClearSlot(cat)
    clearUndoFlashTimer(cat)
    setUndoBtnFlash(prev => ({ ...prev, [cat]: true }))
    undoBtnTimers.current[cat] = setTimeout(() => {
      setUndoBtnFlash(prev => ({ ...prev, [cat]: false }))
      delete undoBtnTimers.current[cat]
    }, UNDO_BTN_MS)
  }

  /** 削除直後の UNDO ボタン、または空スロットタップで復元 */
  const handleRestoreFromUndo = (cat: GearCategory) => {
    const snap = slotUndo[cat]
    if (!snap) return
    clearUndoFlashTimer(cat)
    setUndoBtnFlash(prev => ({ ...prev, [cat]: false }))
    onRestoreSlot(cat, snap)
    setSlotUndo(prev => ({ ...prev, [cat]: null }))
  }

  /** 空スロット: スナップショットがあればタップで戻す（UNDO ボタン非表示時も可） */
  const handleEmptySlotActivate = (cat: GearCategory) => {
    if (!slots[cat] && slotUndo[cat]) handleRestoreFromUndo(cat)
  }

  const renderStackableRow = (s: { id: number; name: string; image: string }) => {
    const pts = skillPoints.get(s.id) ?? 0
    const isActive = pts > 0
    const maxPts = pts + remainingPool
    const next = stepUp(pts, aAvail, maxPts)
    const canStepUp = next !== pts

    const stepDownOnce = (e: React.MouseEvent<HTMLButtonElement>) => {
      if (stepperIgnoreClickRef.current) {
        stepperIgnoreClickRef.current = false
        return
      }
      const n = e.shiftKey ? 0 : stepDown(pts, aAvail)
      if (n === pts) return
      setSkillPoints(prev => {
        const m = new Map(prev)
        m.set(s.id, n)
        return m
      })
      setComboResults(null)
    }
    const stepUpOnce = (e: React.MouseEvent<HTMLButtonElement>) => {
      if (stepperIgnoreClickRef.current) {
        stepperIgnoreClickRef.current = false
        return
      }
      if (!canStepUp) return
      const n = e.shiftKey ? stepMax(aAvail, maxPts) : next
      if (n === pts) return
      setSkillPoints(prev => {
        const m = new Map(prev)
        m.set(s.id, n)
        return m
      })
      setComboResults(null)
    }

    const capturePtr = (e: React.PointerEvent<HTMLButtonElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId)
    }

    return (
      <div key={s.id} className={`combo-skill-row ${isActive ? 'combo-skill-row--active' : ''}`}>
        <img className="combo-skill-row__icon" src={`/data/${s.image}`} alt={s.name} />
        <span className="combo-skill-row__name">{s.name}</span>
        <div className="stepper">
          <button
            type="button"
            className="stepper__btn"
            onClick={stepDownOnce}
            onPointerDown={e => { capturePtr(e); startStepperHold(s.id, 'down') }}
            onPointerUp={clearStepperHold}
            onPointerCancel={clearStepperHold}
            onLostPointerCapture={clearStepperHold}
            disabled={pts === 0}
            aria-label={`${s.name} を下げる`}
          >−</button>
          <span className="stepper__value">{pts === 0 ? '−' : `${pts}pt`}</span>
          <button
            type="button"
            className="stepper__btn"
            onClick={stepUpOnce}
            onPointerDown={e => { capturePtr(e); startStepperHold(s.id, 'up') }}
            onPointerUp={clearStepperHold}
            onPointerCancel={clearStepperHold}
            onLostPointerCapture={clearStepperHold}
            disabled={!canStepUp}
            aria-label={`${s.name} を上げる`}
          >＋</button>
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
        aria-label={isOpen ? (snapExpanded ? '縮小' : 'コーデを閉じる') : 'コーデを開く'}
        style={{ touchAction: 'none' }}
      >
        <div className="combo-sheet__handle" />
      </div>

      {/* シート本体 */}
      <div
        ref={sheetRef}
        className={`combo-sheet${isOpen ? ' combo-sheet--open' : ''}${snapExpanded ? ' combo-sheet--expanded' : ''}`}
        role="dialog"
        aria-label="コーデ"
        aria-modal="false"
      >
        {/* ヘッダー */}
        <div className="combo-sheet__header">
          <span className="combo-sheet__title">🎮 コーデ</span>
          {anyFilled && (
            <button
              type="button"
              className="combo-sheet__clear-btn"
              onClick={() => {
                for (const c of ['head', 'clothing', 'shoes'] as GearCategory[]) clearUndoFlashTimer(c)
                setUndoBtnFlash({ head: false, clothing: false, shoes: false })
                onClearAll()
                setComboResults(null)
                setSlotUndo(emptySlots())
              }}
            >
              クリア
            </button>
          )}
        </div>

        <div className="combo-sheet__body">

        <div className="combo-sheet__sticky-top">
        {/* ── 3スロット（横並び） ── */}
        <div className="combo-slots">
          {(['head', 'clothing', 'shoes'] as GearCategory[]).map(cat => {
            const gear = slots[cat]
            const undoGear = slotUndo[cat]
            const canUndo = !gear && undoGear !== null
            const showUndoBtn = canUndo && undoBtnFlash[cat]
            const emptyInteractive = canUndo

            if (gear) {
              return (
                <div key={cat} className="combo-slot combo-slot--filled" title={gear.name}>
                  <button
                    type="button"
                    className="combo-slot__icon-btn combo-slot__icon-btn--remove"
                    aria-label={`${CAT_LABEL[cat]}スロットから「${gear.name}」を外す`}
                    title="スロットから外す"
                    onClick={e => { e.stopPropagation(); handleRemoveSlot(cat) }}
                  >
                    <span className="combo-slot__icon-btn-mark" aria-hidden>×</span>
                  </button>
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
                </div>
              )
            }

            return (
              <div
                key={cat}
                className={`combo-slot combo-slot--empty${canUndo ? ' combo-slot--undoable' : ''}${showUndoBtn ? ' combo-slot--undo-flash' : ''}`}
                onClick={() => { if (emptyInteractive) handleEmptySlotActivate(cat) }}
                onKeyDown={e => {
                  if (!emptyInteractive) return
                  if (e.key !== 'Enter' && e.key !== ' ') return
                  e.preventDefault()
                  handleEmptySlotActivate(cat)
                }}
                role={emptyInteractive ? 'button' : undefined}
                tabIndex={emptyInteractive ? 0 : undefined}
                title={canUndo && undoGear
                  ? showUndoBtn
                    ? `「${undoGear.name}」を戻す（↩ またはこの枠をタップ）`
                    : `「${undoGear.name}」を戻す（この枠をタップ）`
                  : `リストから${CAT_LABEL[cat]}ギアを選択`}
              >
                {showUndoBtn && undoGear && (
                  <button
                    type="button"
                    className="combo-slot__icon-btn combo-slot__icon-btn--undo"
                    aria-label={`「${undoGear.name}」を戻す`}
                    title="元に戻す"
                    onClick={e => { e.stopPropagation(); handleRestoreFromUndo(cat) }}
                  >
                    <span className="combo-slot__icon-btn-mark combo-slot__icon-btn-mark--undo" aria-hidden>↩</span>
                  </button>
                )}
                <div className="combo-slot__empty-inner">
                  <span className="combo-slot__empty-icon">{CAT_ICON[cat]}</span>
                  {canUndo && undoGear && !showUndoBtn && (
                    <span className="combo-slot__undo-hint">タップで戻す</span>
                  )}
                </div>
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
                    <div
                      key={id}
                      className={`combo-ap-chip${isMainOnly(id) ? ' combo-ap-chip--main-only' : ''}`}
                      title={isMainOnly(id) ? name : `${name}: ${ap}pt`}
                    >
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
        </div>

        {/* ── スキル指定 + 生成 + 結果（オープン中は常に DOM に置き、ピーク時は折りたたんで intrinsic 幅だけ確保） ── */}
        {isOpen && (
          <div
            className={`combo-sheet__expand-block${snapExpanded ? '' : ' combo-sheet__expand-block--peek-hidden'}`}
            inert={!snapExpanded}
            aria-hidden={!snapExpanded ? true : undefined}
          >
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

            {/* コーデ生成ボタン */}
            <div className="combo-sheet__actions">
              <button
                className="combo-gen-btn"
                onClick={handleGenerate}
                disabled={activeRequirements === 0 || searching}
              >
                {searching ? '🔍 探索中...' : '⚡ コーデ生成'}
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
                    : (() => {
                        const total = comboResults.length
                        const nearN = comboResults.filter(c => c.matchKind === 'near').length
                        const perfectN = total - nearN
                        return nearN > 0
                          ? `${total} 件（条件を満たす ${perfectN} / 惜しい ${nearN}）— タップで適用`
                          : `${total} 件の候補（タップで適用）`
                      })()}
                </div>
                <div className="combo-results__list">
                  {comboResults.map(combo => {
                    const isNear = combo.matchKind === 'near'
                    const sk = getComboSortKey(combo)
                    const isBest = !isNear && bestPerfectSortKeys !== null &&
                      comboBestBadgeKeysEqual(sk, bestPerfectSortKeys)
                    return (
                    <button
                      key={`${combo.head.id}-${combo.clothing.id}-${combo.shoes.id}-${combo.matchKind ?? 'perfect'}-${combo.deficitSum ?? 0}`}
                      type="button"
                      className={`combo-result-row${isBest ? ' combo-result-row--best' : ''}${isNear ? ' combo-result-row--near' : ''}`}
                      onClick={() => {
                        for (const c of ['head', 'clothing', 'shoes'] as GearCategory[]) clearUndoFlashTimer(c)
                        setUndoBtnFlash({ head: false, clothing: false, shoes: false })
                        setSlotUndo(emptySlots())
                        onApplyCombo(combo)
                      }}
                    >
                      {isBest && <span className="combo-result-row__badge">ベスト</span>}
                      {isNear && <span className="combo-result-row__badge combo-result-row__badge--near">惜しい</span>}
                      <div className="combo-result-row__gears">
                        <img src={`/data/${combo.head.image}`}     alt={combo.head.name}     title={combo.head.name} />
                        <span className="combo-result-row__plus">+</span>
                        <img src={`/data/${combo.clothing.image}`} alt={combo.clothing.name} title={combo.clothing.name} />
                        <span className="combo-result-row__plus">+</span>
                        <img src={`/data/${combo.shoes.image}`}    alt={combo.shoes.name}    title={combo.shoes.name} />
                      </div>
                      <div className="combo-result-row__ap">
                        {Object.entries(combo.allApBySkill)
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
                            const info = skillInfoById.get(sid)
                            return info ? (
                              <div key={skillIdStr} className="combo-result-ap-chip">
                                <img src={`/data/${info.image}`} alt={info.name} title={info.name} />
                                {!mainOnly && <span>{ap}pt</span>}
                              </div>
                            ) : (
                              <div key={skillIdStr} className="combo-result-ap-chip combo-result-ap-chip--unknown" title={`id=${sid}`}>
                                <span className="combo-result-ap-chip__id">{sid}</span>
                                {!mainOnly && <span>{ap}pt</span>}
                              </div>
                            )
                          })}
                      </div>
                    </button>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        </div>
      </div>
    </div>
  )
}
