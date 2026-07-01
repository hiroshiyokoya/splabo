import { useEffect, useMemo, useRef, useState } from 'react'
import type { GroupedStatsRow, MetricKey } from '../../types'
import { METRIC_LABELS, getMetric, metricGroup } from '../../types'

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

const CELL  = 16
const GAP   = 3
const PITCH = CELL + GAP

const DOW_LABELS = ['月', '火', '水', '木', '金', '土', '日']

/** カラーバー (凡例) を描画するための、メトリクスグループごとの色順序。
 *  count / average は 5 段階 (薄い→濃い)、rate は 5 段階 (赤→青) divergent。 */
const COUNT_COLORS  = ['var(--cell-count-c1)', 'var(--cell-count-c2)', 'var(--cell-count-c3)', 'var(--cell-count-c4)', 'var(--cell-count-c5)']
const AVG_COLORS    = ['var(--cell-c1)', 'var(--cell-c2)', 'var(--cell-c3)', 'var(--cell-c4)', 'var(--cell-c5)']
const RATE_COLORS   = ['var(--cell-r1)', 'var(--cell-r2)', 'var(--cell-r3)', 'var(--cell-r4)', 'var(--cell-r5)']

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** メトリクス値を凡例ラベル用に短く整形。 */
function fmtLegend(v: number, metric: MetricKey): string {
  if (metric === 'win_rate') return `${Math.round(v * 100)}%`
  if (metric === 'avg_duration') return `${Math.round(v)}s`
  if (metric === 'total' || metric === 'wins' ||
      metric === 'sum_kill' || metric === 'sum_death' ||
      metric === 'sum_assist' || metric === 'sum_inked') return Math.round(v).toString()
  return v.toFixed(1)
}

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
  if (max <= 0) return 'var(--cell-count-empty)'
  const t = value / max
  if (value === 0)  return 'var(--cell-count-empty)'
  if (t <= 0.2)    return 'var(--cell-count-c1)'
  if (t <= 0.4)    return 'var(--cell-count-c2)'
  if (t <= 0.6)    return 'var(--cell-count-c3)'
  if (t <= 0.8)    return 'var(--cell-count-c4)'
  return 'var(--cell-count-c5)'
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
  // ツールチップ位置はマウスの clientX / clientY (viewport 基準) を使う。
  // チャート枠 (overflow:auto) の外にも飛び出せるように position: fixed で描く。
  const [hover, setHover] = useState<{ mx: number; my: number; date: string; value: number | null; total: number; wins: number; draws: number } | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const group = metricGroup(metric)

  // データ map と min/max 算出
  const { dataMap, minVal, maxVal, weeks } = useMemo(() => {
    const map = new Map<string, { value: number | null; total: number; wins: number; draws: number }>()
    let mn = Number.POSITIVE_INFINITY
    let mx = Number.NEGATIVE_INFINITY
    let earliest: Date | null = null
    let latest:   Date | null = null

    for (const row of data) {
      const date = fromIsoDate(row.name)
      if (isNaN(date.getTime())) continue
      const v = getMetric(row, metric)
      map.set(row.name, { value: v, total: row.total, wins: row.wins, draws: row.draws })
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

    const rawMax = mx === Number.NEGATIVE_INFINITY ? 0 : mx
    // カウント系は色スケール上限を 10 単位で切り上げると凡例が読みやすい (52 → 60 等)
    const finalMax = group === 'count' && rawMax > 0 ? Math.ceil(rawMax / 10) * 10 : rawMax
    return {
      dataMap: map,
      minVal:  mn === Number.POSITIVE_INFINITY ? 0 : mn,
      maxVal:  finalMax,
      weeks,
    }
  }, [data, metric, group, minSampleSize])

  function cellFill(_date: string, value: number | null, total: number): string {
    if (value === null) return group === 'count' ? 'var(--cell-count-empty)' : 'var(--cell-empty)'
    // 率・平均系はサンプル不足ならグレーアウト
    if ((group === 'rate' || group === 'average') && total < minSampleSize) {
      return 'var(--cell-sparse)'
    }
    if (group === 'count')   return countColor(value, maxVal)
    if (group === 'rate')    return rateColor(value)
    return averageColor(value, minVal, maxVal)
  }

  const GRID_TOP = 32
  const GRID_HEIGHT = 7 * PITCH

  // 月ラベル: 月が変わる週の直前 (＝その月最初に出現する週) にラベルを描く
  const monthLabels = useMemo(() => {
    const labels: { x: number; text: string }[] = []
    let prevMonth = -1
    weeks.forEach((weekStart, wi) => {
      const m = weekStart.getUTCMonth()
      if (m !== prevMonth) {
        labels.push({ x: 22 + wi * PITCH, text: MONTH_LABELS[m] })
        prevMonth = m
      }
    })
    return labels
  }, [weeks])

  const width  = Math.max(weeks.length * PITCH + 26, 280)
  const height = GRID_TOP + GRID_HEIGHT + 8

  // カレンダーは左が古い・右が最新。初期表示・データ更新時に最新（右端）が見えるよう右端へスクロール。
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollLeft = el.scrollWidth
  }, [width])

  // 「今日」より後 (未来) のセルは描画しない。UTC ベース。
  const now = new Date()
  const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))

  /** 凡例ラベル: 左端値・中央値・右端値 */
  const legendColors = group === 'rate' ? RATE_COLORS : group === 'count' ? COUNT_COLORS : AVG_COLORS
  const legendLeft   = group === 'rate' ? '0%'  : group === 'count' ? '0' : fmtLegend(minVal, metric)
  const legendMid    = group === 'rate' ? '50%' : null
  const legendRight  = group === 'rate' ? '100%' : fmtLegend(maxVal, metric)

  return (
    <div ref={scrollRef} className="chart-hover-area" style={{ position: 'relative', overflow: 'auto' }}>
      <svg width={width} height={height} role="img" aria-label="カレンダーヒートマップ">
        {/* .cal-cell スタイルは App.css に定義（凡例バーの SVG rect と共有） */}
        {/* 月ラベル (横軸上部) */}
        {monthLabels.map((ml, i) => (
          <text
            key={`m-${i}`}
            x={ml.x}
            y={GRID_TOP - 6}
            fontSize={9}
            fontWeight={600}
            fill="var(--text)"
          >{ml.text}</text>
        ))}
        {/* 曜日ラベル */}
        {DOW_LABELS.map((lbl, i) => (
          <text
            key={lbl}
            x={4}
            y={GRID_TOP + i * PITCH + CELL * 0.75}
            fontSize={9}
            fontWeight={600}
            fill="var(--text)"
          >{lbl}</text>
        ))}
        {/* セル */}
        {weeks.map((weekStart, wi) =>
          Array.from({ length: 7 }, (_, di) => {
            const cellDate = new Date(weekStart)
            cellDate.setUTCDate(weekStart.getUTCDate() + di)
            // 今日より後 (未来) のセルは描画しない
            if (cellDate > todayUtc) return null
            const dateStr = toIsoDate(cellDate)
            const entry = dataMap.get(dateStr)
            const v = entry?.value ?? null
            const total = entry?.total ?? 0
            const wins  = entry?.wins ?? 0
            const draws = entry?.draws ?? 0
            const fill = cellFill(dateStr, v, total)
            const x = 22 + wi * PITCH
            const y = GRID_TOP + di * PITCH
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
                onMouseEnter={(e) => setHover({ mx: e.clientX, my: e.clientY, date: dateStr, value: v, total, wins, draws })}
                onMouseMove={(e) => setHover(prev => prev ? { ...prev, mx: e.clientX, my: e.clientY } : prev)}
                onMouseLeave={() => setHover(null)}
              />
            )
          })
        )}
      </svg>
      {/* カラーバー (凡例) を SVG の下に HTML として配置 */}
      <div className="cal-legend">
        <span className="cal-legend-label">{METRIC_LABELS[metric]}</span>
        <span className="cal-legend-end">{legendLeft}</span>
        {(() => {
          const fills = group === 'count'
            ? ['var(--cell-count-empty)', ...legendColors]
            : legendColors
          const barWidth = fills.length * PITCH - GAP
          return (
            <svg className="cal-legend-bar" width={barWidth} height={CELL}>
              {fills.map((c, i) => (
                <rect
                  key={i}
                  className="cal-cell"
                  x={i * PITCH}
                  y={0}
                  width={CELL}
                  height={CELL}
                  rx={2}
                  fill={c}
                />
              ))}
            </svg>
          )
        })()}
        {legendMid && <span className="cal-legend-mid">{legendMid}</span>}
        <span className="cal-legend-end">{legendRight}</span>
        {(group === 'rate' || group === 'average') && (
          <span className="cal-legend-sparse">
            <span className="cal-legend-swatch cal-legend-swatch--sparse" />
            <span className="cal-legend-sparse-text">サンプル不足</span>
          </span>
        )}
      </div>
      {hover && (
        <div
          className="cal-tooltip"
          style={{
            position: 'fixed',
            left:     Math.min(hover.mx + 14, window.innerWidth  - 200),
            top:      Math.min(hover.my + 14, window.innerHeight - 100),
            pointerEvents: 'none',
            zIndex: 1000,
          }}
        >
          <div className="hover-tt-title">{hover.date}</div>
          {(() => {
            const losses  = hover.total - hover.wins - hover.draws
            const decisive = hover.total - hover.draws
            const winRate = decisive > 0 ? (hover.wins / decisive) * 100 : null
            return (
              <>
                <div className="hover-tt-row">バトル数: {hover.total}</div>
                <div className="hover-tt-row">勝数: {hover.wins}</div>
                <div className="hover-tt-row">負数: {losses}</div>
                <div className="hover-tt-row">勝率: {winRate !== null ? `${winRate.toFixed(1)}%` : '—'}</div>
              </>
            )
          })()}
        </div>
      )}
    </div>
  )
}
