/**
 * 環境分析タブ（#184）。
 *
 * stat.ink の公開バトルデータ（全世界のプレイヤー投稿）を取り込み、
 * 武器ピック率 vs 勝率の散布図を表示する。
 *
 * 注意: stat.ink ユーザーは一般プレイヤーより熱心な層に偏るため、
 *       データには投稿バイアスがあります。
 */
import { useState, useEffect, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { EnvWeaponStat, EnvStatus } from '../types'
import { RULE_LABELS } from '../types'
import { ScatterChart } from './charts/ScatterChart'
import type { ScatterPoint } from './charts/ScatterChart'

const LOBBY_OPTIONS = [
  { key: '',                  label: 'すべてのロビー' },
  { key: 'regular',           label: 'レギュラー' },
  { key: 'bankara_open',      label: 'バンカラ(オープン)' },
  { key: 'bankara_challenge', label: 'バンカラ(チャレンジ)' },
  { key: 'xmatch',            label: 'Xマッチ' },
  { key: 'splatfest_open',    label: 'フェス(オープン)' },
  { key: 'splatfest_challenge', label: 'フェス(チャレンジ)' },
  { key: 'event',             label: 'イベント' },
]

const RULE_OPTIONS = [
  { key: '',         label: 'すべてのルール' },
  { key: 'nawabari', label: RULE_LABELS['turf_war'] ?? 'ナワバリバトル' },
  { key: 'area',     label: RULE_LABELS['area']     ?? 'ガチエリア' },
  { key: 'yagura',   label: RULE_LABELS['yagura']   ?? 'ガチヤグラ' },
  { key: 'hoko',     label: RULE_LABELS['hoko']     ?? 'ガチホコバトル' },
  { key: 'asari',    label: RULE_LABELS['asari']    ?? 'ガチアサリ' },
]

interface ImportProgress {
  current: number
  total:   number
  phase:   string
}

export function EnvAnalysis() {
  const [status, setStatus]       = useState<EnvStatus | null>(null)
  const [stats, setStats]         = useState<EnvWeaponStat[]>([])
  const [importing, setImporting] = useState(false)
  const [progress, setProgress]   = useState<ImportProgress | null>(null)
  const [error, setError]         = useState<string | null>(null)
  const [lobbyKey, setLobbyKey]   = useState('')
  const [ruleKey, setRuleKey]     = useState('')

  // 取得状況を読み込む
  const loadStatus = useCallback(async () => {
    try {
      const s = await invoke<EnvStatus>('env_status')
      setStatus(s)
    } catch (e) {
      console.error('[EnvAnalysis] env_status 失敗:', e)
    }
  }, [])

  // 集計データを読み込む
  const loadStats = useCallback(async () => {
    try {
      const rows = await invoke<EnvWeaponStat[]>('env_grouped_stats', {
        lobbyKey: lobbyKey || null,
        ruleKey:  ruleKey  || null,
        since:    null,
        until:    null,
      })
      setStats(rows)
    } catch (e) {
      console.error('[EnvAnalysis] env_grouped_stats 失敗:', e)
    }
  }, [lobbyKey, ruleKey])

  useEffect(() => { loadStatus() }, [loadStatus])
  useEffect(() => {
    if (status && status.total_rows > 0) {
      loadStats()
    }
  }, [status, loadStats])

  // 進捗イベントを購読
  useEffect(() => {
    const unlisten = listen<ImportProgress>('env_import_progress', (e) => {
      setProgress(e.payload)
    })
    return () => { unlisten.then(fn => fn()) }
  }, [])

  // 全期間取得ボタン
  async function handleDownloadFull() {
    if (importing) return
    setImporting(true)
    setError(null)
    setProgress({ current: 0, total: 1, phase: 'download' })
    try {
      const inserted = await invoke<number>('import_env_full')
      console.log(`[EnvAnalysis] 全期間取得完了: ${inserted} 行`)
      await loadStatus()
    } catch (e) {
      setError(String(e))
    } finally {
      setImporting(false)
      setProgress(null)
    }
  }

  // 差分更新ボタン
  async function handleDelta() {
    if (importing) return
    setImporting(true)
    setError(null)
    setProgress({ current: 0, total: 1, phase: 'download' })
    try {
      const inserted = await invoke<number>('import_env_delta')
      console.log(`[EnvAnalysis] 差分更新完了: ${inserted} 行`)
      await loadStatus()
    } catch (e) {
      setError(String(e))
    } finally {
      setImporting(false)
      setProgress(null)
    }
  }

  // 散布図用のポイントに変換する
  const points: ScatterPoint[] = stats.map(row => {
    const pickRate = row.total_battles > 0
      ? row.picks / (row.total_battles * 8)
      : 0
    return {
      name:  row.weapon_name,
      x:     pickRate,
      y:     row.win_rate,
      size:  null,
      color: 'var(--accent)',
      tooltipRows: [
        { label: '武器',     value: row.weapon_name },
        { label: 'ピック率', value: `${(pickRate * 100).toFixed(2)}%` },
        { label: '勝率',     value: `${(row.win_rate * 100).toFixed(1)}%` },
        { label: 'ピック数', value: row.picks.toLocaleString() },
      ],
    }
  })

  const hasData = status !== null && status.total_rows > 0

  return (
    <div className="env-analysis">
      <div className="env-analysis-header">
        <h2>環境分析</h2>
        <p className="env-bias-notice">
          データ出典: <a href="https://stat.ink" target="_blank" rel="noopener noreferrer">stat.ink</a>（ユーザー投稿）。
          stat.ink ユーザーは熱心なプレイヤーに偏るため、一般環境と差異がある場合があります。
        </p>
      </div>

      {!hasData ? (
        // データ未取得状態
        <div className="env-placeholder">
          <div className="env-placeholder-icon">🌍</div>
          <h3>環境データが未取得です</h3>
          <p>stat.ink の公開データから全世界のバトル統計を取得します</p>
          <p className="env-placeholder-sub">
            推定ダウンロード量: 約 944 MiB / 推定時間: 10〜15 分
          </p>
          <button
            className="btn-primary"
            onClick={handleDownloadFull}
            disabled={importing}
          >
            {importing ? 'ダウンロード中...' : 'データを取得する'}
          </button>
          {error && <p className="env-error">{error}</p>}
          {progress && <ProgressDisplay progress={progress} />}
        </div>
      ) : (
        // データ取得済み状態
        <>
          <div className="env-data-header">
            <span className="env-data-range">
              データ: {status.min_date} 〜 {status.max_date} /&nbsp;
              {(status.total_rows / 10000).toFixed(1)} 万行
            </span>
            <button
              className="btn-secondary"
              onClick={handleDelta}
              disabled={importing}
              title="最終取得日の翌日から昨日分を差分取得します"
            >
              {importing ? '更新中...' : '差分更新'}
            </button>
            {error && <span className="env-error">{error}</span>}
          </div>

          {progress && <ProgressDisplay progress={progress} />}

          {/* フィルタ */}
          <div className="env-filters">
            <label>
              ロビー
              <select value={lobbyKey} onChange={e => setLobbyKey(e.target.value)}>
                {LOBBY_OPTIONS.map(o => (
                  <option key={o.key} value={o.key}>{o.label}</option>
                ))}
              </select>
            </label>
            <label>
              ルール
              <select value={ruleKey} onChange={e => setRuleKey(e.target.value)}>
                {RULE_OPTIONS.map(o => (
                  <option key={o.key} value={o.key}>{o.label}</option>
                ))}
              </select>
            </label>
          </div>

          {/* 散布図 */}
          <div className="env-chart-section">
            <h3 className="env-chart-title">武器ピック率 vs 勝率</h3>
            {stats.length === 0 ? (
              <p className="env-no-data">条件に一致するデータがありません（50 ピック未満の武器は非表示）</p>
            ) : (
              <ScatterChart
                points={points}
                xLabel="ピック率"
                yLabel="勝率"
                xIsRate
                yIsRate
                height={420}
              />
            )}
            <p className="env-chart-note">
              50 ピック未満の武器は非表示。各点にマウスオーバーで武器名・詳細を表示。
            </p>
          </div>
        </>
      )}
    </div>
  )
}

/** 進捗バー表示。 */
function ProgressDisplay({ progress }: { progress: ImportProgress }) {
  const pct = progress.total > 0
    ? Math.round((progress.current / progress.total) * 100)
    : 0
  const phaseLabel =
    progress.phase === 'download' ? 'ダウンロード中' :
    progress.phase === 'extract'  ? '解凍中' :
    'インポート中'
  return (
    <div className="env-progress">
      <div className="env-progress-label">
        {phaseLabel}... {pct}% ({progress.current.toLocaleString()} / {progress.total.toLocaleString()})
      </div>
      <div className="env-progress-bar">
        <div className="env-progress-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}
