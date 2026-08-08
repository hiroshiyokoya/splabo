import type { BattleRow } from '../types'
import type { ColorLegend, ScatterMarkerShape } from '../components/charts/ScatterChart'

/** 散布図のカテゴリ色分けキー（GROUP_BY_LABELS のキーと一致）。 */
export const SCATTER_CATEGORY_COLOR_KEYS = ['weapon_category', 'sub_weapon', 'special_weapon'] as const
export type ScatterCategoryColorKey = (typeof SCATTER_CATEGORY_COLOR_KEYS)[number]

export function isScatterCategoryColorKey(k: string | undefined | null): k is ScatterCategoryColorKey {
  return !!k && (SCATTER_CATEGORY_COLOR_KEYS as readonly string[]).includes(k)
}

/** ブキ名 → カテゴリ / サブ / スペシャル（ダッシュボードブキ集計ドット用）。 */
export type WeaponMeta = {
  category:       string
  sub_weapon:     string | null
  special_weapon: string | null
}

export const UNCLASSIFIED_CATEGORY = '(未分類)'
export const UNKNOWN_WEAPON_PART   = '(不明)'

/**
 * カテゴリ用の少数色（色相が大きく離れているものだけ）。
 * 同じ色は別の形と組み合わせて使うので、緑や青を何色も並べない。
 * 実色はテーマの CSS 変数（`--scatter-cat-*`）。デフォルトは現行パレット、
 * Solarized ではアクセント色に差し替わる（#527）。
 */
const CATEGORY_COLORS = [
  'var(--scatter-cat-1)',
  'var(--scatter-cat-2)',
  'var(--scatter-cat-3)',
  'var(--scatter-cat-4)',
  'var(--scatter-cat-5)',
  'var(--scatter-cat-6)',
]

/** カテゴリ用のマーカー形。色と直交する第2軸。 */
export const CATEGORY_SHAPES: ScatterMarkerShape[] = [
  'circle',
  'square',
  'triangle',
  'diamond',
  'cross',
  'star',
]

export type CategoryStyle = { color: string; shape: ScatterMarkerShape }

function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

function isFallbackLabel(name: string): boolean {
  return name === UNCLASSIFIED_CATEGORY || name === UNKNOWN_WEAPON_PART
}

/** 出現カテゴリを一意化して日本語順に並べる（割当・凡例の共通キー）。 */
export function uniqueSortedCategories(categories: readonly string[]): string[] {
  return [...new Set(categories.map(c => c.trim() || UNCLASSIFIED_CATEGORY))]
    .sort((a, b) => a.localeCompare(b, 'ja'))
}

/**
 * カテゴリ名 → { color, shape }。
 * 出現中カテゴリを日本語順に並べ、`色 = i % C` / `形 = ⌊i / C⌋` で組み合わせる。
 * 同じ色は別の形、同じ形は別の色になるので、色だけ・形だけの見分けに頼らない。
 */
export function categoryStyleOf(name: string, presentCategories?: readonly string[]): CategoryStyle {
  const trimmed = name.trim()
  if (!trimmed || isFallbackLabel(trimmed)) {
    return { color: 'var(--text-muted)', shape: 'circle' }
  }

  let idx: number
  if (presentCategories && presentCategories.length > 0) {
    const colored = uniqueSortedCategories(presentCategories).filter(c => !isFallbackLabel(c))
    const found = colored.indexOf(trimmed)
    idx = found >= 0 ? found : hashString(trimmed)
  } else {
    idx = hashString(trimmed)
  }

  const nColor = CATEGORY_COLORS.length
  return {
    color: CATEGORY_COLORS[idx % nColor],
    shape: CATEGORY_SHAPES[Math.floor(idx / nColor) % CATEGORY_SHAPES.length],
  }
}

/** @deprecated categoryStyleOf を使う。色のみが必要な互換用。 */
export function categoryColorOf(name: string, presentCategories?: readonly string[]): string {
  return categoryStyleOf(name, presentCategories).color
}

/** 出現中カテゴリの色×形凡例。 */
export function buildCategoryColorLegend(label: string, categories: string[]): ColorLegend {
  const sorted = uniqueSortedCategories(categories)
  return {
    label,
    layout: 'chips',
    encoding: 'color_shape',
    items: sorted.map(cat => {
      const style = categoryStyleOf(cat, sorted)
      return { label: cat, color: style.color, shape: style.shape }
    }),
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
