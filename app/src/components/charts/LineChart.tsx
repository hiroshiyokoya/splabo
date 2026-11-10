import {
  LineChart as RLineChart, Line, XAxis, YAxis, CartesianGrid, ResponsiveContainer, Tooltip,
} from 'recharts'
import i18n from '../../i18n'
import type { GroupedStatsRow, MetricKey, GroupByKey, AxisGroup, PowerSeries } from '../../types'
import {
  METRIC_LABELS, AXIS_GROUP_LABELS, getMetric, formatMetric, axisGroupOf, winCountTooltipText,
  SCATTER_WIN_COUNT_METRICS, X_POWER_METRIC_RULE, isPowerMetric,
} from '../../types'
import { buildTimeSeries, bucketKeyOf, formatTickDate, formatBucketLabel, type TimeSeriesSlot } from '../../utils/timeBuckets'

/** 系列の自動配色（#436）。1 系列目は既存の単一メトリクス折れ線と同じ accent を使う。 */
const LINE_COLORS = [
  'var(--accent)', 'var(--accent2)', 'var(--win)', 'var(--lose)', 'var(--draw)',
  '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16', '#6366f1',
]

/**
 * 線 1 本分。ふつうはメトリクス 1 つが 1 本だが、ブキチャレパワーはブキごとに 1 本ずつ出る（#914）。
 */
type LineSeries = {
  id:     string
  metric: MetricKey
  label:  string
  color:  string
  /** パワーの推移は値が無い期間をまたいで線をつなぐ（#914）。ほかは切る。 */
  connect: boolean
  value:  (slot: TimeSeriesSlot, key: string) => number | null
}

/** チャートデータ 1 点分（Tooltip の payload から取り出す元データ）。 */
type LinePoint = {
  t:      number
  label:  string
  row:    GroupedStatsRow | null
  values: Record<string, number | null>
}

/** ブキチャレパワーの線のブキ名。英語のときは英語名があれば使う。 */
function weaponLabel(w: PowerSeries['weapons'][number]): string {
  return i18n.language.startsWith('en') ? (w.name_en ?? w.name) : w.name
}

/**
 * メトリクスの並びから線を作る。ブキチャレパワーは、`power.weapons` の並び（使った回数が多い順）に 1 本ずつ。
 * 色は線の並びで順に割り当てる。
 */
