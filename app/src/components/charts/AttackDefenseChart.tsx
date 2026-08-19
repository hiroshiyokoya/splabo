import { useState } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, ResponsiveContainer, Cell, Legend,
} from 'recharts'
import { METRIC_LABELS, type GroupedStatsRow } from '../../types'
import { categoryTick } from './CategoryTick'
import { HoverTooltip } from './HoverTooltip'

/** スタック最上段のセグメントだけ上端を角丸にする shape。
 *  Recharts の `radius` を全 stack に付けると境目に凹みが出るので shape で制御する。
 *  Dashboard.tsx の `stackTopRoundedShape` と同思想だが、こちらは attack スタック（kill 下・assist 上）専用。 */
function attackStackTopRoundedShape(props: any) {
  const { x, y, width, height, fill, fillOpacity, payload, dataKey } = props
  if (height <= 0) return null
  const isTop =
    (dataKey === 'assist' && payload.assist > 0) ||
    (dataKey === 'kill'   && payload.assist === 0 && payload.kill > 0)
  const r = isTop ? Math.min(4, height / 2, width / 2) : 0
  if (r === 0) {
    return <rect x={x} y={y} width={width} height={height} fill={fill} fillOpacity={fillOpacity} />
  }
  const d =
    `M ${x},${y + r} Q ${x},${y} ${x + r},${y} ` +
    `L ${x + width - r},${y} Q ${x + width},${y} ${x + width},${y + r} ` +
    `L ${x + width},${y + height} L ${x},${y + height} Z`
  return <path d={d} fill={fill} fillOpacity={fillOpacity} />
}

/**
 * 「攻撃 vs デス」セットチャート。カテゴリごとに以下の 2 本を並べる：
 *
 *   1. 攻撃バー = 平均キル（緑） + 平均アシスト（灰、積み上げ）
 *   2. デスバー = 平均デス（赤）
 *
 * 「キル + 補助でどれだけ貢献できているか」と「死にやすさ」を 1 グラフで対比できる。
 * Recharts では同 stackId のバーが積み上がり、別 stackId のバーが横に並ぶことを利用して、
 * `stackId="attack"` の 2 本（K+A）と `stackId="defense"` の 1 本（D）で 2 グループバーを表現する。
 */
