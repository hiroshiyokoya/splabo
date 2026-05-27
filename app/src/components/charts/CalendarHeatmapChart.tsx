import { useMemo, useState } from 'react'
import type { GroupedStatsRow, MetricKey } from '../../types'
import { METRIC_LABELS, getMetric, formatMetric, metricGroup } from '../../types'

/**
 * GitHub contribution graph 風のカレンダーヒートマップ。
 *
 * - 1 マス = 1 日（9 時境界の「Splatoon 日」、BE 側で UTC 日付＝Splatoon 日として返ってくる）
 * - 縦軸: 曜日（月〜日）
 * - 横軸: 週（左が古い）
 * - メトリクスのグループで色スケールを自動切替:
 *   - count   → 相対 5 段階 (緑系)
 *   - rate    → 固定 0–100% divergent (赤 ↔ 白 ↔ 青)
 *   - average → 相対 5 段階 (アクセント色)
 * - 率・平均系はサンプル数 < minSampleSize でグレーアウト
 * - データが無い日は空セル (薄いグレー)
 */

const CELL  = 12
const GAP   = 2
const PITCH = CELL + GAP

const DOW_LABELS = ['月', '火', '水', '木', '金', '土', '日']

/** Date を UTC 基準で yyyy-mm-dd 文字列に。 */
function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** ISO 日付文字列を UTC Date に。 */
function fromIsoDate(s: string): Date {
  return new Date(`${s}T00:00:00Z`)
}

/** UTC ベースの曜日インデックス。0=月 … 6=日 になるよう変換。 */
function weekdayMonStart(d: Date): number {
  const w = d.getUTCDay() // 0=Sun … 6=Sat
  return (w + 6) % 7
}

/** 同じ ISO 週の Monday の UTC 日付を返す。 */
function mondayOf(d: Date): Date {
  const wd = weekdayMonStart(d)
  const m = new Date(d)
  m.setUTCDate(d.getUTCDate() - wd)
  return m
}

/** カウント系: 0=空、1〜5=濃さ。max を 5 段階に正規化。 */
function countColor(value: number, max: number): string {
  if (max <= 0) return 'var(--cell-empty)'
  const t = value / max
  if (value === 0)  return 'var(--cell-empty)'
  if (t <= 0.2)    return 'var(--cell-c1)'
  if (t <= 0.4)    return 'var(--cell-c2)'
  if (t <= 0.6)    return 'var(--cell-c3)'
  if (t <= 0.8)    return 'var(--cell-c4)'
  return 'var(--cell-c5)'
}

/** 率系: 0=赤 (-), 0.5=灰, 1=青 (+)。divergent。 */
function rateColor(value: number): string {
  // 0..1 を -1..+1 に
  const t = (value - 0.5) * 2
  if (t < -0.4) return 'var(--cell-r1)' // 強い赤
  if (t < -0.1) return 'var(--cell-r2)' // 弱い赤
  if (t <=  0.1) return 'var(--cell-r3)' // ニュートラル
  if (t <=  0.4) return 'var(--cell-r4)' // 弱い青
  return 'var(--cell-r5)' // 強い青
}

/** 平均系: min–max を 5 段階に正規化。 */
function averageColor(value: number, min: number, max: number): string {
  if (max <= min) return 'var(--cell-c3)'
  const t = (value - min) / (max - min)
  if (t <= 0.2) return 'var(--cell-c1)'
  if (t <= 0.4) return 'var(--cell-c2)'
  if (t <= 0.6) return 'var(--cell-c3)'
  if (t <= 0.8) return 'var(--cell-c4)'
  return 'var(--cell-c5)'
}

