import {
  LineChart as RLineChart, Line, XAxis, YAxis, CartesianGrid, ResponsiveContainer, Tooltip,
} from 'recharts'
import type { GroupedStatsRow, MetricKey, GroupByKey, AxisGroup } from '../../types'
import { METRIC_LABELS, AXIS_GROUP_LABELS, getMetric, formatMetric, axisGroupOf } from '../../types'
import { buildTimeSeries, formatTickDate, formatBucketLabel } from '../../utils/timeBuckets'

/** 系列の自動配色（#436）。1 系列目は既存の単一メトリクス折れ線と同じ accent を使う。 */
const LINE_COLORS = [
  'var(--accent)', 'var(--accent2)', 'var(--win)', 'var(--lose)', 'var(--draw)',
  '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16', '#6366f1',
]

/** チャートデータ 1 点分（Tooltip の payload から取り出す元データ）。 */
type LinePoint = {
  t:      number
  label:  string
  row:    GroupedStatsRow | null
  values: Record<MetricKey, number | null>
}

/**
 * Recharts 標準 Tooltip の中身（#443）。
 *
 * 自前の index 比例オーバーレイ（旧 HoverTooltip）は、X 軸を実時間軸（number 軸）に
 * した #436 で位置が合わなくなり、さらに Recharts v3 では number 軸の
 * `activeTooltipIndex` が文字列/null で返るため index 判定自体が壊れていた
 * （ツールチップが一切出なくなっていた）。折れ線は X 軸にアイコンが無く日付ラベル
 * だけなので、標準 Tooltip に最寄り点判定と位置合わせを任せ、content で全系列の値を
 * まとめて表示する。
 */
function LineTooltipContent({ active, payload, metrics }: {
  active?:  boolean
  payload?: ReadonlyArray<{ payload?: LinePoint }>
  metrics:  MetricKey[]
}) {
  if (!active || !payload || payload.length === 0) return null
  const point = payload[0]?.payload
  // 欠測バケット（row=null）の上ではツールチップ本体を出さない。
  if (!point || !point.row) return null
  return (
    <div className="line-tooltip">
      <div className="hover-tt-title">{point.label}</div>
      {metrics.map((m, i) => (
        <div key={m} className="hover-tt-row" style={{ color: LINE_COLORS[i % LINE_COLORS.length] }}>
          {METRIC_LABELS[m]}: {formatMetric(point.values[m], m)}
        </div>
      ))}
      <div className="hover-tt-row hover-tt-row--muted">バトル数: {point.row.total}</div>
    </div>
  )
}

/**
 * 複数系列の凡例（#463）。
 *
 * Recharts 標準 Legend だと左右どちらに載っているかが分からないので、系列を
 * 左軸／右軸に分け、それぞれ左寄せ・右寄せで並べる。1 系列だけのときは出さない。
 * padLeft / padRight はチャート本体の Y 軸幅＋余白に合わせ、凡例を描画域の枠内に収める。
 */
function LineAxisLegend({ metrics, axisOf, padLeft, padRight }: {
  metrics:  MetricKey[]
  axisOf:   Map<MetricKey, 'left' | 'right'>
  padLeft:  number
  padRight: number
}) {
  if (metrics.length <= 1) return null
  const left  = metrics.filter(m => axisOf.get(m) === 'left')
  const right = metrics.filter(m => axisOf.get(m) === 'right')
  const item = (m: MetricKey) => {
    const i = metrics.indexOf(m)
    const color = LINE_COLORS[i % LINE_COLORS.length]
    return (
      <span key={m} className="line-axis-legend-item" style={{ color }}>
        <span className="line-axis-legend-swatch" style={{ background: color }} />
        {METRIC_LABELS[m]}
      </span>
    )
  }
  return (
    <div
      className="line-axis-legend"
      style={{ paddingLeft: padLeft, paddingRight: padRight }}
    >
      <div className="line-axis-legend-side line-axis-legend-side--left">
        {left.map(item)}
      </div>
      <div className="line-axis-legend-side line-axis-legend-side--right">
        {right.map(item)}
      </div>
    </div>
  )
}

/** Y 軸ラベル（軸グループ名）の共通スタイル。 */
const axisLabelStyle = {
  fill: 'var(--text)',
  fontSize: 10,
  fontWeight: 600,
} as const

/**
 * 時系列の線グラフ。X 軸は db_grouped_stats が返す時系列キー（日 / 3日 / 週 / 月）。
 *
 * - 複数メトリクス対応（#436）。軸グループごとに左右 2 軸へ自動割当。
 * - X 軸は実時間軸（timestamp の number 軸）。欠測バケットは null 埋めして線を切る
 *   （connectNulls={false}）。孤立バケット（両隣が欠測）は点のみ描かれる。
 * - 勝率グループの軸は固定 0–100% スケール、その他は相対スケール。
 * - ツールチップは Recharts 標準 Tooltip（#443）。全系列の値を 1 つにまとめて表示。
 * - 二軸時は Y 軸に軸グループ名を出し、凡例を左右の軸側へ寄せる（#463）。
 */