export function AttackDefenseChart({
  data, height = 280, nameTransform, tickAngle, images,
}: {
  data:           GroupedStatsRow[]
  height?:        number
  nameTransform?: (name: string) => string
  /** X 軸ラベルを斜めに表示する角度。長いラベル（ステージ名など）向け。 */
  tickAngle?:     number
  /** カテゴリ → 画像 URL の対応。ブキアイコン等を X 軸ラベルとして描く。 */
  images?:        Map<string, string>
}) {
  const hasImages = !!images && data.some(d => images.has(d.name))
  const [activeIndex, setActiveIndex] = useState<number | null>(null)

  const chartData = data.map(d => ({
    name:    d.name,
    kill:    d.avg_kill   ?? 0,
    assist:  d.avg_assist ?? 0,
    death:   d.avg_death  ?? 0,
    rawRow:  d,
  }))

  function cellOpacity(i: number) {
    return activeIndex === null || activeIndex === i ? 1 : 0.35
  }

  // YAxis 幅 36 + 右マージン 8。HoverTooltip 位置計算用。
  const leftPad  = 36
  const rightPad = 8

  return (
    <div className="chart-hover-area" style={{ position: 'relative' }}>
    <ResponsiveContainer width="100%" height={height}>
      <BarChart
        data={chartData}
        margin={{ top: 8, right: 8, left: 0, bottom: 4 }}
        barCategoryGap="20%"
        onMouseLeave={() => setActiveIndex(null)}
      >
        <defs>
          <linearGradient id="grad-kill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor="#22c55e" stopOpacity="0.95" />
            <stop offset="100%" stopColor="#22c55e" stopOpacity="0.50" />
          </linearGradient>
          <linearGradient id="grad-assist" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor="#9ca3af" stopOpacity="0.85" />
            <stop offset="100%" stopColor="#9ca3af" stopOpacity="0.40" />
          </linearGradient>
          <linearGradient id="grad-death" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor="#ef4444" stopOpacity="0.95" />
            <stop offset="100%" stopColor="#ef4444" stopOpacity="0.50" />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
        <XAxis
          dataKey="name"
          interval={0}
          height={hasImages ? 40 : tickAngle ? 44 : 28}
          tick={hasImages ? categoryTick({ images, tickAngle, nameTransform, activeIndex, onHoverIndex: setActiveIndex }) : ({ fill: 'var(--text)', fontSize: 10, fontWeight: 600 } as object)}
          tickFormatter={hasImages ? undefined : nameTransform}
          angle={hasImages ? undefined : tickAngle ? tickAngle : undefined}
          textAnchor={hasImages ? undefined : tickAngle ? 'start' : 'middle'}
        />
        <YAxis
          tick={{ fill: 'var(--text)', fontSize: 10, fontWeight: 600 } as object}
          width={36}
        />
        {/* 角丸の小さなスウォッチで凡例を描く（Recharts デフォルトの四角アイコンは黒くて分かりにくい）。
            Recharts の payload は stack 順で並ぶことがあり期待と違うので、ここで「キル → アシスト → デス」固定で描く。 */}
        <Legend
          content={() => (
            <div style={{ display: 'flex', justifyContent: 'center', gap: 14, fontSize: 11, paddingTop: 4 }}>
              {[
                { color: '#22c55e', label: METRIC_LABELS.avg_kill },
                { color: '#9ca3af', label: METRIC_LABELS.avg_assist },
                { color: '#ef4444', label: METRIC_LABELS.avg_death },
              ].map(item => (
                <span key={item.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span
                    style={{
                      display:      'inline-block',
                      width:        16,
                      height:       10,
                      background:   item.color,
                      borderRadius: 3,
                    }}
                    aria-hidden="true"
                  />
                  <span style={{ color: 'var(--text)' }}>{item.label}</span>
                </span>
              ))}
            </div>
          )}
        />
        {/* 攻撃バー: K の上に A を積み上げ。shape でスタック最上段だけ角丸にして D バーと見た目を揃える。
            Bar の fill は実際の描画では Cell が上書きするが、Legend のアイコン色はここから取られる。 */}
        <Bar dataKey="kill"   name={METRIC_LABELS.avg_kill}    fill="#22c55e" stackId="attack" maxBarSize={24} activeBar={false}
          shape={attackStackTopRoundedShape}
          onMouseEnter={(_: any, i: number) => setActiveIndex(i)}
        >
          {chartData.map((_, i) => <Cell key={i} fill="url(#grad-kill)"   fillOpacity={cellOpacity(i)} />)}
        </Bar>
        <Bar dataKey="assist" name={METRIC_LABELS.avg_assist} fill="#9ca3af" stackId="attack" maxBarSize={24} activeBar={false}
          shape={attackStackTopRoundedShape}
          onMouseEnter={(_: any, i: number) => setActiveIndex(i)}
        >
          {chartData.map((_, i) => <Cell key={i} fill="url(#grad-assist)" fillOpacity={cellOpacity(i)} />)}
        </Bar>
        {/* デスバー: 別 stackId なので横に並ぶ */}
        <Bar dataKey="death"  name={METRIC_LABELS.avg_death}    fill="#ef4444" stackId="defense" maxBarSize={24} activeBar={false} radius={[4, 4, 0, 0]}
          onMouseEnter={(_: any, i: number) => setActiveIndex(i)}
        >
          {chartData.map((_, i) => <Cell key={i} fill="url(#grad-death)"  fillOpacity={cellOpacity(i)} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
    <HoverTooltip activeIndex={activeIndex} dataLength={chartData.length} leftPad={leftPad} rightPad={rightPad}>
      {activeIndex != null && (() => {
        const row = chartData[activeIndex]
        const displayLabel = nameTransform ? nameTransform(row.name) : row.name
        return (
          <>
            <div className="hover-tt-title">{displayLabel}</div>
            <div className="hover-tt-row" style={{ color: '#22c55e' }}>{METRIC_LABELS.avg_kill}: {row.kill.toFixed(2)}</div>
            <div className="hover-tt-row" style={{ color: '#9ca3af' }}>{METRIC_LABELS.avg_assist}: {row.assist.toFixed(2)}</div>
            <div className="hover-tt-row" style={{ color: '#ef4444' }}>{METRIC_LABELS.avg_death}: {row.death.toFixed(2)}</div>
            <div className="hover-tt-row hover-tt-row--muted">{METRIC_LABELS.total}: {row.rawRow.total}</div>
          </>
        )
      })()}
    </HoverTooltip>
    </div>
  )
}
