import i18n from './index'
import { stageAbbr } from '../types'
import type { BattleRow, GroupedStatsRow, GroupedStatsRow2D, SummaryEntry, WeaponRecord } from '../types'

/** Prefer `name_en` when UI language is English; else `name_ja`; then fallback/key. */
export function localizedName(ja?: string | null, en?: string | null, fallback?: string): string {
  const useEn = i18n.language.startsWith('en')
  const pick = useEn ? (en || ja) : (ja || en)
  return (pick && pick.length ? pick : fallback) ?? ''
}

export function weaponRecordDisplayName(w: WeaponRecord): string {
  return localizedName(w.name_ja, w.name_en, w.name)
}

export function battleStageDisplayName(b: BattleRow): string {
  return localizedName(b.stage_name, b.stage_name_en, b.stage)
}

export function battleWeaponDisplayName(b: BattleRow): string {
  return localizedName(b.weapon_name_ja, b.weapon_name_en, b.weapon)
}

export function groupedStatsDisplayName(row: GroupedStatsRow): string {
  return localizedName(row.name_ja ?? row.name, row.name_en, row.key ?? row.name)
}

export function summaryEntryDisplayName(entry: SummaryEntry): string {
  return localizedName(entry.name_ja ?? entry.name, entry.name_en, entry.name)
}

/** Stage tick label: Japanese abbr in ja; full English name in en. */
export function stageGroupedTickLabel(row: Pick<GroupedStatsRow, 'name' | 'name_ja' | 'name_en'>): string {
  const ja = row.name_ja ?? row.name
  if (i18n.language.startsWith('en')) return localizedName(ja, row.name_en, ja)
  return stageAbbr(ja)
}

export function stageSummaryTickLabel(entry: Pick<SummaryEntry, 'name' | 'name_ja' | 'name_en'>): string {
  const ja = entry.name_ja ?? entry.name
  if (i18n.language.startsWith('en')) return localizedName(ja, entry.name_en, ja)
  return stageAbbr(ja)
}

export function stageInfoDisplayName(s: {
  id?: string
  name?: string
  name_ja?: string | null
  name_en?: string | null
}): string {
  return localizedName(s.name_ja ?? s.name, s.name_en, s.id ?? s.name)
}

/** X-axis label transform from grouped stats rows (stage / weapon). */
export function groupedRowNameTransform(
  rows: GroupedStatsRow[],
  groupBy: string,
): ((name: string) => string) | undefined {
  if (groupBy === 'stage') {
    const m = new Map(rows.map(r => [r.name, stageGroupedTickLabel(r)]))
    return n => m.get(n) ?? n
  }
  if (groupBy === 'weapon') {
    const m = new Map(rows.map(r => [r.name, groupedStatsDisplayName(r)]))
    return n => m.get(n) ?? n
  }
  return undefined
}

/** Heatmap axis label transform using 2D row name_en fields. */
export function heatmap2dLabelTransform(
  data: GroupedStatsRow2D[],
  axis: 'x' | 'y',
  groupBy: string,
): ((s: string) => string) | undefined {
  if (groupBy === 'stage') {
    const nameKey = axis === 'x' ? 'name_x' : 'name_y'
    const enKey = axis === 'x' ? 'name_en_x' : 'name_en_y'
    const m = new Map(data.map(r => {
      const ja = r[nameKey]
      const label = i18n.language.startsWith('en')
        ? localizedName(ja, r[enKey], ja)
        : stageAbbr(ja)
      return [ja, label] as const
    }))
    return s => m.get(s) ?? s
  }
  if (groupBy === 'weapon') {
    const nameKey = axis === 'x' ? 'name_x' : 'name_y'
    const enKey = axis === 'x' ? 'name_en_x' : 'name_en_y'
    const m = new Map(data.map(r => {
      const ja = r[nameKey]
      return [ja, localizedName(ja, r[enKey], ja)] as const
    }))
    return s => m.get(s) ?? s
  }
  return undefined
}