export function LineChart({
  data, metrics, groupBy, height = 260,
}: {
  data:     GroupedStatsRow[]
  metrics:  MetricKey[]
  groupBy:  GroupByKey
  height?:  number
}) {
  const slots = buildTimeSeries(data, groupBy)
  const chartData: LinePoint[] = slots.map(s => ({
    t:      s.t,
    label:  formatBucketLabel(s.t, groupBy),
    row:    s.row,
    values: Object.fromEntries(metrics.map(m => [m, s.row ? getMetric(s.row, m) : null])) as Record<MetricKey, number | null>,
  }))

  // 軸の左右割当: 最初に選んだ系列のグループ = 左軸、2 つ目に現れた別グループ = 右軸。
  // それ以降の同グループ系列は同じ軸に同居する（UI 側で軸グループは 2 つまでに制限済み）。
  const axisOf = new Map<MetricKey, 'left' | 'right'>()
  let leftGroup: AxisGroup | null = null
  let rightGroup: AxisGroup | null = null
  for (const m of metrics) {
    const g = axisGroupOf(m)
    if (leftGroup === null || leftGroup === g) { leftGroup = g; axisOf.set(m, 'left') }
    else { rightGroup = g; axisOf.set(m, 'right') }
  }
  const hasRightAxis = rightGroup !== null

  const domainOf = (g: AxisGroup | null): [number, number] | ['auto', 'auto'] =>
    g === 'win_rate' ? [0, 1] : ['auto', 'auto']
  const tickFormatterOf = (g: AxisGroup | null) =>
    g === 'win_rate' ? (v: number) => `${(v * 100).toFixed(0)}%` : undefined

  // 軸グループ名の縦書きラベルぶん、少し余白を取る。
  // margin.right は Recharts のプロット右端余白。凡例の左右パディングは
  // Y 軸幅＋この余白に合わせ、描画域（枠）の内側に揃える。
  const chartMarginRight = 8
  const leftPad  = 48
  const rightPad = hasRightAxis ? 48 : 8

  return (
    <div className="chart-hover-area">
    <ResponsiveContainer width="100%" height={height}>
      <RLineChart data={chartData} margin={{ top: 4, right: chartMarginRight, left: 0, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
        <XAxis
          dataKey="t"
          type="number"
          domain={['dataMin', 'dataMax']}
          tickFormatter={formatTickDate}
          height={28}
          tick={{ fill: 'var(--text)', fontSize: 10, fontWeight: 600 } as object}
        />
        <YAxis
          yAxisId="left"
          tick={{ fill: 'var(--text)', fontSize: 10, fontWeight: 600 } as object}
          width={leftPad}
          tickFormatter={tickFormatterOf(leftGroup)}
          domain={domainOf(leftGroup)}
          label={leftGroup ? {
            value: AXIS_GROUP_LABELS[leftGroup],
            angle: -90,
            position: 'insideLeft',
            offset: 8,
            style: axisLabelStyle,
          } : undefined}
        />
        {hasRightAxis && rightGroup && (
          <YAxis
            yAxisId="right"
            orientation="right"
            tick={{ fill: 'var(--text)', fontSize: 10, fontWeight: 600 } as object}
            width={rightPad}
            tickFormatter={tickFormatterOf(rightGroup)}
            domain={domainOf(rightGroup)}
            label={{
              value: AXIS_GROUP_LABELS[rightGroup],
              angle: 90,
              position: 'insideRight',
              offset: 8,
              style: axisLabelStyle,
            }}
          />
        )}
        <Tooltip
          cursor={{ stroke: 'var(--border)', strokeDasharray: '3 3' }}
          isAnimationActive={false}
          content={(props: any) =>
            <LineTooltipContent active={props.active} payload={props.payload} metrics={metrics} />}
        />
        {metrics.map((m, i) => (
          <Line
            key={m}
            yAxisId={axisOf.get(m)}
            type="linear"
            dataKey={(d: LinePoint) => d.values[m]}
            name={METRIC_LABELS[m]}
            stroke={LINE_COLORS[i % LINE_COLORS.length]}
            strokeWidth={2}
            dot={{ fill: LINE_COLORS[i % LINE_COLORS.length], r: 1.5 }}
            activeDot={{ r: 2.5 }}
            connectNulls={false}
            isAnimationActive={false}
          />
        ))}
      </RLineChart>
    </ResponsiveContainer>
    <LineAxisLegend
      metrics={metrics}
      axisOf={axisOf}
      padLeft={leftPad}
      padRight={rightPad + chartMarginRight}
    />
    </div>
  )
}
