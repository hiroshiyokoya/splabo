import type { CustomChart, ChartShape, YComposition, GroupByKey, MetricKey } from '../types'

// splabo v0.8 統合(#241): キーは `splabo:shellCustomCharts`。
// 読み出しは新キー優先・旧 `chartoon:customCharts` フォールバック、書き込みは常に新キー。
const STORAGE_KEY     = 'splabo:shellCustomCharts'
const STORAGE_KEY_OLD = 'chartoon:customCharts'

/** 旧形式（v1: shape/yComposition 分離前、`type` 1 本、title あり）→ 新形式へ変換する。
 *  title はもう持たないので捨てる。 */
interface CustomChartV1 {
  id:      string
  title?:  string
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
    shape:        'bar' as ChartShape,
    yComposition,
    groupBy:      old.groupBy,
    metric:       old.metric,
  }
}

/** localStorage から読み込み。新旧両形式を許容し、新形式に正規化して返す。
 *  旧形式の `title` フィールドは捨てる（タイトルは常に autoChartTitle で算出するため）。 */
export function loadCustomCharts(): CustomChart[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(STORAGE_KEY_OLD)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const result: CustomChart[] = []
    for (const c of parsed) {
      if (typeof c !== 'object' || c === null) continue
      if (typeof c.id !== 'string' || typeof c.groupBy !== 'string') continue
      // 新形式：shape と yComposition が揃っているもの（title は無視）
      // CustomChart の全フィールドを明示的に復元する（#224）。
      // 将来 CustomChart が拡張されたときは型エラーで気づけるように明示列挙する。
      if (typeof c.shape === 'string' && typeof c.yComposition === 'string') {
        result.push({
          id:              c.id,
          shape:           c.shape,
          yComposition:    c.yComposition,
          groupBy:         c.groupBy,
          metric:          c.metric,
          groupBy2:        c.groupBy2,
          topN:            c.topN,
          xNumericMetric:  c.xNumericMetric,
          xBinWidth:       c.xBinWidth,
          yNumericMetric:  c.yNumericMetric,
          yBinWidth:       c.yBinWidth,
          dotUnit:         c.dotUnit,
          xMetric:         c.xMetric,
          yMetric:         c.yMetric,
          sizeMetric:      c.sizeMetric,
          colorMetric:     c.colorMetric,
        })
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

/** localStorage に保存。store（settings.json）へもミラーする（#241）。 */
export function saveCustomCharts(charts: CustomChart[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(charts))
  void import('./settingsStore').then(m => m.mirrorToStore())
}

/** ランダムな ID を生成。crypto.randomUUID が無い環境向けにフォールバックも用意。 */
export function generateChartId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `chart-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`
}

/** 新規チャート作成用のデフォルト値。タイトルは持たず autoChartTitle で算出される。 */
export function newChartDefault(): CustomChart {
  return {
    id:           generateChartId(),
    shape:        'bar',
    yComposition: 'single_metric',
    groupBy:      'weapon',
    metric:       'win_rate',
  }
}

/** カスタムグラフを全削除して localStorage からも消す（ダッシュボードをリセット）。 */
export function clearCustomCharts(): void {
  localStorage.removeItem(STORAGE_KEY)
  localStorage.removeItem(STORAGE_KEY_OLD)
  void import('./settingsStore').then(m => m.mirrorToStore())
}
