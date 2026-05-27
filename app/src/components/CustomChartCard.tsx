import { useState, type ReactNode } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { CustomChart, GroupedStatsRow, GroupedStatsRow2D, BattleRow, MetricKey, BattleMetricKey } from '../types'
import {
  stageAbbr, modeLabel, ruleLabel, autoChartTitle, getMetric,
  METRIC_LABELS, BATTLE_METRIC_LABELS, formatMetric,
} from '../types'
import { SimpleBarChart } from './charts/SimpleBarChart'
import { AttackDefenseChart } from './charts/AttackDefenseChart'
import { StackedWinrateChart } from './charts/StackedWinrateChart'
import { LineChart } from './charts/LineChart'
import { CalendarHeatmapChart } from './charts/CalendarHeatmapChart'
import { HeatmapChart } from './charts/HeatmapChart'
import { ScatterChart, type ScatterPoint } from './charts/ScatterChart'

/** 1 バトル単位の散布図メトリクス値を BattleRow から計算する。 */
function getBattleMetric(b: BattleRow, k: BattleMetricKey): number | null {
  switch (k) {
    case 'kill':    return b.kill
    case 'death':   return b.death
    case 'assist':  return b.assist
    case 'kd':      return b.death === 0 ? null : b.kill / b.death
    case 'inked':   return b.inked
    case 'special': return b.special
  }
}

/** メトリクスキーから表示ラベル取得。バトル系・集計系の両方を扱う。 */
function metricLabelOf(k: string): string {
  if (k === 'win_lose')                  return '勝敗'
  if (k in BATTLE_METRIC_LABELS)         return BATTLE_METRIC_LABELS[k as BattleMetricKey]
  if (k in METRIC_LABELS)                return METRIC_LABELS[k as MetricKey]
  return k
}

/** 値の色マッピング。勝率は divergent、その他は accent 濃淡。 */
function colorOfValue(value: number | null, isRate: boolean, min: number, max: number): string {
  if (value === null) return 'var(--cell-empty)'
  if (isRate) {
    const t = (value - 0.5) * 2
    if (t < -0.4) return 'var(--cell-r1)'
    if (t < -0.1) return 'var(--cell-r2)'
    if (t <=  0.1) return 'var(--cell-r3)'
    if (t <=  0.4) return 'var(--cell-r4)'
    return 'var(--cell-r5)'
  }
  if (max <= min) return 'var(--cell-c3)'
  const t = (value - min) / (max - min)
  if (t <= 0.2) return 'var(--cell-c1)'
  if (t <= 0.4) return 'var(--cell-c2)'
  if (t <= 0.6) return 'var(--cell-c3)'
  if (t <= 0.8) return 'var(--cell-c4)'
  return 'var(--cell-c5)'
}

/** カテゴリ単位 (武器/ステージ) の散布図ポイントを作る。 */
function buildAggScatterPoints(
  data: GroupedStatsRow[],
  xKey: string, yKey: string, sizeKey?: string, colorKey?: string,
): ScatterPoint[] {
  const filtered = data.filter(d => d.total > 0)
  // 色マッピング用 min/max
  const colorIsRate = colorKey === 'win_rate'
  let cmin = Infinity, cmax = -Infinity
  if (colorKey) {
    for (const d of filtered) {
      const v = getMetric(d, colorKey as MetricKey)
      if (v === null) continue
      if (v < cmin) cmin = v
      if (v > cmax) cmax = v
    }
  }
  return filtered.map(d => {
    const x = getMetric(d, xKey as MetricKey)
    const y = getMetric(d, yKey as MetricKey)
    const size = sizeKey ? getMetric(d, sizeKey as MetricKey) : null
    const colorVal = colorKey ? getMetric(d, colorKey as MetricKey) : null
    return {
      name:  d.name,
      x,
      y,
      size,
      color: colorKey ? colorOfValue(colorVal, colorIsRate, cmin, cmax) : 'var(--accent)',
      tooltipRows: [
        { label: metricLabelOf(xKey), value: formatMetric(x, xKey as MetricKey) },
        { label: metricLabelOf(yKey), value: formatMetric(y, yKey as MetricKey) },
        ...(sizeKey ? [{ label: metricLabelOf(sizeKey), value: formatMetric(size, sizeKey as MetricKey), muted: true }] : []),
        ...(colorKey ? [{ label: metricLabelOf(colorKey), value: formatMetric(colorVal, colorKey as MetricKey), muted: true }] : []),
      ],
    }
  })
}

/** バトル単位の散布図ポイントを作る。整数軸 (キル/デス等) の重なりを見やすくするため
 *  ±0.15 のジッタを乗せる。表示上の位置だけずらして、ホバーには元の値を表示する。
 *  ジッタ後に 0 未満になる場合は 0 でクランプ (キル等の非負値メトリクス向け)。
 *  groupKey は (元の x, y) で重なり判定し、ツールチップで全件を並べて表示する。 */
