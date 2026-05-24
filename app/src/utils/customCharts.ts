import type { CustomChart, CustomChartType, GroupByKey, MetricKey } from '../types'

const STORAGE_KEY = 'chartoon:customCharts'

/** localStorage から読み込み。形式が壊れていたら空配列を返す。 */
export function loadCustomCharts(): CustomChart[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // 形式チェック：必須フィールドが揃っているものだけ残す（古いバージョンとの互換性のため）
    return parsed.filter((c): c is CustomChart =>
      typeof c === 'object' && c !== null &&
      typeof c.id === 'string' &&
      typeof c.title === 'string' &&
      typeof c.type === 'string' &&
      typeof c.groupBy === 'string'
    )
  } catch {
    return []
  }
}

/** localStorage に保存。 */
export function saveCustomCharts(charts: CustomChart[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(charts))
}

/** ランダムな ID を生成。crypto.randomUUID が無い環境向けにフォールバックも用意。 */
export function generateChartId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `chart-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`
}

/** 新規チャート作成用のデフォルト値。 */
export function newChartDefault(): CustomChart {
  return {
    id:      generateChartId(),
    title:   '新しいグラフ',
    type:    'simple_bar' as CustomChartType,
    groupBy: 'weapon' as GroupByKey,
    metric:  'win_rate' as MetricKey,
  }
}

/** カスタムグラフを全削除して localStorage からも消す（ダッシュボードをリセット）。 */
export function clearCustomCharts(): void {
  localStorage.removeItem(STORAGE_KEY)
}
