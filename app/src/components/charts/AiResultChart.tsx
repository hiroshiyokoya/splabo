/**
 * AI 分析の結果を描くグラフ（#587）。
 *
 * 既存の `SimpleBarChart` / `LineChart` は `GroupedStatsRow` と `MetricKey` に強く
 * 結びついていて、**AI が返す任意の列を持つ結果は流せない**。ここは AI 用の汎用描画。
 *
 * 🔴 **点への振り分けは Rust（`ai_present`）が済ませている。** ここは受け取った系列を
 * recharts に渡すだけで、値の選別も並べ替えもしない。数値は SQLite が出したまま。
 */
import {
  Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer,
  Scatter, ScatterChart, Tooltip, XAxis, YAxis,
} from 'recharts'
import type { ShapedChart } from '../../types'

/** 系列の色。12 系列まで（Rust 側の上限と揃える）。 */
const COLORS = [
  '#4fc3f7', '#ff8a65', '#81c784', '#ba68c8', '#ffd54f', '#4db6ac',
  '#f06292', '#9575cd', '#aed581', '#64b5f6', '#ffb74d', '#a1887f',
]

const HEIGHT = 320

export function AiResultChart({ chart }: { chart: ShapedChart }) {
  if (chart.series.length === 0) return null

  const showLegend = chart.series.length > 1
  const axisProps = {
    stroke: 'var(--text-muted)',
    fontSize: 11,
  }

  return (
    <div className="ai-chart">
      <ResponsiveContainer width="100%" height={HEIGHT}>
        {chart.kind === 'scatter' ? (
          <ScatterChart margin={{ top: 8, right: 16, bottom: 24, left: 8 }}>
            <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
            {/* 散布図は x も数値。Rust 側が数値でなければ弾いている。 */}
            <XAxis type="number" dataKey="x" name={chart.x_label} {...axisProps}
                   label={{ value: chart.x_label, position: 'insideBottom', offset: -12, fill: 'var(--text-muted)', fontSize: 11 }} />
            <YAxis type="number" dataKey="y" name={chart.y_label} {...axisProps} />
            <Tooltip cursor={{ strokeDasharray: '3 3' }} />
            {showLegend && <Legend />}
            {chart.series.map((s, i) => (
              <Scatter key={s.name} name={s.name} data={s.points} fill={COLORS[i % COLORS.length]} />
            ))}
          </ScatterChart>
        ) : chart.kind === 'line' ? (
          <LineChart data={mergeByX(chart)} margin={{ top: 8, right: 16, bottom: 24, left: 8 }}>
            <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
            <XAxis dataKey="x" type={chart.x_numeric ? 'number' : 'category'} {...axisProps}
                   label={{ value: chart.x_label, position: 'insideBottom', offset: -12, fill: 'var(--text-muted)', fontSize: 11 }} />
            <YAxis {...axisProps} />
            <Tooltip />
            {showLegend && <Legend />}
            {chart.series.map((s, i) => (
              <Line key={s.name} type="monotone" dataKey={s.name} stroke={COLORS[i % COLORS.length]}
                    dot={false} connectNulls />
            ))}
          </LineChart>
        ) : (
          <BarChart data={mergeByX(chart)} margin={{ top: 8, right: 16, bottom: 24, left: 8 }}>
            <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="x" type={chart.x_numeric ? 'number' : 'category'} {...axisProps}
                   label={{ value: chart.x_label, position: 'insideBottom', offset: -12, fill: 'var(--text-muted)', fontSize: 11 }} />
            <YAxis {...axisProps} />
            <Tooltip />
            {showLegend && <Legend />}
            {chart.series.map((s, i) => (
              <Bar key={s.name} dataKey={s.name} fill={COLORS[i % COLORS.length]} />
            ))}
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  )
}

/**
 * 系列ごとの点列 → recharts の「1 行 = 1 つの x」形式にまとめる。
 *
 * 棒と折れ線は x をキーに横並びのデータを要求する（散布図は系列ごとに配れる）。
 * x の並びは**最初に出てきた順**。Rust 側が SQL の ORDER BY を保っているので、
 * ここで並べ替えると意図した順序が壊れる。
 */
function mergeByX(chart: ShapedChart): Record<string, string | number | null>[] {
  const order: (string | number)[] = []
  const byX = new Map<string | number, Record<string, string | number | null>>()

  for (const s of chart.series) {
    for (const p of s.points) {
      const key = p.x as string | number
      let row = byX.get(key)
      if (!row) {
        row = { x: key }
        byX.set(key, row)
        order.push(key)
      }
      row[s.name] = p.y
    }
  }
  return order.map(k => byX.get(k)!)
}
