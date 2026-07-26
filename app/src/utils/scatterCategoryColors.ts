import type { BattleRow } from '../types'
import type { ColorLegend } from '../components/charts/ScatterChart'

/** 散布図のカテゴリ色分けキー（GROUP_BY_LABELS のキーと一致）。 */
export const SCATTER_CATEGORY_COLOR_KEYS = ['weapon_category', 'sub_weapon', 'special_weapon'] as const
export type ScatterCategoryColorKey = (typeof SCATTER_CATEGORY_COLOR_KEYS)[number]

export function isScatterCategoryColorKey(k: string | undefined | null): k is ScatterCategoryColorKey {
  return !!k && (SCATTER_CATEGORY_COLOR_KEYS as readonly string[]).includes(k)
}

/** 武器名 → カテゴリ / サブ / スペシャル（ダッシュボード武器集計ドット用）。 */
export type WeaponMeta = {
  category:       string
  sub_weapon:     string | null
  special_weapon: string | null
}

export const UNCLASSIFIED_CATEGORY = '(未分類)'
export const UNKNOWN_WEAPON_PART   = '(不明)'

/** カテゴリ名ごとに固定色を割り当てるパレット（Tableau 10 系）。 */
const SCATTER_CATEGORY_PALETTE = [
  '#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f',
  '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac',
  '#86bcb6', '#d37295', '#fabfd2', '#a0cbe8', '#ffbe7d',
  '#8cd17d', '#b6992d', '#499894', '#f1ce63', '#d4a6c8',
]

function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

/** カテゴリ名 → CSS 色。同じ名前は常に同じ色。 */
export function categoryColorOf(name: string): string {
  const trimmed = name.trim()
  if (!trimmed || trimmed === UNCLASSIFIED_CATEGORY || trimmed === UNKNOWN_WEAPON_PART) {
    return 'var(--text-muted)'
  }
  return SCATTER_CATEGORY_PALETTE[hashString(trimmed) % SCATTER_CATEGORY_PALETTE.length]
}

/** 出現中カテゴリだけ並べた凡例（折り返し表示）。 */
export function buildCategoryColorLegend(label: string, categories: string[]): ColorLegend {
  const sorted = [...new Set(categories.map(c => c.trim() || UNCLASSIFIED_CATEGORY))]
    .sort((a, b) => a.localeCompare(b, 'ja'))
  return {
    label,
    layout: 'chips',
    items: sorted.map(cat => ({ label: cat, color: categoryColorOf(cat) })),
  }
}

export function categoryValueForWeaponName(
  name: string,
  colorKey: ScatterCategoryColorKey,
  meta?: Map<string, WeaponMeta>,
): string {
  const m = meta?.get(name)
  switch (colorKey) {
    case 'weapon_category': return m?.category?.trim() || UNCLASSIFIED_CATEGORY
    case 'sub_weapon':      return m?.sub_weapon?.trim() || UNKNOWN_WEAPON_PART
    case 'special_weapon':  return m?.special_weapon?.trim() || UNKNOWN_WEAPON_PART
  }
}

export function categoryValueForBattle(
  b: BattleRow,
  colorKey: ScatterCategoryColorKey,
  meta?: Map<string, WeaponMeta>,
): string {
  switch (colorKey) {
    case 'weapon_category': return meta?.get(b.weapon)?.category?.trim() || UNCLASSIFIED_CATEGORY
    case 'sub_weapon':      return b.sub_weapon?.trim() || UNKNOWN_WEAPON_PART
    case 'special_weapon':  return b.special_weapon?.trim() || UNKNOWN_WEAPON_PART
  }
}

/** 環境分析 EnvScatterStat からカテゴリ値を取り出す。 */
export function categoryValueForEnvStat(
  s: { category_key?: string | null; sub_key?: string | null; special_key?: string | null },
  colorKey: ScatterCategoryColorKey,
): string {
  switch (colorKey) {
    case 'weapon_category': return s.category_key?.trim() || UNCLASSIFIED_CATEGORY
    case 'sub_weapon':      return s.sub_key?.trim() || UNKNOWN_WEAPON_PART
    case 'special_weapon':  return s.special_key?.trim() || UNKNOWN_WEAPON_PART
  }
}
