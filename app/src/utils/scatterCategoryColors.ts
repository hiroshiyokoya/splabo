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

/**
 * カテゴリ色パレット（暗背景向け）。
 * 隣接インデックス同士の色相が遠くなるよう並べ、青系の密集を避けて緑・ライムを厚めにしている。
 */
const SCATTER_CATEGORY_PALETTE = [
  '#ef4444', // red
  '#22c55e', // green
  '#3b82f6', // blue（青はこれと indigo のみ）
  '#eab308', // yellow
  '#a855f7', // purple
  '#f97316', // orange
  '#14b8a6', // teal
  '#ec4899', // pink
  '#84cc16', // lime
  '#6366f1', // indigo
  '#d97706', // amber
  '#10b981', // emerald
  '#d946ef', // fuchsia
  '#f43f5e', // rose
  '#65a30d', // olive
  '#7c3aed', // violet
  '#fbbf24', // gold
  '#4ade80', // bright green
  '#e879f9', // light magenta
  '#fb923c', // light orange
]

function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

function isFallbackLabel(name: string): boolean {
  return name === UNCLASSIFIED_CATEGORY || name === UNKNOWN_WEAPON_PART
}

/** 出現カテゴリを一意化して日本語順に並べる（色割当・凡例の共通キー）。 */
export function uniqueSortedCategories(categories: readonly string[]): string[] {
  return [...new Set(categories.map(c => c.trim() || UNCLASSIFIED_CATEGORY))]
    .sort((a, b) => a.localeCompare(b, 'ja'))
}

/**
 * カテゴリ名 → CSS 色。同じ名前は常に同じ色。
 * `presentCategories` を渡すと、出現中カテゴリだけを日本語順に並べてパレット先頭から割り当てる
 * （ハッシュだと近い色同士が偶然隣り合うのを避ける）。
 */
export function categoryColorOf(name: string, presentCategories?: readonly string[]): string {
  const trimmed = name.trim()
  if (!trimmed || isFallbackLabel(trimmed)) {
    return 'var(--text-muted)'
  }
  if (presentCategories && presentCategories.length > 0) {
    const colored = uniqueSortedCategories(presentCategories).filter(c => !isFallbackLabel(c))
    const idx = colored.indexOf(trimmed)
    if (idx >= 0) {
      return SCATTER_CATEGORY_PALETTE[idx % SCATTER_CATEGORY_PALETTE.length]
    }
  }
  return SCATTER_CATEGORY_PALETTE[hashString(trimmed) % SCATTER_CATEGORY_PALETTE.length]
}

/** 出現中カテゴリだけ並べた凡例（折り返し表示）。 */
export function buildCategoryColorLegend(label: string, categories: string[]): ColorLegend {
  const sorted = uniqueSortedCategories(categories)
  return {
    label,
    layout: 'chips',
    items: sorted.map(cat => ({ label: cat, color: categoryColorOf(cat, sorted) })),
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
