import { useState } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, Legend,
} from 'recharts'
import type { GroupedStatsRow } from '../../types'

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
  data, height = 280, nameTransform,
}: {
  data:           GroupedStatsRow[]
  height?:        number
  nameTransform?: (name: string) => string
}) {
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

  return (
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
          height={28}
          tick={{ fill: 'var(--text)', fontSize: 10 } as object}
          tickFormatter={nameTransform}
        />
        <YAxis
          tick={{ fill: 'var(--text)', fontSize: 10 } as object}
          width={36}
        />
        <Tooltip
          cursor={false}
          content={({ active, payload, label }: any) => {
            if (!active || !payload?.length) return null
            const row = payload[0]?.payload as { kill: number; assist: number; death: number; rawRow: GroupedStatsRow }
            const displayLabel = nameTransform ? nameTransform(label) : label
            return (
              <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12, padding: '6px 10px' }}>
                <div style={{ color: 'var(--text)', fontWeight: 700, marginBottom: 4 }}>{displayLabel}</div>
                <div style={{ color: '#22c55e' }}>平均キル: {row.kill.toFixed(2)}</div>
                <div style={{ color: '#9ca3af' }}>平均アシスト: {row.assist.toFixed(2)}</div>
                <div style={{ color: '#ef4444' }}>平均デス: {row.death.toFixed(2)}</div>
                <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 2 }}>バトル数: {row.rawRow.total}</div>
              </div>
            )
          }}
        />
        <Legend wrapperStyle={{ fontSize: 11 }} iconType="square" />
        {/* 攻撃バー: K の上に A を積み上げ。name は Legend に出る系列名。 */}
        <Bar dataKey="kill"   name="平均キル"    stackId="attack" maxBarSize={24} activeBar={false}
          onMouseEnter={(_: any, i: number) => setActiveIndex(i)}
        >
          {chartData.map((_, i) => <Cell key={i} fill="url(#grad-kill)"   fillOpacity={cellOpacity(i)} />)}
        </Bar>
        <Bar dataKey="assist" name="平均アシスト" stackId="attack" maxBarSize={24} activeBar={false}
          onMouseEnter={(_: any, i: number) => setActiveIndex(i)}
        >
          {chartData.map((_, i) => <Cell key={i} fill="url(#grad-assist)" fillOpacity={cellOpacity(i)} />)}
        </Bar>
        {/* デスバー: 別 stackId なので横に並ぶ */}
        <Bar dataKey="death"  name="平均デス"    stackId="defense" maxBarSize={24} activeBar={false} radius={[4, 4, 0, 0]}
          onMouseEnter={(_: any, i: number) => setActiveIndex(i)}
        >
          {chartData.map((_, i) => <Cell key={i} fill="url(#grad-death)"  fillOpacity={cellOpacity(i)} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}
