import { useState, type ReactNode } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { CustomChart, GroupedStatsRow, GroupedStatsRow2D, MetricKey } from '../types'
import { stageAbbr, modeLabel, ruleLabel, autoChartTitle, getMetric } from '../types'
import { SimpleBarChart } from './charts/SimpleBarChart'
import { AttackDefenseChart } from './charts/AttackDefenseChart'
import { StackedWinrateChart } from './charts/StackedWinrateChart'
import { LineChart } from './charts/LineChart'
import { CalendarHeatmapChart } from './charts/CalendarHeatmapChart'
import { HeatmapChart } from './charts/HeatmapChart'

/** yComposition ごとに用意する並び替えオプション。
 *  - stacked_winrate: バトル数 / 勝数 / 勝率
 *  - attack_defense:  キル数 / デス数 / キルレ（K/D 比）
 *  - single_metric:   並び替えなし（既に選択メトリクスが Y 軸なので自明）。 */
type SortOption = { key: MetricKey; label: string }
const SORT_OPTIONS_STACKED_WINRATE: SortOption[] = [
  { key: 'total',    label: 'バトル数' },
  { key: 'wins',     label: '勝数' },
  { key: 'win_rate', label: '勝率' },
]
const SORT_OPTIONS_ATTACK_DEFENSE: SortOption[] = [
  { key: 'avg_kill',  label: 'キル数' },
  { key: 'avg_death', label: 'デス数' },
  { key: 'avg_kd',    label: 'キルレ' },
]

/** 上位 14 件抽出 → 指定 MetricKey で降順ソート。null は最後尾。 */
function sortAndSlice(rows: GroupedStatsRow[], sortKey: MetricKey | null): GroupedStatsRow[] {
  const sliced = rows.slice(0, 14)
  if (!sortKey) return sliced
  return [...sliced].sort((a, b) => {
    const av = getMetric(a, sortKey) ?? -Infinity
    const bv = getMetric(b, sortKey) ?? -Infinity
    return bv - av
  })
}

/**
 * カスタムグラフ 1 枚分のカード。dnd-kit Sortable で並び替え可能、
 * 右上に「ドラッグハンドル / 設定 / 削除」ボタンを並べる。
 *
 * - X 軸ラベルの整形は groupBy に応じて自動：
 *   - stage → stageAbbr（省略 + 30° 斜め）
 *   - mode  → modeLabel
 *   - rule  → ruleLabel
 *   - その他 → そのまま
 * - yComposition に応じて並び替えボタンを常に表示
 *   （stacked_winrate / attack_defense のとき）。
 */
export function CustomChartCard({
  chart, data, data2d, onEdit, onDelete, weaponImages,
}: {
  chart:    CustomChart
  data:     GroupedStatsRow[]
  /** shape='heatmap' のときだけ使う 2D データ。 */
  data2d?:  GroupedStatsRow2D[]
  onEdit:   () => void
  onDelete: () => void
  /** 武器名 → 画像 URL の対応。X 軸が `weapon` のときラベルをアイコンに置換する。 */
  weaponImages?: Map<string, string>
}) {
  const sortable = useSortable({ id: chart.id })
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = sortable

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity:   isDragging ? 0.5 : 1,
  }

  // yComposition ごとに使う並び替え選択肢と既定値を決める。
  const sortOptions: SortOption[] =
    chart.yComposition === 'stacked_winrate' ? SORT_OPTIONS_STACKED_WINRATE :
    chart.yComposition === 'attack_defense'  ? SORT_OPTIONS_ATTACK_DEFENSE  :
                                                []
  const defaultSortKey = sortOptions[0]?.key ?? null
  const [sortKey, setSortKey] = useState<MetricKey | null>(defaultSortKey)

  // 軸キーに応じた表示整形（ステージは斜め）
  const nameTransform =
    chart.groupBy === 'stage' ? stageAbbr :
    chart.groupBy === 'mode'  ? modeLabel :
    chart.groupBy === 'rule'  ? ruleLabel :
                                undefined
  const tickAngle = chart.groupBy === 'stage' ? 30 : undefined

  // 上位 14 件を取って選択されたキーでソート。
  // 線グラフ・カレンダーは全データが必要なので slice しない。
  const sliced = (chart.shape === 'line' || chart.shape === 'calendar_heatmap')
    ? data
    : sortAndSlice(data, sortKey)

  return (
    <div className="chart-card custom-chart-card" ref={setNodeRef} style={style}>
      {/* 上段：ドラッグ・設定・削除（カスタムグラフ専用）。
          こうすることで下の chart-card-header は固定 4 グラフと同じ「title | 並び替え」レイアウトになる。 */}
      <div className="custom-chart-toprow">
        <button
          className="custom-chart-handle"
          {...attributes}
          {...listeners}
          aria-label="並び替え"
          title="ドラッグで並び替え"
        >⋮⋮</button>
        <button className="custom-chart-btn" onClick={onEdit}   aria-label="設定" title="設定">⚙</button>
        <button className="custom-chart-btn" onClick={onDelete} aria-label="削除" title="削除">✕</button>
      </div>
      <div className="chart-card-header">
        <h3 className="chart-title">{autoChartTitle(chart)}</h3>
        {sortOptions.length > 0 && (
          <div className="chart-sort-btns">
            {sortOptions.map(o => (
              <button
                key={o.key}
                className={`chart-sort-btn${sortKey === o.key ? ' active' : ''}`}
                onClick={() => setSortKey(o.key)}
              >{o.label}</button>
            ))}
          </div>
        )}
      </div>
      {renderChartBody(chart, sliced, data2d, nameTransform, tickAngle, weaponImages)}
    </div>
  )
}