export function CalendarHeatmapChart({
  data, metric, minSampleSize = 5,
}: {
  data:           GroupedStatsRow[]
  metric:         MetricKey
  minSampleSize?: number
}) {
  const [hover, setHover] = useState<{ x: number; y: number; date: string; value: number | null; total: number } | null>(null)

  const group = metricGroup(metric)

  // データ map と min/max 算出
  const { dataMap, minVal, maxVal, weeks } = useMemo(() => {
    const map = new Map<string, { value: number | null; total: number }>()
    let mn = Number.POSITIVE_INFINITY
    let mx = Number.NEGATIVE_INFINITY
    let earliest: Date | null = null
    let latest:   Date | null = null

    for (const row of data) {
      const date = fromIsoDate(row.name)
      if (isNaN(date.getTime())) continue
      const v = getMetric(row, metric)
      map.set(row.name, { value: v, total: row.total })
      if (v !== null && (group === 'count' || row.total >= minSampleSize)) {
        if (v < mn) mn = v
        if (v > mx) mx = v
      }
      if (!earliest || date < earliest) earliest = date
      if (!latest   || date > latest)   latest   = date
    }

    // データが空の場合は直近 1 年を空表示
    if (!earliest || !latest) {
      const today = new Date()
      latest   = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()))
      earliest = new Date(latest)
      earliest.setUTCDate(latest.getUTCDate() - 364)
    }

    // 週の開始 (Monday) ～ latest までで矩形を作る
    const startMonday = mondayOf(earliest)
    const numWeeks = Math.floor((latest.getTime() - startMonday.getTime()) / (1000 * 60 * 60 * 24 * 7)) + 1

    const weeks: Date[] = []
    for (let i = 0; i < numWeeks; i++) {
      const d = new Date(startMonday)
      d.setUTCDate(startMonday.getUTCDate() + i * 7)
      weeks.push(d)
    }

    return {
      dataMap: map,
      minVal:  mn === Number.POSITIVE_INFINITY ? 0 : mn,
      maxVal:  mx === Number.NEGATIVE_INFINITY ? 0 : mx,
      weeks,
    }
  }, [data, metric, group, minSampleSize])

  function cellFill(_date: string, value: number | null, total: number): string {
    if (value === null) return 'var(--cell-empty)'
    // 率・平均系はサンプル不足ならグレーアウト
    if ((group === 'rate' || group === 'average') && total < minSampleSize) {
      return 'var(--cell-sparse)'
    }
    if (group === 'count')   return countColor(value, maxVal)
    if (group === 'rate')    return rateColor(value)
    return averageColor(value, minVal, maxVal)
  }

  const width  = weeks.length * PITCH + 22
  const height = 7 * PITCH + 16

  return (
    <div className="chart-hover-area" style={{ position: 'relative', overflow: 'auto' }}>
      <svg width={width} height={height} role="img" aria-label="カレンダーヒートマップ">
        <style>{`
          /* 5 段階の色階調はテーマカラーから生成 */
          .cal-cell { stroke: var(--surface); stroke-width: 0.5; }
        `}</style>
        {/* 曜日ラベル */}
        {DOW_LABELS.map((lbl, i) => (
          <text
            key={lbl}
            x={4}
            y={16 + i * PITCH + CELL * 0.75}
            fontSize={9}
            fill="var(--text-muted)"
          >{lbl}</text>
        ))}
        {/* セル */}
        {weeks.map((weekStart, wi) =>
          Array.from({ length: 7 }, (_, di) => {
            const cellDate = new Date(weekStart)
            cellDate.setUTCDate(weekStart.getUTCDate() + di)
            const dateStr = toIsoDate(cellDate)
            const entry = dataMap.get(dateStr)
            const v = entry?.value ?? null
            const total = entry?.total ?? 0
            const fill = cellFill(dateStr, v, total)
            const x = 22 + wi * PITCH
            const y = 16 + di * PITCH
            return (
              <rect
                key={`${wi}-${di}`}
                className="cal-cell"
                x={x}
                y={y}
                width={CELL}
                height={CELL}
                rx={2}
                fill={fill}
                onMouseEnter={() => setHover({ x, y, date: dateStr, value: v, total })}
                onMouseLeave={() => setHover(null)}
              />
            )
          })
        )}
      </svg>
      {hover && (
        <div
          className="cal-tooltip"
          style={{
            position: 'absolute',
            left:     Math.min(hover.x + 18, (weeks.length * PITCH + 22) - 160),
            top:      hover.y + 18,
            pointerEvents: 'none',
          }}
        >
          <div className="hover-tt-title">{hover.date}</div>
          <div className="hover-tt-row">{METRIC_LABELS[metric]}: {formatMetric(hover.value, metric)}</div>
          <div className="hover-tt-row hover-tt-row--muted">バトル数: {hover.total}</div>
          {(group === 'rate' || group === 'average') && hover.value !== null && hover.total < minSampleSize && (
            <div className="hover-tt-row hover-tt-row--muted">サンプル不足 (&lt; {minSampleSize})</div>
          )}
        </div>
      )}
    </div>
  )
}
