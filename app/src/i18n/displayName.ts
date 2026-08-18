import i18n from './index'
import { stageAbbr } from '../types'
import type { BattleRow, GroupedStatsRow, GroupedStatsRow2D, SummaryEntry, WeaponRecord } from '../types'
import type { ScatterCategoryColorKey } from '../utils/scatterCategoryColors'

/** Prefer `name_en` when UI language is English; else `name_ja`; then fallback/key. */
export function localizedName(ja?: string | null, en?: string | null, fallback?: string): string {
  const useEn = i18n.language.startsWith('en')
  const pick = useEn ? (en || ja) : (ja || en)
  return (pick && pick.length ? pick : fallback) ?? ''
}

/** ブキカテゴリの公式英語名（stat.ink /api/v3/weapon の type.name.en_US、2026-08 時点、12種）。 */
const WEAPON_CATEGORY_NAME_EN: Record<string, string> = {
  'シューター': 'Shooters',
  'ブラスター': 'Blasters',
  'リールガン': 'Nozzlenoses',
  'マニューバー': 'Dualies',
  'ローラー': 'Rollers',
  'フデ': 'Brushes',
  'ワイパー': 'Splatanas',
  'チャージャー': 'Chargers',
  'スロッシャー': 'Sloshers',
  'スピナー': 'Splatlings',
  'シェルター': 'Brellas',
  'ストリンガー': 'Stringers',
}

/** サブウェポンの公式英語名（stat.ink /api/v3/weapon の sub.name.en_US、14種）。 */
const SUB_WEAPON_NAME_EN: Record<string, string> = {
  'スプラッシュシールド': 'Splash Wall',
  'カーリングボム': 'Curling Bomb',
  'スプリンクラー': 'Sprinkler',
  'ラインマーカー': 'Angle Shooter',
  'ジャンプビーコン': 'Squid Beakon',
  'ロボットボム': 'Autobomb',
  'キューバンボム': 'Suction Bomb',
  'クイックボム': 'Burst Bomb',
  'ポイズンミスト': 'Toxic Mist',
  'トーピード': 'Torpedo',
  'スプラッシュボム': 'Splat Bomb',
  'タンサンボム': 'Fizzy Bomb',
  'ポイントセンサー': 'Point Sensor',
  'トラップ': 'Ink Mine',
}

/** スペシャルウェポンの公式英語名（stat.ink /api/v3/weapon の special.name.en_US、19種）。 */
const SPECIAL_WEAPON_NAME_EN: Record<string, string> = {
  'メガホンレーザー5.1ch': 'Killer Wail 5.1',
  'スミナガシート': 'Splattercolor Screen',
  'キューインキ': 'Ink Vac',
  'テイオウイカ': 'Kraken Royale',
  'エナジースタンド': 'Tacticooler',
  'ウルトラハンコ': 'Ultra Stamp',
  'ウルトラショット': 'Trizooka',
  'ウルトラチャクチ': 'Triple Splashdown',
  'アメフラシ': 'Ink Storm',
  'ホップソナー': 'Wave Breaker',
  'デコイチラシ': 'Super Chump',
  'トリプルトルネード': 'Triple Inkstrike',
  'カニタンク': 'Crab Tank',
  'ナイスダマ': 'Booyah Bomb',
  'マルチミサイル': 'Tenta Missiles',
  'サメライド': 'Reefslider',
  'ジェットパック': 'Inkjet',
  'グレートバリア': 'Big Bubbler',
  'ショクワンダー': 'Zipcaster',
}

/** ブキカテゴリの表示名。未収録の値（表記ゆれ等）は日本語のままフォールバック。 */
export function weaponCategoryDisplayName(ja: string): string {
  return localizedName(ja, WEAPON_CATEGORY_NAME_EN[ja], ja)
}

/** サブウェポンの表示名。未収録の値は日本語のままフォールバック。 */
export function subWeaponDisplayName(ja: string): string {
  return localizedName(ja, SUB_WEAPON_NAME_EN[ja], ja)
}

/** スペシャルウェポンの表示名。未収録の値は日本語のままフォールバック。 */
export function specialWeaponDisplayName(ja: string): string {
  return localizedName(ja, SPECIAL_WEAPON_NAME_EN[ja], ja)
}

/** 散布図・凡例の色分けキー（weapon_category/sub_weapon/special_weapon）に応じた表示名変換。 */
export function scatterCategoryValueDisplayName(colorKey: ScatterCategoryColorKey, value: string): string {
  switch (colorKey) {
    case 'weapon_category': return weaponCategoryDisplayName(value)
    case 'sub_weapon':      return subWeaponDisplayName(value)
    case 'special_weapon':  return specialWeaponDisplayName(value)
  }
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
  if (groupBy === 'weapon_category') return weaponCategoryDisplayName
  if (groupBy === 'sub_weapon') return subWeaponDisplayName
  if (groupBy === 'special_weapon') return specialWeaponDisplayName
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
  if (groupBy === 'weapon_category') return weaponCategoryDisplayName
  if (groupBy === 'sub_weapon') return subWeaponDisplayName
  if (groupBy === 'special_weapon') return specialWeaponDisplayName
  return undefined
}
