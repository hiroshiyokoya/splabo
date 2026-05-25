import type { CustomChart, ChartShape, YComposition, GroupByKey, MetricKey } from '../types'

const STORAGE_KEY = 'chartoon:customCharts'

/** 旧形式（v1: shape/yComposition 分離前、`type` 1 本）→ 新形式へ変換する。
 *  PR #114 のローカル試用で旧形式が保存されているケースに備えて入れている。 */
interface CustomChartV1 {
  id:      string
  title:   string
  type:    'simple_bar' | 'stacked_winrate' | 'attack_defense'
  groupBy: GroupByKey
  metric?: MetricKey
}

function migrateV1(old: CustomChartV1): CustomChart {
  const yComposition: YComposition =
    old.type === 'simple_bar'      ? 'single_metric'   :
    old.type === 'stacked_winrate' ? 'stacked_winrate' :
                                     'attack_defense'
  return {
    id:           old.id,
    title:        old.title,
    shape:        'bar' as ChartShape,
    yComposition,
    groupBy:      old.groupBy,
    metric:       old.metric,
  }
}

/** localStorage から読み込み。新旧両形式を許容し、新形式に正規化して返す。 */
export function loadCustomCharts(): CustomChart[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const result: CustomChart[] = []
    for (const c of parsed) {
      if (typeof c !== 'object' || c === null) continue
      if (typeof c.id !== 'string' || typeof c.title !== 'string' || typeof c.groupBy !== 'string') continue
      // 新形式：shape と yComposition が揃っているもの
      if (typeof c.shape === 'string' && typeof c.yComposition === 'string') {
        result.push(c as CustomChart)
        continue
      }
      // 旧形式：type フィールドのみ → マイグレーション
      if (typeof c.type === 'string') {
        result.push(migrateV1(c as CustomChartV1))
        continue
      }
      // 不明形式はスキップ
    }
    return result
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
    id:           generateChartId(),
    title:        '新しいグラフ',
    shape:        'bar',
    yComposition: 'single_metric',
    groupBy:      'weapon',
    metric:       'win_rate',
  }
}

/** カスタムグラフを全削除して localStorage からも消す（ダッシュボードをリセット）。 */
export function clearCustomCharts(): void {
  localStorage.removeItem(STORAGE_KEY)
}
