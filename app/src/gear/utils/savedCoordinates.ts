import type { GearCategory, GearDB, GearItem } from '../types'
import { MAIN_AP, SUB_AP } from './findCombo'
import { MAIN_ONLY_SKILL_CATEGORY, isMainOnly, makeSkillDisplayComparator } from '../constants/gearPowerMeta'
import { call } from '../../utils/backend'

/**
 * 保存コーデ（#782）。実体は Rust 側の `app_data_dir()/saved_coordinates.json`
 * （`saved_coordinates.rs`）。
 */

export const GEAR_CATEGORIES: GearCategory[] = ['head', 'clothing', 'shoes']

/** 1 部位ぶんのギア参照。ギアは id で引き、保存時点のギアパワーをスナップショットとして持つ */
export interface GearRef {
  id: number
  name: string
  main: number
  subs: number[]
}

export type CoordinateGears = Record<GearCategory, GearRef>

export interface SavedCoordinate {
  id: string
  title: string
  memo: string
  created_at: string
  updated_at: string
  gears: CoordinateGears
}

export interface SaveCoordinateInput {
  /** 既存の id なら更新、省略で新規 */
  id?: string
  title: string
  memo: string
  gears: CoordinateGears
}

/** 3 部位がそろったスロット */
export type FullSlots = Record<GearCategory, GearItem>

export function toGearRef(gear: GearItem): GearRef {
  return {
    id: gear.id,
    name: gear.name,
    main: gear.primary_skill.id,
    subs: gear.additional_skills.map(s => s.id),
  }
}

export function toCoordinateGears(slots: FullSlots): CoordinateGears {
  return {
    head: toGearRef(slots.head),
    clothing: toGearRef(slots.clothing),
    shoes: toGearRef(slots.shoes),
  }
}

// ── 保存先 ────────────────────────────────────────────────
// デスクトップでは invoke、スマホ Web 版では HTTP（どちらも backend の call が切り替える）。

export interface SavedCoordinatesList {
  coordinates: SavedCoordinate[]
  /** 次に保存するときのタイトル初期値「コーデN」の番号（保存回数 + 1。削除しても戻らない） */
  next_number: number
}

export function listSavedCoordinates(): Promise<SavedCoordinatesList> {
  return call<SavedCoordinatesList>('list_saved_coordinates')
}

export function saveCoordinate(input: SaveCoordinateInput): Promise<SavedCoordinate> {
  return call<SavedCoordinate>('save_coordinate', { input })
}

export async function deleteSavedCoordinate(id: string): Promise<void> {
  await call('delete_saved_coordinate', { id })
}

// ── 表示 ──────────────────────────────────────────────────

export interface ResolvedSlot {
  ref: GearRef
  /** 今の gear_db にあるギア（手放していれば null） */
  gear: GearItem | null
  /** 保存したときとギアパワーが変わっている */
  changed: boolean
}

export type ResolvedCoordinate = Record<GearCategory, ResolvedSlot>

function sameSkills(ref: GearRef, gear: GearItem): boolean {
  if (ref.main !== gear.primary_skill.id) return false
  const subs = gear.additional_skills.map(s => s.id)
  return subs.length === ref.subs.length && subs.every((id, i) => id === ref.subs[i])
}

/** 保存コーデを今の gear_db と突き合わせる */
export function resolveCoordinate(coord: SavedCoordinate, db: GearDB): ResolvedCoordinate {
  const out = {} as ResolvedCoordinate
  for (const cat of GEAR_CATEGORIES) {
    const ref = coord.gears[cat]
    const gear = db[cat].find(g => g.id === ref.id) ?? null
    out[cat] = { ref, gear, changed: gear !== null && !sameSkills(ref, gear) }
  }
  return out
}

/** ギアの合計 AP（スキル ID → AP、アキは除く） */
export function totalApBySkill(gears: (GearItem | null)[]): Map<number, number> {
  const result = new Map<number, number>()
  const add = (id: number, ap: number) => {
    if (id === -1) return
    result.set(id, (result.get(id) ?? 0) + ap)
  }
  for (const gear of gears) {
    if (!gear) continue
    add(gear.primary_skill.id, MAIN_AP)
    for (const s of gear.additional_skills) add(s.id, SUB_AP)
  }
  return result
}

/** 組み合わせ検索の条件（コーデシートの「スタック型の AP」と「発動型」） */
export interface ComboConditions {
  /** スタック型のスキル ID → 最低 AP */
  stackable: Map<number, number>
  /** 部位ごとの発動型のスキル ID（無ければ null） */
  mainOnly: Record<GearCategory, number | null>
}

/**
 * 保存したときのギアパワーから、組み合わせ検索の条件を作る（#860）。
 * ギアのサブを付け替えたり手放したりしたあと、元のギアパワーのコーデを組み直すのに使う。
 */
export function conditionsFromSnapshot(coord: SavedCoordinate): ComboConditions {
  const stackable = new Map<number, number>()
  const mainOnly: Record<GearCategory, number | null> = { head: null, clothing: null, shoes: null }
  const add = (id: number, ap: number) => {
    if (id === -1) return
    stackable.set(id, (stackable.get(id) ?? 0) + ap)
  }
  for (const cat of GEAR_CATEGORIES) {
    const ref = coord.gears[cat]
    if (isMainOnly(ref.main)) mainOnly[MAIN_ONLY_SKILL_CATEGORY[ref.main] ?? cat] = ref.main
    else add(ref.main, MAIN_AP)
    for (const id of ref.subs) add(id, SUB_AP)
  }
  return { stackable, mainOnly }
}

/** 合計 AP の表示順（発動型が先、そのあと AP の高い順） */
export function sortApEntries(ap: Map<number, number>): [number, number][] {
  const compare = makeSkillDisplayComparator()
  return [...ap.entries()].sort(([aId], [bId]) => compare(aId, bId))
}
