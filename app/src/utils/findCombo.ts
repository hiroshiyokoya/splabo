import type { GearItem, GearDB } from '../types'

export const MAIN_AP = 10
export const SUB_AP  = 3

export interface SkillRequirement {
  skillId:   number
  skillName: string
  minAp:     number
}

/** 条件を満たす組 / 満たさないが不足が少ない「惜しい」組 */
export type ComboMatchKind = 'perfect' | 'near'

export interface ComboResult {
  head:     GearItem
  clothing: GearItem
  shoes:    GearItem
  /** 目標として指定したスキルの skillId → 合計AP */
  totalAp: Record<number, number>
  /** 装備に載っている全スキルの skillId → 合計AP（メイン10・サブ3） */
  allApBySkill: Record<number, number>
  /** 未指定時は perfect 扱い */
  matchKind?: ComboMatchKind
  /** matchKind === 'near' のとき: 目標に対する不足APの合計 */
  deficitSum?: number
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
 * コーデ候補のソートキー（いずれも「大きいほど上」＝より良い）
 * 1. 目標スキル実APの合計（totalAp の和）
 * 2. 全身スキル実APの合計
 * 3 以降. 各スキルIDごとの装着APを降順に並べた列（1位＝従来の単体最大、2位・3位…でタイブレーク）
 */
export interface ComboSortKey {
  targetSum: number
  allSum: number
  perSkillDesc: number[]
}

export function getComboSortKey(combo: ComboResult): ComboSortKey {
  const bySkill = outfitApBySkill(combo.head, combo.clothing, combo.shoes)
  const targetSum = Object.values(combo.totalAp).reduce((s, v) => s + v, 0)
  let allSum = 0
  const vals: number[] = []
  for (const v of bySkill.values()) {
    allSum += v
    vals.push(v)
  }
  vals.sort((a, b) => b - a)
  return { targetSum, allSum, perSkillDesc: vals }
}

/** 降順ソート用: 負なら a を先に並べる（a の方が良い） */
export function compareComboResultsSort(a: ComboResult, b: ComboResult): number {
  const ka = getComboSortKey(a)
  const kb = getComboSortKey(b)
  if (ka.targetSum !== kb.targetSum) return kb.targetSum - ka.targetSum
  if (ka.allSum !== kb.allSum) return kb.allSum - ka.allSum
  const len = Math.max(ka.perSkillDesc.length, kb.perSkillDesc.length)
  for (let i = 0; i < len; i++) {
    const ai = ka.perSkillDesc[i] ?? 0
    const bi = kb.perSkillDesc[i] ?? 0
    if (ai !== bi) return bi - ai
  }
  return compareComboIds(a, b)
}

/** 「ベスト」バッジ用: ソートキー1・2（targetSum / allSum）のみ一致すれば同率扱い */
export function comboBestBadgeKeysEqual(ka: ComboSortKey, kb: ComboSortKey): boolean {
  return ka.targetSum === kb.targetSum && ka.allSum === kb.allSum
}

function deficitSum(
  requirements: SkillRequirement[],
  hAp: Record<number, number>,
  cAp: Record<number, number>,
  shAp: Record<number, number>,
): number {
  let d = 0
  for (const r of requirements) {
    const got = hAp[r.skillId] + cAp[r.skillId] + shAp[r.skillId]
    if (got < r.minAp) d += r.minAp - got
  }
  return d
}

function compareNearTie(a: ComboResult, b: ComboResult): number {
  return compareComboResultsSort(a, b)
}

type GAp = { gear: GearItem; ap: Record<number, number> }

function buildComboResult(h: GAp, c: GAp, sh: GAp, skillIds: number[]): ComboResult {
  const totalAp: Record<number, number> = {}
  for (const id of skillIds) totalAp[id] = h.ap[id] + c.ap[id] + sh.ap[id]
  const bySkill = outfitApBySkill(h.gear, c.gear, sh.gear)
  const allApBySkill: Record<number, number> = {}
  for (const [id, v] of bySkill) allApBySkill[id] = v
  return { head: h.gear, clothing: c.gear, shoes: sh.gear, totalAp, allApBySkill }
}

/**
 * 不足AP合計が大きい候補を根に置く max-heap。
 * 満杯のときは「根より不足が小さい」候補で根を差し替え、全体として不足が小さい cap 件を保つ。
 */
class NearDeficitMaxHeap {
  private readonly a: { deficit: number; combo: ComboResult }[] = []
  private readonly cap: number

  constructor(cap: number) {
    this.cap = cap
  }

  consider(combo: ComboResult, deficit: number) {
    if (this.cap <= 0 || deficit <= 0) return
    if (this.a.length < this.cap) {
      this.a.push({ deficit, combo })
      this.up(this.a.length - 1)
      return
    }
    if (deficit < this.a[0].deficit) {
      this.a[0] = { deficit, combo }
      this.down(0)
    }
  }

