import { useState } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, ResponsiveContainer, Cell,
} from 'recharts'
import type { GroupedStatsRow, MetricKey } from '../../types'
import { METRIC_LABELS, getMetric, formatMetric, isOfficialRateMetric, fmtOfficialDate } from '../../types'
import { categoryTick } from './CategoryTick'
import { HoverTooltip } from './HoverTooltip'
import { WIN_RATE_HI, WIN_RATE_LO, WIN_RATE_MID } from '../../utils/heatmapColors'

/**
 * 単一メトリクスを棒で見せるシンプルなチャート。
 *
 * - X 軸: カテゴリ名（ブキ・ステージ・ルール等）
 * - Y 軸: 選んだ 1 メトリクスの値
 * - 勝率系はバーごとに段階色（hi/mid/lo）
 * - それ以外はバーの値の大きさに応じてアクセント色を濃淡で変化させる
 *   （大きい値ほど accent が濃く、小さい値ほど surface 寄りで淡い）
 * - 値が null のカテゴリ（detail_fetched=0 しかない等）はバーを描かず、ツールチップで「—」表示
 */
export function SimpleBarChart({
  data, metric, height = 260, nameTransform, tickAngle, images,
}: {
  data:           GroupedStatsRow[]
  metric:         MetricKey
  height?:        number
  /** X 軸ラベルの整形（ステージ名の省略など）。 */
  nameTransform?: (name: string) => string
  /** X 軸ラベルを斜めに表示する角度（度）。ステージ名のように長いラベルで活用。 */
  tickAngle?:     number
  /** カテゴリ → 画像 URL の対応。ブキアイコン等を X 軸ラベルとして描く。 */
  images?:        Map<string, string>
}) {
  const hasImages = !!images && data.some(d => images.has(d.name))
  const [activeIndex, setActiveIndex] = useState<number | null>(null)

  const chartData = data.map(d => ({
    name:    d.name,
    value:   getMetric(d, metric),
    rawRow:  d,
  }))

  // 値に応じた色グラデーションのためにレンジを取る。
  // 勝率は閾値色を別系統で出すので除外。null も除外。
  const numericValues = chartData
    .map(d => d.value)
    .filter((v): v is number => v !== null)
  const minValue = numericValues.length > 0 ? Math.min(...numericValues) : 0
  const maxValue = numericValues.length > 0 ? Math.max(...numericValues) : 1

  /** 値の大きさに応じたバー色。勝率は段階色、それ以外は accent の濃淡。 */
  function barColor(value: number | null): string {
    if (value === null) return 'transparent'
    if (isOfficialRateMetric(metric)) {
      if (value >= 0.55) return 'url(#grad-rate-hi)'
      if (value >= 0.45) return 'url(#grad-rate-mid)'
      return 'url(#grad-rate-lo)'
    }
    // (value - min) / (max - min) を 0-1 に正規化し、accent 比率に反映。
    // 値域が 0 だと max==min なので保険で 1 を返す。
    const t = maxValue === minValue ? 1 : (value - minValue) / (maxValue - minValue)
    // 30%（淡い）～ 95%（濃い）の範囲で混色。完全に bg にすると見えなくなるので下限を残す。
    const pct = Math.round((0.30 + 0.65 * t) * 100)
    return `color-mix(in srgb, var(--accent) ${pct}%, var(--surface))`
  }

  function cellOpacity(i: number) {
    return activeIndex === null || activeIndex === i ? 1 : 0.35
  }

  // YAxis 幅 42 + 右マージン 8。HoverTooltip の位置計算に使う。
  const leftPad  = 42
  const rightPad = 8

  return (
    <div className="chart-hover-area" style={{ position: 'relative' }}>
    <ResponsiveContainer width="100%" height={height}>
      <BarChart
        data={chartData}
        margin={{ top: 4, right: 8, left: 0, bottom: 4 }}
        onMouseLeave={() => setActiveIndex(null)}
      >
        <defs>
          <linearGradient id="grad-accent" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor="var(--accent)" stopOpacity="0.95" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.50" />
          </linearGradient>
          {/* 勝率用の色は Dashboard.tsx の WinRateChart 内 gradients と同名で揃える */}
          <linearGradient id="grad-rate-hi" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={WIN_RATE_HI} stopOpacity="0.95" />
            <stop offset="100%" stopColor={WIN_RATE_HI} stopOpacity="0.5" />
          </linearGradient>
          <linearGradient id="grad-rate-mid" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={WIN_RATE_MID} stopOpacity="0.95" />
            <stop offset="100%" stopColor={WIN_RATE_MID} stopOpacity="0.5" />
          </linearGradient>
          <linearGradient id="grad-rate-lo" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={WIN_RATE_LO} stopOpacity="0.95" />
            <stop offset="100%" stopColor={WIN_RATE_LO} stopOpacity="0.5" />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
        <XAxis
          dataKey="name"
          interval={0}
          height={hasImages ? 40 : tickAngle ? 44 : 28}
          // 画像 tick がある場合は categoryTick、無い場合は組み込みテキスト
          // （Dashboard 上部の WinRateChart の ImageTick と表示位置を揃える）
          tick={hasImages ? categoryTick({ images, tickAngle, nameTransform, activeIndex, onHoverIndex: setActiveIndex }) : ({ fill: 'var(--text)', fontSize: 10, fontWeight: 600 } as object)}
          tickFormatter={hasImages ? undefined : nameTransform}
          angle={hasImages ? undefined : tickAngle ? tickAngle : undefined}
          textAnchor={hasImages ? undefined : tickAngle ? 'start' : 'middle'}
        />
        <YAxis
          tick={{ fill: 'var(--text)', fontSize: 10, fontWeight: 600 } as object}
          width={metric === 'official_last_used_at' ? 72 : 42}
          tickFormatter={
            isOfficialRateMetric(metric) ? (v: number) => `${(v * 100).toFixed(0)}%`
            : metric === 'official_last_used_at' ? (v: number) => fmtOfficialDate(v)
            : undefined
          }
        />
        <Bar dataKey="value" maxBarSize={32} radius={[4, 4, 0, 0]} activeBar={false}
          onMouseEnter={(_: any, i: number) => setActiveIndex(i)}
        >
          {chartData.map((d, i) => (
            <Cell key={i} fill={barColor(d.value)} fillOpacity={cellOpacity(i)} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
    <HoverTooltip activeIndex={activeIndex} dataLength={chartData.length} leftPad={leftPad} rightPad={rightPad}>
      {activeIndex != null && (() => {
        const p = chartData[activeIndex]
        const displayLabel = nameTransform ? nameTransform(p.name) : p.name
        return (
          <>
            <div className="hover-tt-title">{displayLabel}</div>
            <div className="hover-tt-row">{METRIC_LABELS[metric]}: {formatMetric(p.value, metric)}</div>
            <div className="hover-tt-row hover-tt-row--muted">{METRIC_LABELS.total}: {p.rawRow.total}</div>
          </>
        )
      })()}
    </HoverTooltip>
    </div>
  )
}
