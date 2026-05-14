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
  /** skillId → 合計AP */
  totalAp: Record<number, number>
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

/**
 * find_combo.py の探索ロジック（枝刈り全探索）を TS に移植。
 * requirements に指定したスキル・最低AP をすべて満たす 3ギア組み合わせを返す。
 * 結果は合計AP 昇順（ムダが少ない順）にソートして limit 件まで返す。
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
          valid.push({ head: h.gear, clothing: c.gear, shoes: sh.gear, totalAp })
        }
      }
    }
  }

  // 合計AP 昇順（ムダが少ない順）
  valid.sort((a, b) => {
    const sa = Object.values(a.totalAp).reduce((s, v) => s + v, 0)
    const sb = Object.values(b.totalAp).reduce((s, v) => s + v, 0)
    return sa - sb
  })

  return valid.slice(0, limit)
}
