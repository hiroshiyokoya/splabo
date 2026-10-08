import type { GearItem, GearDB } from '../types'
import { isMainOnly } from '../constants/gearPowerMeta'

export const MAIN_AP = 10
export const SUB_AP  = 3
/** サブスロットの最大数 */
const SUB_SLOTS = 3

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
  /** matchKind === 'near' のとき: 並び順に使う減点（アキ・未開放枠で埋められる不足は半分） */
  nearPenalty?: number
  /** matchKind === 'near' のとき: 目標に届かないスキルの skillId → 不足AP */
  shortfallBySkill?: Record<number, number>
  /** matchKind === 'near' のとき: 指定アキ数に対する不足枠数 */
  akiShortfall?: number
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

/** 1ギアのアキ（id=-1）サブスロット数 */
function countEmptySlots(gear: GearItem): number {
  return gear.additional_skills.filter(s => s.id === -1).length
}

/** 1ギアの未開放サブスロット数 */
function countClosedSlots(gear: GearItem): number {
  return Math.max(0, SUB_SLOTS - gear.additional_skills.length)
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
  // アキ枠は1pt換算でallSumに加算（サブ3ptより低い価値として意図的に設定）
  allSum += countEmptySlots(combo.head) + countEmptySlots(combo.clothing) + countEmptySlots(combo.shoes)
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

type GAp = { gear: GearItem; ap: Record<number, number>; aki: number; closed: number }

/**
 * 惜しい組の減点。不足AP（アキ不足は 1 枠 = SUB_AP）を基本に、
 * アキ枠・未開放枠で埋められる分は半分にする。
 * - 未開放枠は開ければアキになるので、アキ不足の補填に先に使う
 * - 指定アキ数ぶんのアキ枠はスキル不足の補填に回さない
 * - 発動型（メイン専用）の不足はサブ枠では埋まらないので全額
 */
function nearPenalty(
  requirements: SkillRequirement[],
  h: GAp, c: GAp, sh: GAp,
  minAkiSlots: number,
): number {
  const aki = h.aki + c.aki + sh.aki
  const closed = h.closed + c.closed + sh.closed

  const akiShort = Math.max(0, minAkiSlots - aki)
  const closedForAki = Math.min(akiShort, closed)
  let penalty = (akiShort - closedForAki) * SUB_AP + closedForAki * SUB_AP / 2

  let free = Math.max(0, aki - minAkiSlots) + (closed - closedForAki)
  const partials: number[] = []
  for (const r of requirements) {
    const short = r.minAp - (h.ap[r.skillId] + c.ap[r.skillId] + sh.ap[r.skillId])
    if (short <= 0) continue
    if (isMainOnly(r.skillId)) {
      penalty += short
      continue
    }
    // 1 枠で 3pt 埋まる分を先に割り当て、端数（1 枠で 1〜2pt）は大きい順に後で割り当てる
    const full = Math.min(free, Math.floor(short / SUB_AP))
    free -= full
    penalty += full * SUB_AP / 2 + (short - full * SUB_AP)
    const rest = short - full * SUB_AP
    if (rest > 0) partials.push(rest)
  }
  partials.sort((a, b) => b - a)
  for (const rest of partials) {
    if (free <= 0) break
    free--
    penalty -= rest / 2
  }
  return penalty
}

/** 目標に届かないスキルごとの不足AP */
function shortfallBySkill(requirements: SkillRequirement[], h: GAp, c: GAp, sh: GAp): Record<number, number> {
  const out: Record<number, number> = {}
  for (const r of requirements) {
    const short = r.minAp - (h.ap[r.skillId] + c.ap[r.skillId] + sh.ap[r.skillId])
    if (short > 0) out[r.skillId] = short
  }
  return out
}

function buildComboResult(h: GAp, c: GAp, sh: GAp, skillIds: number[]): ComboResult {
  const totalAp: Record<number, number> = {}
  for (const id of skillIds) totalAp[id] = h.ap[id] + c.ap[id] + sh.ap[id]
  const bySkill = outfitApBySkill(h.gear, c.gear, sh.gear)
  const allApBySkill: Record<number, number> = {}
  for (const [id, v] of bySkill) allApBySkill[id] = v
  return { head: h.gear, clothing: c.gear, shoes: sh.gear, totalAp, allApBySkill }
}

/** 惜しい組の並び順: 減点が小さい順、同点は compareComboResultsSort */
function compareNear(
  a: { deficit: number; combo: ComboResult },
  b: { deficit: number; combo: ComboResult },
): number {
  if (a.deficit !== b.deficit) return a.deficit - b.deficit
  return compareComboResultsSort(a.combo, b.combo)
}

/**
 * 減点が大きい候補を根に置く max-heap。
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

  /** 減点が小さい順（同率は目標APが多い順） */
  sorted(): { deficit: number; combo: ComboResult }[] {
    return [...this.a].sort(compareNear)
  }

  /** true なら i 側を親にしたい（減点が大きいほど上＝max-heap） */
  private dominates(i: number, j: number): boolean {
    return compareNear(this.a[i], this.a[j]) > 0
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

/** デフォルトの「惜しい」上限件数 */
const DEFAULT_NEAR_LIMIT = 10

/** (targetSum, allSum, perSkillDesc) の厳密な一致チェック（ID タイブレーカーは含まない） */
function comboSortKeyStrictEqual(a: ComboResult, b: ComboResult): boolean {
  const ka = getComboSortKey(a)
  const kb = getComboSortKey(b)
  if (ka.targetSum !== kb.targetSum || ka.allSum !== kb.allSum) return false
  if (ka.perSkillDesc.length !== kb.perSkillDesc.length) return false
  return ka.perSkillDesc.every((v, i) => v === kb.perSkillDesc[i])
}

/**
 * (減点, targetSum, allSum, perSkillDesc) でグループ化し、
 * 累計が NEAR_LIMIT を超えないグループまでを返す。
 * 超えるグループは丸ごと出さない。
 */
function pickNearGroups(
  nearEntries: { deficit: number; combo: ComboResult }[],
  nearLimit: number,
): { deficit: number; combo: ComboResult }[] {
  if (nearLimit <= 0 || nearEntries.length === 0) return []

  const sorted = [...nearEntries].sort(compareNear)
  const result: { deficit: number; combo: ComboResult }[] = []
  let i = 0

  while (i < sorted.length) {
    let j = i + 1
    while (
      j < sorted.length
      && sorted[i].deficit === sorted[j].deficit
      && comboSortKeyStrictEqual(sorted[i].combo, sorted[j].combo)
    ) j++
    const groupSize = j - i
    if (result.length + groupSize > nearLimit) break
    result.push(...sorted.slice(i, j))
    i = j
  }

  return result
}

/**
 * find_combo.py の探索ロジック（枝刈り全探索）を TS に移植。
 * requirements に指定したスキル・最低AP をすべて満たす組を優先し、
 * 残り枠に減点（nearPenalty）が小さい順の「惜しい」組を載せる（件数の最低保証はしない）。
 * 完全一致は compareComboResultsSort でソートし、全体は limit 件まで。
 *
 * 探索は頭・服・靴の全組み合わせを走査する。DB ごとにカテゴリ別の理論最大が異なるため、
 * 特定スロット前提の枝刈りは行わない（惜しい候補の取りこぼしを防ぐ）。
 */
export function findCombo(
  data:            GearDB,
  requirements:    SkillRequirement[],
  limit        = 50,
  minAkiSlots  = 0,
  nearLimit    = DEFAULT_NEAR_LIMIT,
): ComboResult[] {
  if (requirements.length === 0 && minAkiSlots === 0) return []

  const skillIds = requirements.map(r => r.skillId)

  const toGAp = (g: GearItem): GAp => ({ gear: g, ap: gearAp(g, skillIds), aki: countEmptySlots(g), closed: countClosedSlots(g) })
  const heads     = data.head.map(toGAp)
  const clothings = data.clothing.map(toGAp)
  const shoesAll  = data.shoes.map(toGAp)

  const valid: ComboResult[] = []
  const effectiveNearLimit = Math.min(nearLimit, limit)
  const heapCap = Math.min(500, Math.max(effectiveNearLimit * 20, 100))
  const nearHeap = new NearDeficitMaxHeap(heapCap)

  for (const h of heads) {
    for (const c of clothings) {
      const hcAki = h.aki + c.aki
      /** 同一 (h,c) で減点が最小になる靴だけヒープ候補にする（全靴より減点が大きいものは捨ててよい） */
      let minNearDeficit = Infinity
      const bestNearShoes: typeof shoesAll = []

      for (const sh of shoesAll) {
        const skillsMet = requirements.every(r =>
          h.ap[r.skillId] + c.ap[r.skillId] + sh.ap[r.skillId] >= r.minAp,
        )
        const akiMet = hcAki + sh.aki >= minAkiSlots
        if (skillsMet && akiMet) {
          valid.push(buildComboResult(h, c, sh, skillIds))
          continue
        }
        const d = nearPenalty(requirements, h, c, sh, minAkiSlots)
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

  if (valid.length >= 10) return perfectTagged

  const byGear = new Map<GearItem, GAp>([...heads, ...clothings, ...shoesAll].map(x => [x.gear, x]))
  const nearPicks = pickNearGroups(nearHeap.sorted(), effectiveNearLimit)
  const nearTagged: ComboResult[] = nearPicks.map(({ combo, deficit }) => {
    const shortfall = shortfallBySkill(requirements, byGear.get(combo.head)!, byGear.get(combo.clothing)!, byGear.get(combo.shoes)!)
    const aki = countEmptySlots(combo.head) + countEmptySlots(combo.clothing) + countEmptySlots(combo.shoes)
    const akiShortfall = Math.max(0, minAkiSlots - aki)
    return {
      ...combo,
      matchKind: 'near' as const,
      deficitSum: Object.values(shortfall).reduce((s, v) => s + v, 0) + akiShortfall * SUB_AP,
      nearPenalty: deficit,
      shortfallBySkill: shortfall,
      akiShortfall,
    }
  })

  return [...perfectTagged, ...nearTagged]
}
