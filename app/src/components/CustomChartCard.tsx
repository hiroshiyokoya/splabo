import type { ReactNode } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { CustomChart, GroupedStatsRow } from '../types'
import { stageAbbr, modeLabel, ruleLabel } from '../types'
import { SimpleBarChart } from './charts/SimpleBarChart'
import { AttackDefenseChart } from './charts/AttackDefenseChart'
import { StackedWinrateChart } from './charts/StackedWinrateChart'

/**
 * カスタムグラフ 1 枚分のカード。dnd-kit Sortable で並び替え可能、
 * 右上に「ドラッグハンドル / 設定 / 削除」ボタンを並べる。
 *
 * - X 軸ラベルの整形は groupBy に応じて自動：
 *   - stage → stageAbbr（省略 + 30° 斜め）
 *   - mode  → modeLabel
 *   - rule  → ruleLabel
 *   - その他 → そのまま
 */
export function CustomChartCard({
  chart, data, onEdit, onDelete,
}: {
  chart:    CustomChart
  data:     GroupedStatsRow[]
  onEdit:   () => void
  onDelete: () => void
}) {
  const sortable = useSortable({ id: chart.id })
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = sortable

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity:   isDragging ? 0.5 : 1,
  }

  // 軸キーに応じた表示整形（ステージは斜め）
  const nameTransform =
    chart.groupBy === 'stage' ? stageAbbr :
    chart.groupBy === 'mode'  ? modeLabel :
    chart.groupBy === 'rule'  ? ruleLabel :
                                undefined
  const tickAngle = chart.groupBy === 'stage' ? 30 : undefined

  // 描画件数は上位 14 件まで（既存のデフォルトカードと揃える）
  const sliced = data.slice(0, 14)

  return (
    <div className="chart-card custom-chart-card" ref={setNodeRef} style={style}>
      <div className="chart-card-header">
        <h3 className="chart-title">{chart.title}</h3>
        <div className="custom-chart-actions">
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
      </div>
      {renderChartBody(chart, sliced, nameTransform, tickAngle)}
    </div>
  )
}

/** shape × yComposition の組み合わせでチャートコンポーネントへディスパッチする。
 *  v1.0.0 は shape='bar' の 3 構成のみ実装。それ以外の shape は「未実装」プレースホルダ。 */
function renderChartBody(
  chart:         CustomChart,
  data:          GroupedStatsRow[],
  nameTransform: ((s: string) => string) | undefined,
  tickAngle:     number | undefined,
): ReactNode {
  if (chart.shape !== 'bar') {
    return (
      <div className="chart-not-implemented">
        この形（{chart.shape}）は v1.0.0 では未実装です。<br />
        v1.1+ で対応予定です。
      </div>
    )
  }
  if (chart.yComposition === 'single_metric' && chart.metric) {
    return <SimpleBarChart data={data} metric={chart.metric} nameTransform={nameTransform} tickAngle={tickAngle} />
  }
  if (chart.yComposition === 'stacked_winrate') {
    return <StackedWinrateChart data={data} nameTransform={nameTransform} tickAngle={tickAngle} />
  }
  if (chart.yComposition === 'attack_defense') {
    return <AttackDefenseChart data={data} nameTransform={nameTransform} tickAngle={tickAngle} />
  }
  return null
}
