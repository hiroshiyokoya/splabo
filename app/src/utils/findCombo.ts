import type { GearItem, GearDB } from '../types'

export const MAIN_AP = 10
export const SUB_AP  = 3
const MAX_AP_PER_PIECE = MAIN_AP + SUB_AP * 3  // 19

export interface SkillRequirement {
  skillId:   number
  skillName: string
  minAp:     number
}

export interface ComboResult {
  head:     GearItem
  clothing: GearItem
  shoes:    GearItem
  /** 目標として指定したスキルの skillId → 合計AP */
  totalAp: Record<number, number>
  /** 装備に載っている全スキルの skillId → 合計AP（メイン10・サブ3） */
  allApBySkill: Record<number, number>
}

/** 1ギアについて、各スキルIDの AP を計算 */
function gearAp(gear: GearItem, skillIds: number[]): Record<number, number> {
  const ap: Record<number, number> = {}
  for (const id of skillIds) {
    let v = 0
    if (gear.primary_skill.id === id) v += MAIN_AP
    for (const sub of gear.additional_skills) {
      if (sub.id === id) v += SUB_AP
    }
    ap[id] = v
  }
  return ap
}

/** 3着について、スキルIDごとの装備内AP（メイン10・サブ3、id=-1 は除く） */
function outfitApBySkill(head: GearItem, clothing: GearItem, shoes: GearItem): Map<number, number> {
  const map = new Map<number, number>()
  const add = (skill: { id: number }, pts: number) => {
    if (skill.id === -1) return
    map.set(skill.id, (map.get(skill.id) ?? 0) + pts)
  }
  for (const gear of [head, clothing, shoes]) {
    add(gear.primary_skill, MAIN_AP)
    for (const sub of gear.additional_skills) add(sub, SUB_AP)
  }
  return map
}

/** 同一ソートキー時の安定順序（頭・服・靴の id 昇順） */
function compareComboIds(a: ComboResult, b: ComboResult): number {
  const d0 = a.head.id - b.head.id
  if (d0 !== 0) return d0
  const d1 = a.clothing.id - b.clothing.id
  if (d1 !== 0) return d1
  return a.shoes.id - b.shoes.id
}

/**
 * ソート用キー（いずれも降順で先頭ほど「ベスト」寄り＝数値が大きいほど上）
 * 1. 今回の目標スキルについての装備内実APの合計（`totalAp` の値の和）
 * 2. 全身の装備内AP合計（57点法の実スロット分）
 * 3. 単一スキルIDあたりの装備内APの最大値（発動型はメインのみ10）
 */
function sortKeys(combo: ComboResult): [number, number, number] {
  const bySkill = outfitApBySkill(combo.head, combo.clothing, combo.shoes)
  const targetSum = Object.values(combo.totalAp).reduce((s, v) => s + v, 0)
  let allSum = 0
  let maxSingle = 0
  for (const v of bySkill.values()) {
    allSum += v
    if (v > maxSingle) maxSingle = v
  }
  return [targetSum, allSum, maxSingle]
}

/**
 * find_combo.py の探索ロジック（枝刈り全探索）を TS に移植。
 * requirements に指定したスキル・最低AP をすべて満たす 3ギア組み合わせを返す。
 * 結果は sortKeys のマルチキー降順でソートし、limit 件まで返す。
 */
export function findCombo(
  data:         GearDB,
  requirements: SkillRequirement[],
  limit = 50,
): ComboResult[] {
  if (requirements.length === 0) return []

  const skillIds = requirements.map(r => r.skillId)

  const heads     = data.head.map(g     => ({ gear: g, ap: gearAp(g, skillIds) }))
  const clothings = data.clothing.map(g => ({ gear: g, ap: gearAp(g, skillIds) }))
  const shoesAll  = data.shoes.map(g    => ({ gear: g, ap: gearAp(g, skillIds) }))

  const valid: ComboResult[] = []

  for (const h of heads) {
    // 枝刈り: 残り2ピースが全部 MAX_AP_PER_PIECE でも足りなければスキップ
    if (requirements.some(r => r.minAp - h.ap[r.skillId] > MAX_AP_PER_PIECE * 2)) continue

    for (const c of clothings) {
      let skip = false
      for (const r of requirements) {
        if (r.minAp - h.ap[r.skillId] - c.ap[r.skillId] > MAX_AP_PER_PIECE) {
          skip = true
          break
        }
      }
      if (skip) continue

      for (const sh of shoesAll) {
        if (requirements.every(r =>
          h.ap[r.skillId] + c.ap[r.skillId] + sh.ap[r.skillId] >= r.minAp
        )) {
          const totalAp: Record<number, number> = {}
          for (const id of skillIds) {
            totalAp[id] = h.ap[id] + c.ap[id] + sh.ap[id]
          }
          const bySkill = outfitApBySkill(h.gear, c.gear, sh.gear)
          const allApBySkill: Record<number, number> = {}
          for (const [id, v] of bySkill) allApBySkill[id] = v
          valid.push({ head: h.gear, clothing: c.gear, shoes: sh.gear, totalAp, allApBySkill })
        }
      }
    }
  }

  valid.sort((a, b) => {
    const ka = sortKeys(a)
    const kb = sortKeys(b)
    for (let i = 0; i < 3; i++) {
      if (ka[i] !== kb[i]) return kb[i] - ka[i]
    }
    return compareComboIds(a, b)
  })

  return valid.slice(0, limit)
}
