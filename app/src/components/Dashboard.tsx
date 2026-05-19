import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  BarChart, Bar, LineChart, Line, ScatterChart, Scatter,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, ReferenceLine,
} from 'recharts'
import type { Summary, SummaryEntry, ChartSpec, Filters } from '../types'
import { periodToSince } from '../types'

const COLOR_TOTAL = '#374151'

function winRateColor(rate: number): string {
  if (rate >= 0.55) return '#22c55e'
  if (rate >= 0.45) return '#f59e0b'
  return '#ef4444'
}

interface Props {
  filters: Filters
  aiChart: ChartSpec | null
}

export function Dashboard({ filters, aiChart }: Props) {
  const [summary, setSummary] = useState<Summary | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshKey, setRefreshKey] = useState(0)
  const [fetching, setFetching] = useState(false)
  const [fetchingDetails, setFetchingDetails] = useState(false)
  const [fetchResult, setFetchResult] = useState<string | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    invoke<Summary>('db_summary', {
      since: periodToSince(filters.period),
      mode: filters.mode,
      rule: filters.rule,
      resultFilter: filters.result,
      weapon: filters.weapon,
    })
      .then(setSummary)
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [refreshKey, filters])

  async function handleFetch() {
    setFetching(true)
    setFetchResult(null)
    setFetchError(null)
    try {
      const count = await invoke<number>('fetch_battles')
      setFetchResult(`${count}件取得しました`)
      setRefreshKey(k => k + 1)
    } catch (e) {
      setFetchError(String(e))
    } finally {
      setFetching(false)
    }
  }

  async function handleFetchDetails() {
    setFetchingDetails(true)
    setFetchResult(null)
    setFetchError(null)
    try {
      const count = await invoke<number>('fetch_battle_details')
      setFetchResult(`詳細データ ${count}件更新しました`)
      setRefreshKey(k => k + 1)
    } catch (e) {
      setFetchError(String(e))
    } finally {
      setFetchingDetails(false)
    }
  }

  const totalBattles = summary?.by_mode.reduce((s, e) => s + e.total, 0) ?? 0
  const totalWins = summary?.by_mode.reduce((s, e) => s + e.wins, 0) ?? 0
  const overallWinRate = totalBattles > 0 ? totalWins / totalBattles : null

  return (
    <div className="dashboard">
      <div className="dashboard-header">
        <h2>ダッシュボード</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {fetchResult && (
            <span style={{ color: 'var(--win)', fontSize: 13 }}>{fetchResult}</span>
          )}
          <button className="btn-secondary" onClick={handleFetchDetails} disabled={fetchingDetails || fetching}>
            {fetchingDetails ? '取得中...' : '詳細データを取得'}
          </button>
          <button className="btn-primary" onClick={handleFetch} disabled={fetching || fetchingDetails}>
            {fetching ? '取得中...' : 'バトルデータを取得'}
          </button>
        </div>
      </div>

      {fetchError && <div className="error-box">{fetchError}</div>}

      {loading ? (
        <div className="loading">読み込み中...</div>
      ) : !summary ? (
        <div className="empty">データがありません</div>
      ) : (
        <>
          <div className="stat-cards">
            <StatCard label="総試合数" value={totalBattles.toLocaleString()} />
            <StatCard
              label="全体勝率"
              value={overallWinRate !== null ? `${(overallWinRate * 100).toFixed(1)}%` : '—'}
              valueColor={overallWinRate !== null ? winRateColor(overallWinRate) : undefined}
            />
            <StatCard label="勝利数" value={totalWins.toLocaleString()} />
            <StatCard label="使用武器数" value={summary.by_weapon.length.toString()} />
          </div>

          <div className="chart-grid">
            <ChartCard title="武器別 勝率 & 試合数">
              <WinRateChart data={summary.by_weapon.slice(0, 14)} height={260} />
            </ChartCard>

            <ChartCard title="ステージ別 勝率 & 試合数">
              <WinRateChart data={summary.by_stage.slice(0, 14)} height={260} />
            </ChartCard>

            <ChartCard title="モード別 勝率 & 試合数">
              <WinRateChart data={summary.by_mode} height={180} />
            </ChartCard>

            <ChartCard title="ルール別 勝率 & 試合数">
              <WinRateChart data={summary.by_rule} height={220} />
            </ChartCard>

            {aiChart && (
              <ChartCard title={aiChart.title}>
                <AiChartRenderer spec={aiChart} />
              </ChartCard>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function WinRateChart({ data, height }: { data: SummaryEntry[]; height: number }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#2e2e40" vertical={false} />
        <XAxis dataKey="name" tick={{ fontSize: 10 }} interval={0} />
        <YAxis
          yAxisId="left"
          tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
          domain={[0, 1]}
          tick={{ fontSize: 10 }}
          width={36}
        />
        <YAxis
          yAxisId="right"
          orientation="right"
          tick={{ fontSize: 10 }}
          width={32}
        />
        <ReferenceLine yAxisId="left" y={0.5} stroke="#4b5563" strokeDasharray="4 4" />
        <Tooltip
          contentStyle={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12 }}
          formatter={(value, name) =>
            name === 'win_rate'
              ? [`${(Number(value) * 100).toFixed(1)}%`, '勝率']
              : [value, '試合数']
          }
        />
        <Bar yAxisId="left" dataKey="win_rate" name="win_rate" maxBarSize={32}>
          {data.map((entry, i) => (
            <Cell key={i} fill={winRateColor(entry.win_rate)} />
          ))}
        </Bar>
        <Bar yAxisId="right" dataKey="total" fill={COLOR_TOTAL} name="total" maxBarSize={32} />
      </BarChart>
    </ResponsiveContainer>
  )
}

function StatCard({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={valueColor ? { color: valueColor } : undefined}>{value}</div>
    </div>
  )
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="chart-card">
      <h3 className="chart-title">{title}</h3>
      {children}
    </div>
  )
}

function AiChartRenderer({ spec }: { spec: ChartSpec }) {
  const { chartType, data, xKey, yKey } = spec
  return (
    <ResponsiveContainer width="100%" height={240}>
      {chartType === 'bar' ? (
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="#2e2e40" />
          <XAxis dataKey={xKey} />
          <YAxis />
          <Tooltip />
          <Bar dataKey={yKey} fill="#7c3aed" />
        </BarChart>
      ) : chartType === 'line' ? (
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="#2e2e40" />
          <XAxis dataKey={xKey} />
          <YAxis />
          <Tooltip />
          <Line dataKey={yKey} stroke="#7c3aed" dot={false} />
        </LineChart>
      ) : (
        <ScatterChart>
          <CartesianGrid strokeDasharray="3 3" stroke="#2e2e40" />
          <XAxis dataKey={xKey} />
          <YAxis dataKey={yKey} />
          <Tooltip />
          <Scatter data={data} fill="#7c3aed" />
        </ScatterChart>
      )}
    </ResponsiveContainer>
  )
}