  /** 不足が小さい順（同率は目標APが多い順） */
  sorted(): { deficit: number; combo: ComboResult }[] {
    return [...this.a].sort((u, v) => {
      if (u.deficit !== v.deficit) return u.deficit - v.deficit
      return compareNearTie(u.combo, v.combo)
    })
  }

  /** true なら i 側を親にしたい（欠損が大きいほど上＝max-heap） */
  private dominates(i: number, j: number): boolean {
    const di = this.a[i].deficit - this.a[j].deficit
    if (di !== 0) return di > 0
    return compareComboResultsSort(this.a[j].combo, this.a[i].combo) < 0
  }

  private up(i: number) {
    while (i > 0) {
      const p = (i - 1) >> 1
      if (!this.dominates(i, p)) break
      ;[this.a[p], this.a[i]] = [this.a[i], this.a[p]]
      i = p
    }
  }

  private down(i: number) {
    const n = this.a.length
    for (;;) {
      const l = (i << 1) + 1
      const r = l + 1
      let m = i
      if (l < n && this.dominates(l, m)) m = l
      if (r < n && this.dominates(r, m)) m = r
      if (m === i) break
      ;[this.a[i], this.a[m]] = [this.a[m], this.a[i]]
      i = m
    }
  }
}

/**
 * targetSum・allSum が同じ惜しい候補は 1 件にまとめる。
 * 不足AP合計がより小さいものを残し、同不足なら compareComboResultsSort で良い方を残す。
 */
function dedupeNearBySortKey12Best(
  nearSorted: { deficit: number; combo: ComboResult }[],
): { deficit: number; combo: ComboResult }[] {
  const bestByKey = new Map<string, { deficit: number; combo: ComboResult }>()
  for (const e of nearSorted) {
    const k = getComboSortKey(e.combo)
    const key = `${k.targetSum},${k.allSum}`
    const prev = bestByKey.get(key)
    if (!prev) {
      bestByKey.set(key, e)
      continue
    }
    if (e.deficit < prev.deficit) {
      bestByKey.set(key, e)
    }
    else if (e.deficit === prev.deficit && compareComboResultsSort(e.combo, prev.combo) < 0) {
      bestByKey.set(key, e)
    }
  }
  return [...bestByKey.values()].sort((a, b) => {
    if (a.deficit !== b.deficit) return a.deficit - b.deficit
    return compareNearTie(a.combo, b.combo)
  })
}

/**
 * find_combo.py の探索ロジック（枝刈り全探索）を TS に移植。
 * requirements に指定したスキル・最低AP をすべて満たす組を優先し、
 * 残り枠に不足APが小さい順の「惜しい」組を載せる（件数の最低保証はしない）。
 * 惜しいは targetSum・allSum が同じ組は 1 件に畳む（不足が最小で、同不足ならソート上最良）。
 * 結果は compareComboResultsSort でソートし、全体は limit 件まで。
 *
 * 探索は頭・服・靴の全組み合わせを走査する。DB ごとにカテゴリ別の理論最大が異なるため、
 * 特定スロット前提の枝刈りは行わない（惜しい候補の取りこぼしを防ぐ）。
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
  const heapCap = Math.min(2000, Math.max(limit * 24, 400))
  const nearHeap = new NearDeficitMaxHeap(heapCap)

  for (const h of heads) {
    for (const c of clothings) {
      /** 同一 (h,c) で不足が最小になる靴だけヒープ候補にする（全靴より欠損が悪いものは捨ててよい） */
      let minNearDeficit = Infinity
      const bestNearShoes: GAp[] = []

      for (const sh of shoesAll) {
        const met = requirements.every(r =>
          h.ap[r.skillId] + c.ap[r.skillId] + sh.ap[r.skillId] >= r.minAp,
        )
        if (met) {
          valid.push(buildComboResult(h, c, sh, skillIds))
          continue
        }
        const d = deficitSum(requirements, h.ap, c.ap, sh.ap)
        if (d < minNearDeficit) {
          minNearDeficit = d
          bestNearShoes.length = 0
          bestNearShoes.push(sh)
        }
        else if (d === minNearDeficit) {
          bestNearShoes.push(sh)
        }
      }

      for (const sh of bestNearShoes) {
        const combo = buildComboResult(h, c, sh, skillIds)
        nearHeap.consider(combo, minNearDeficit)
      }
    }
  }

  valid.sort(compareComboResultsSort)

  const perfectTagged: ComboResult[] = valid
    .slice(0, limit)
    .map(c => ({ ...c, matchKind: 'perfect' as const }))

  const nearSlots = Math.max(0, limit - perfectTagged.length)
  const nearPicks = dedupeNearBySortKey12Best(nearHeap.sorted()).slice(0, nearSlots)
  const nearTagged: ComboResult[] = nearPicks.map(({ combo, deficit }) => ({
    ...combo,
    matchKind: 'near' as const,
    deficitSum: deficit,
  }))

  return [...perfectTagged, ...nearTagged].slice(0, limit)
}