function buildBattleScatterPoints(
  data: BattleRow[],
  xKey: string, yKey: string, sizeKey?: string, colorKey?: string,
): ScatterPoint[] {
  const jitter = () => (Math.random() - 0.5) * 0.3  // ±0.15
  const applyJitter = (v: number | null): number | null =>
    v === null ? null : Math.max(0, v + jitter())
  return data.map(b => {
    const x = getBattleMetric(b, xKey as BattleMetricKey)
    const y = getBattleMetric(b, yKey as BattleMetricKey)
    const size = sizeKey ? getBattleMetric(b, sizeKey as BattleMetricKey) : null
    let color = 'var(--accent)'
    if (colorKey === 'win_lose') {
      color = b.result === 'win'  ? 'var(--win)'
            : b.result === 'lose' ? 'var(--lose)'
            : 'var(--draw)'
    } else if (colorKey) {
      // バトル単位の連続値メトリクス。min/max は呼び出しごとに簡易計算 (ここでは accent 単色)
      color = 'var(--accent)'
    }
    const fmtBattle = (v: number | null) => v === null ? '—' : (typeof v === 'number' ? (Number.isInteger(v) ? v.toString() : v.toFixed(2)) : String(v))
    const name = `${b.played_at.slice(0, 10)} / ${b.weapon}`
    return {
      name,
      // 表示位置にジッタを乗せる (0 未満にはしない)
      x: applyJitter(x),
      y: applyJitter(y),
      size,
      color,
      // 重なり判定: 元の (x, y) が同じ点を 1 グループに
      groupKey: `${x ?? 'null'}|${y ?? 'null'}`,
      // 複数件表示時の 1 行: 日付・武器・勝敗
      rowText: `${b.played_at.slice(5, 10)} ${b.weapon}${colorKey === 'win_lose' ? '' : ` (${b.result})`}`,
      tooltipRows: [
        // ツールチップには元の値 (ジッタ前) を表示
        { label: metricLabelOf(xKey), value: fmtBattle(x) },
        { label: metricLabelOf(yKey), value: fmtBattle(y) },
        ...(sizeKey ? [{ label: metricLabelOf(sizeKey), value: fmtBattle(size), muted: true }] : []),
        ...(colorKey === 'win_lose'
          ? [{ label: '勝敗', value: b.result, muted: true }]
          : (colorKey ? [{ label: metricLabelOf(colorKey), value: fmtBattle(getBattleMetric(b, colorKey as BattleMetricKey)), muted: true }] : [])
        ),
      ],
    }
  })
}

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
  chart, data, data2d, battleData, onEdit, onDelete, weaponImages,
}: {
  chart:    CustomChart
  data:     GroupedStatsRow[]
  /** shape='heatmap' のときだけ使う 2D データ。 */
  data2d?:  GroupedStatsRow2D[]
  /** shape='scatter' で dotUnit='battle' のときの 1 バトル単位データ。 */
  battleData?: BattleRow[]
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
  // 線・カレンダー・散布図・ヒートマップは全データが必要なので slice しない。
  const sliced = (chart.shape === 'line' || chart.shape === 'calendar_heatmap' || chart.shape === 'scatter' || chart.shape === 'heatmap')
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
      {renderChartBody(chart, sliced, data2d, battleData, nameTransform, tickAngle, weaponImages)}
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
  battleData:    BattleRow[] | undefined,
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

  // scatter: ドット単位ごとに別データ。バトル単位 = battleData (BattleRow[])、
  // 武器/ステージ単位 = data (GroupedStatsRow[])。
  if (chart.shape === 'scatter') {
    if (!chart.xMetric || !chart.yMetric) {
      return <div className="chart-not-implemented">散布図には X 軸 / Y 軸 を選んでください。</div>
    }
    const isBattle = chart.dotUnit === 'battle'
    const points = isBattle
      ? buildBattleScatterPoints(battleData ?? [], chart.xMetric, chart.yMetric, chart.sizeMetric, chart.colorMetric)
      : buildAggScatterPoints(data, chart.xMetric, chart.yMetric, chart.sizeMetric, chart.colorMetric)
    return (
      <ScatterChart
        points={points}
        xLabel={metricLabelOf(chart.xMetric)}
        yLabel={metricLabelOf(chart.yMetric)}
        xIsRate={chart.xMetric === 'win_rate'}
        yIsRate={chart.yMetric === 'win_rate'}
        hasSize={!!chart.sizeMetric}
        // バトル単位は重なりが多いので透過を強める (ジッタと合わせて密度が見える)
        fillOpacity={isBattle ? 0.6 : 0.85}
        // サイズメトリクス未指定時の一定サイズ。武器/ステージはドットが少ないので大きめ。
        constSize={isBattle ? 120 : 280}
      />
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
        xNumeric={!!chart.xNumericMetric}
        yNumeric={!!chart.yNumericMetric}
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
  // X 軸が武器系（自分・味方・相手）のときだけ画像 tick を有効化。他の groupBy では undefined。
  const isWeaponAxis =
    chart.groupBy === 'weapon' ||
    chart.groupBy === 'ally_weapon' ||
    chart.groupBy === 'enemy_weapon'
  const images = isWeaponAxis ? weaponImages : undefined

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