function buildSeries(metrics: MetricKey[], power: PowerSeries | null | undefined): LineSeries[] {
  const out: Omit<LineSeries, 'color'>[] = []
  for (const m of metrics) {
    if (m === 'weapon_power') {
      if (!power) continue
      const multi = metrics.length > 1
      for (const w of power.weapons) {
        const byKey = new Map(power.weapon_power.filter(p => p.series === w.key).map(p => [p.key, p.value]))
        out.push({
          id: `weapon_power:${w.key}`,
          metric: m,
          // ほかのメトリクスと並ぶときは、何の線か分かるように名前を添える
          label: multi ? `${METRIC_LABELS[m]} ${weaponLabel(w)}` : weaponLabel(w),
          connect: true,
          value: (_s, key) => byKey.get(key) ?? null,
        })
      }
    } else if (isPowerMetric(m)) {
      const rule = X_POWER_METRIC_RULE[m]
      const byKey = new Map((power?.x_power ?? []).filter(p => p.series === rule).map(p => [p.key, p.value]))
      out.push({ id: m, metric: m, label: METRIC_LABELS[m], connect: true, value: (_s, key) => byKey.get(key) ?? null })
    } else {
      out.push({ id: m, metric: m, label: METRIC_LABELS[m], connect: false, value: s => (s.row ? getMetric(s.row, m) : null) })
    }
  }
  return out.map((s, i) => ({ ...s, color: LINE_COLORS[i % LINE_COLORS.length] }))
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
function LineTooltipContent({ active, payload, series }: {
  active?:  boolean
  payload?: ReadonlyArray<{ payload?: LinePoint }>
  series:   LineSeries[]
}) {
  if (!active || !payload || payload.length === 0) return null
  const point = payload[0]?.payload
  if (!point) return null
  // 欠測バケット（行も値も無い）の上ではツールチップ本体を出さない。
  const row = point.row
  if (!row && series.every(s => point.values[s.id] === null)) return null
  const hasWinCountMetric = series.some(s => SCATTER_WIN_COUNT_METRICS.has(s.metric))
  const shown = series.filter(s =>
    !(hasWinCountMetric && SCATTER_WIN_COUNT_METRICS.has(s.metric)) &&
    // パワーは値のある線だけ出す（ブキが多いと長くなるため）
    !(s.connect && point.values[s.id] === null))
  const winCountLine = row && row.total > 0 ? winCountTooltipText(row.total, row.wins, row.draws) : null
  return (
    <div className="line-tooltip">
      <div className="hover-tt-title">{point.label}</div>
      {shown.map(s => (
        <div key={s.id} className="hover-tt-row" style={{ color: s.color }}>
          {s.label}: {formatMetric(point.values[s.id], s.metric)}
        </div>
      ))}
      {winCountLine && (
        <div className={`hover-tt-row${shown.length > 0 ? ' hover-tt-row--muted' : ''}`}>{winCountLine}</div>
      )}
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
function LineAxisLegend({ series, axisOf, padLeft, padRight }: {
  series:   LineSeries[]
  axisOf:   (s: LineSeries) => 'left' | 'right'
  padLeft:  number
  padRight: number
}) {
  if (series.length <= 1) return null
  const item = (s: LineSeries) => (
    <span key={s.id} className="line-axis-legend-item" style={{ color: s.color }}>
      <span className="line-axis-legend-swatch" style={{ background: s.color }} />
      {s.label}
    </span>
  )
  return (
    <div
      className="line-axis-legend"
      style={{ paddingLeft: padLeft, paddingRight: padRight }}
    >
      <div className="line-axis-legend-side line-axis-legend-side--left">
        {series.filter(s => axisOf(s) === 'left').map(item)}
      </div>
      <div className="line-axis-legend-side line-axis-legend-side--right">
        {series.filter(s => axisOf(s) === 'right').map(item)}
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
 * - X パワー・ブキチャレパワー（#914）は `power` から取る。値の無い期間をまたいで線をつなぐ。
 *   ブキチャレパワーはブキごとに 1 本ずつ線を引く。
 * - 勝率グループの軸は固定 0–100% スケール、その他は相対スケール。
 * - 勝率以外の Y 軸目盛は整数（#639）。回/バトルが 1.5 のように割れるのを防ぐ。
 * - ツールチップは Recharts 標準 Tooltip（#443）。全系列の値を 1 つにまとめて表示。
 * - 二軸時は Y 軸に軸グループ名を出し、凡例を左右の軸側へ寄せる（#463）。
 */
export function LineChart({
  data, metrics, groupBy, power, height = 260,
}: {
  data:     GroupedStatsRow[]
  metrics:  MetricKey[]
  groupBy:  GroupByKey
  /** X パワー・ブキチャレパワー（#914）。そのメトリクスを選んでいないときは無くてよい。 */
  power?:   PowerSeries | null
  height?:  number
}) {
  const series = buildSeries(metrics, power)
  const powerKeys = metrics.some(isPowerMetric) && power
    ? [...power.x_power.map(p => p.key), ...power.weapon_power.map(p => p.key)]
    : []
  const slots = buildTimeSeries(data, groupBy, powerKeys)
  const chartData: LinePoint[] = slots.map(s => {
    const key = bucketKeyOf(new Date(s.t), groupBy)
    return {
      t:      s.t,
      label:  formatBucketLabel(s.t, groupBy),
      row:    s.row,
      values: Object.fromEntries(series.map(ls => [ls.id, ls.value(s, key)])),
    }
  })

  // 軸の左右割当: 最初に選んだ系列のグループ = 左軸、2 つ目に現れた別グループ = 右軸。
  // それ以降の同グループ系列は同じ軸に同居する（UI 側で軸グループは 2 つまでに制限済み）。
  const axisOfMetric = new Map<MetricKey, 'left' | 'right'>()
  let leftGroup: AxisGroup | null = null
  let rightGroup: AxisGroup | null = null
  for (const m of metrics) {
    const g = axisGroupOf(m)
    if (leftGroup === null || leftGroup === g) { leftGroup = g; axisOfMetric.set(m, 'left') }
    else { rightGroup = g; axisOfMetric.set(m, 'right') }
  }
  const axisOf = (s: LineSeries) => axisOfMetric.get(s.metric) ?? 'left'
  const hasRightAxis = rightGroup !== null

  const domainOf = (g: AxisGroup | null): [number, number] | ['auto', 'auto'] =>
    g === 'win_rate' ? [0, 1] : ['auto', 'auto']
  const tickFormatterOf = (g: AxisGroup | null) =>
    g === 'win_rate'
      ? (v: number) => `${(v * 100).toFixed(0)}%`
      : (v: number) => String(Math.round(v))

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
          allowDecimals={leftGroup === 'win_rate'}
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
            allowDecimals={rightGroup === 'win_rate'}
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
            <LineTooltipContent active={props.active} payload={props.payload} series={series} />}
        />
        {series.map(s => (
          <Line
            key={s.id}
            yAxisId={axisOf(s)}
            type="linear"
            dataKey={(d: LinePoint) => d.values[s.id]}
            name={s.label}
            stroke={s.color}
            strokeWidth={2}
            dot={{ fill: s.color, r: 1.5 }}
            activeDot={{ r: 2.5 }}
            connectNulls={s.connect}
            isAnimationActive={false}
          />
        ))}
      </RLineChart>
    </ResponsiveContainer>
    <LineAxisLegend
      series={series}
      axisOf={axisOf}
      padLeft={leftPad}
      padRight={rightPad + chartMarginRight}
    />
    </div>
  )
}
