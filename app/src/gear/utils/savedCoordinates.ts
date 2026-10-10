import type { TFunction } from 'i18next'
import type { GearCategory, GearDB, GearItem } from '../types'
import { MAIN_AP, SUB_AP } from './findCombo'
import { isMainOnly } from '../constants/gearPowerMeta'
import { skillDisplayName } from './skillDisplayName'
import { isTauri } from './tauri'

/**
 * 保存コーデ（#782）。実体は Rust 側の `app_data_dir()/saved_coordinates.json`
 * （`saved_coordinates.rs`）。viewer にもコンパニオン経由で配信される。
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
// ブラウザ開発時（Tauri 外）は localStorage で代用する。

const BROWSER_KEY = 'splabo:dev:savedCoordinates'

function readBrowser(): SavedCoordinate[] {
  try {
    return JSON.parse(localStorage.getItem(BROWSER_KEY) ?? '[]') as SavedCoordinate[]
  } catch {
    return []
  }
}

function writeBrowser(list: SavedCoordinate[]): void {
  try { localStorage.setItem(BROWSER_KEY, JSON.stringify(list)) } catch { /* 開発用なので無視 */ }
}

export async function listSavedCoordinates(): Promise<SavedCoordinate[]> {
  if (!isTauri()) return readBrowser()
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<SavedCoordinate[]>('list_saved_coordinates')
}

export async function saveCoordinate(input: SaveCoordinateInput): Promise<SavedCoordinate> {
  if (!isTauri()) {
    const list = readBrowser()
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
    const existing = input.id ? list.find(c => c.id === input.id) : undefined
    const saved: SavedCoordinate = existing
      ? { ...existing, title: input.title.trim(), memo: input.memo.trimEnd(), gears: input.gears, updated_at: now }
      : { id: crypto.randomUUID(), title: input.title.trim(), memo: input.memo.trimEnd(), gears: input.gears, created_at: now, updated_at: now }
    writeBrowser(existing ? list.map(c => (c.id === saved.id ? saved : c)) : [...list, saved])
    return saved
  }
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<SavedCoordinate>('save_coordinate', { input })
}

export async function deleteSavedCoordinate(id: string): Promise<void> {
  if (!isTauri()) {
    writeBrowser(readBrowser().filter(c => c.id !== id))
    return
  }
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('delete_saved_coordinate', { id })
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

/** 合計 AP の表示順（発動型が先、そのあと AP の高い順） */
export function sortApEntries(ap: Map<number, number>): [number, number][] {
  return [...ap.entries()].sort(([aId, aAp], [bId, bAp]) => {
    const aMain = isMainOnly(aId)
    const bMain = isMainOnly(bId)
    if (aMain !== bMain) return aMain ? -1 : 1
    return bAp - aAp || aId - bId
  })
}

/** 自動で付けるタイトル（主なギアパワー 2 つ） */
export function defaultCoordinateTitle(slots: FullSlots, t: TFunction): string {
  const ap = totalApBySkill([slots.head, slots.clothing, slots.shoes])
  const names = new Map<number, string>()
  for (const gear of [slots.head, slots.clothing, slots.shoes]) {
    for (const s of [gear.primary_skill, ...gear.additional_skills]) names.set(s.id, s.name)
  }
  return sortApEntries(ap)
    .slice(0, 2)
    .map(([id]) => skillDisplayName({ id, name: names.get(id) ?? '' }, t))
    .join(' / ')
}