/** shape × yComposition の組み合わせでチャートコンポーネントへディスパッチする。
 *  v1.0.0 は shape='bar' / 'line' を実装。scatter / heatmap は今後の PR。
 *  X 軸が `weapon` のときに限り、`weaponImages` を渡してアイコンラベルにする。 */
function renderChartBody(
  chart:         CustomChart,
  data:          GroupedStatsRow[],
  data2d:        GroupedStatsRow2D[] | undefined,
  nameTransform: ((s: string) => string) | undefined,
  tickAngle:     number | undefined,
  weaponImages:  Map<string, string> | undefined,
): ReactNode {
  // line: 時系列のみ。yComposition は single_metric を前提とする。
  if (chart.shape === 'line') {
    if (chart.yComposition === 'single_metric' && chart.metric) {
      return <LineChart data={data} metric={chart.metric} />
    }
    return (
      <div className="chart-not-implemented">
        この組み合わせ（line × {chart.yComposition}）はまだ未対応です。<br />
        「単一メトリクス」を選んでください。
      </div>
    )
  }

  // calendar_heatmap: 日別のみ。yComposition は single_metric 前提。
  if (chart.shape === 'calendar_heatmap') {
    if (chart.yComposition === 'single_metric' && chart.metric) {
      return <CalendarHeatmapChart data={data} metric={chart.metric} />
    }
    return (
      <div className="chart-not-implemented">
        カレンダーヒートマップは「単一メトリクス」を選んでください。
      </div>
    )
  }

  // heatmap: 2 軸クロス集計。X 軸 = chart.groupBy / Y 軸 = chart.groupBy2。
  if (chart.shape === 'heatmap') {
    if (!chart.groupBy2) {
      return <div className="chart-not-implemented">Y 軸 (groupBy2) を選んでください。</div>
    }
    if (chart.yComposition !== 'single_metric' || !chart.metric) {
      return <div className="chart-not-implemented">ヒートマップは「単一メトリクス」を選んでください。</div>
    }
    const xT = chart.groupBy  === 'stage' ? stageAbbr : chart.groupBy  === 'mode' ? modeLabel : chart.groupBy  === 'rule' ? ruleLabel : undefined
    const yT = chart.groupBy2 === 'stage' ? stageAbbr : chart.groupBy2 === 'mode' ? modeLabel : chart.groupBy2 === 'rule' ? ruleLabel : undefined
    return (
      <HeatmapChart
        data={data2d ?? []}
        metric={chart.metric}
        xLabelTransform={xT}
        yLabelTransform={yT}
      />
    )
  }

  if (chart.shape !== 'bar') {
    return (
      <div className="chart-not-implemented">
        この形（{chart.shape}）はまだ未実装です。<br />
        後続 PR で対応予定です。
      </div>
    )
  }
  // X 軸が武器のときだけ画像 tick を有効化。他の groupBy では undefined。
  const images = chart.groupBy === 'weapon' ? weaponImages : undefined

  if (chart.yComposition === 'single_metric' && chart.metric) {
    return <SimpleBarChart data={data} metric={chart.metric} nameTransform={nameTransform} tickAngle={tickAngle} images={images} />
  }
  if (chart.yComposition === 'stacked_winrate') {
    return <StackedWinrateChart data={data} nameTransform={nameTransform} tickAngle={tickAngle} images={images} />
  }
  if (chart.yComposition === 'attack_defense') {
    return <AttackDefenseChart data={data} nameTransform={nameTransform} tickAngle={tickAngle} images={images} />
  }
  return null
}
