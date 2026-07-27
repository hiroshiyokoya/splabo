/**
 * 棒グラフ用の「指標で全件ソート → 上位 N 件」（#509）。
 *
 * 以前は「バトル数上位 N → その中で並べ替え」だったため、
 * 勝率順などにすると試合数が中位の行が落ちていた。
 */
export const CHART_BAR_TOP_N = 14

/** 勝率ソート時に候補へ入れる最低バトル数。 */
export const WIN_RATE_MIN_BATTLES = 5

export type ChartSortDir = 'desc' | 'asc'

/**
 * 選んだ指標で並べてから上位を返す。
 *
 * - 勝率ソート時は `getTotal(row) < minBattlesForWinRate` を除外
 * - 値が null の行は降順では末尾、昇順では先頭側（Infinity 扱い）
 */
export function rankRowsForBarChart<T>(
  rows: readonly T[],
  {
    getSortValue,
    getTotal,
    sortByWinRate,
    topN = CHART_BAR_TOP_N,
    dir = 'desc',
    minBattlesForWinRate = WIN_RATE_MIN_BATTLES,
  }: {
    getSortValue: (row: T) => number | null
    getTotal: (row: T) => number
    sortByWinRate: boolean
    topN?: number
    dir?: ChartSortDir
    minBattlesForWinRate?: number
  },
): T[] {
  const ascending = dir === 'asc'
  let pool = rows.slice()
  if (sortByWinRate) {
    pool = pool.filter(r => getTotal(r) >= minBattlesForWinRate)
  }
  pool.sort((a, b) => {
    const av = getSortValue(a)
    const bv = getSortValue(b)
    const aKey = av ?? (ascending ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY)
    const bKey = bv ?? (ascending ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY)
    return ascending ? aKey - bKey : bKey - aKey
  })
  return pool.slice(0, topN)
}
