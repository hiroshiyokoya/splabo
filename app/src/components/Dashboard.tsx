import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  BarChart, Bar, LineChart, Line, ScatterChart, Scatter,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell,
} from 'recharts'
import type { Summary, ChartSpec } from '../types'

const WIN_COLOR = '#7c3aed'

interface Props {
  aiChart: ChartSpec | null
}

export function Dashboard({ aiChart }: Props) {
  const [summary, setSummary] = useState<Summary | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshKey, setRefreshKey] = useState(0)
  const [fetching, setFetching] = useState(false)
  const [fetchResult, setFetchResult] = useState<string | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    invoke<Summary>('db_summary', { since: null })
      .then(setSummary)
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [refreshKey])

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

  return (
    <div className="dashboard">
      <div className="dashboard-header">
        <h2>ダッシュボード</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {fetchResult && (
            <span style={{ color: 'var(--win)', fontSize: 13 }}>{fetchResult}</span>
          )}
          <button className="btn-primary" onClick={handleFetch} disabled={fetching}>
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
        <div className="chart-grid">
          <ChartCard title="武器別 勝率 & 試合数">
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={summary.by_weapon.slice(0, 12)}>
                <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                <YAxis yAxisId="left" tickFormatter={(v) => `${(v * 100).toFixed(0)}%`} domain={[0, 1]} />
                <YAxis yAxisId="right" orientation="right" />
                <Tooltip
                  formatter={(value, name) =>
                    name === 'win_rate'
                      ? [`${(Number(value) * 100).toFixed(1)}%`, '勝率']
                      : [value, '試合数']
                  }
                />
                <Bar yAxisId="left" dataKey="win_rate" fill={WIN_COLOR} name="win_rate" />
                <Bar yAxisId="right" dataKey="total" fill="#4b5563" name="total" />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard title="モード別 勝率">
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={summary.by_mode} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                <XAxis type="number" tickFormatter={(v) => `${(v * 100).toFixed(0)}%`} domain={[0, 1]} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={80} />
                <Tooltip formatter={(v) => [`${(Number(v) * 100).toFixed(1)}%`, '勝率']} />
                <Bar dataKey="win_rate" fill={WIN_COLOR}>
                  {summary.by_mode.map((_, i) => <Cell key={i} fill={WIN_COLOR} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard title="ステージ別 勝率 & 試合数">
            <ResponsiveContainer width="100%" height={240}>
              <ScatterChart>
                <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                <XAxis dataKey="total" name="試合数" />
                <YAxis dataKey="win_rate" name="勝率" tickFormatter={(v) => `${(v * 100).toFixed(0)}%`} domain={[0, 1]} />
                <Tooltip
                  cursor={{ strokeDasharray: '3 3' }}
                  content={({ payload }) => {
                    if (!payload?.length) return null
                    const d = payload[0].payload
                    return (
                      <div className="tooltip-box">
                        <div>{d.name}</div>
                        <div>試合数: {d.total}</div>
                        <div>勝率: {(d.win_rate * 100).toFixed(1)}%</div>
                      </div>
                    )
                  }}
                />
                <Scatter data={summary.by_stage} fill={WIN_COLOR} />
              </ScatterChart>
            </ResponsiveContainer>
          </ChartCard>

          {aiChart && (
            <ChartCard title={aiChart.title}>
              <AiChartRenderer spec={aiChart} />
            </ChartCard>
          )}
        </div>
      )}
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
          <CartesianGrid strokeDasharray="3 3" stroke="#333" />
          <XAxis dataKey={xKey} />
          <YAxis />
          <Tooltip />
          <Bar dataKey={yKey} fill={WIN_COLOR} />
        </BarChart>
      ) : chartType === 'line' ? (
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="#333" />
          <XAxis dataKey={xKey} />
          <YAxis />
          <Tooltip />
          <Line dataKey={yKey} stroke={WIN_COLOR} dot={false} />
        </LineChart>
      ) : (
        <ScatterChart>
          <CartesianGrid strokeDasharray="3 3" stroke="#333" />
          <XAxis dataKey={xKey} />
          <YAxis dataKey={yKey} />
          <Tooltip />
          <Scatter data={data} fill={WIN_COLOR} />
        </ScatterChart>
      )}
    </ResponsiveContainer>
  )
}
