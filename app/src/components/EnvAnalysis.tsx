/**
 * 環境分析タブ（#184 / 拡張 #187）。
 *
 * stat.ink の公開バトルデータ（全世界のプレイヤー投稿）を取り込み、
 * 散布図（武器/ステージ別）とマトリクスヒートマップ（カテゴリ×カテゴリ）で
 * 「ステージや武器によってバトル統計がどう変わるか」を見る。
 *
 * 注意: stat.ink ユーザーは一般プレイヤーより熱心な層に偏るため、
 *       データには投稿バイアスがあります。
 */
import { useState, useEffect, useCallback, useMemo } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { EnvScatterStat, EnvMatrixCell, EnvStatus, EnvVersion, EnvRank } from '../types'
import { currentSeasonStart } from '../types'
import { ScatterChart } from './charts/ScatterChart'
import type { ScatterPoint } from './charts/ScatterChart'
import { Heatmap } from './charts/Heatmap'
import { MultiSelect } from './MultiSelect'

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
  { key: 'nawabari', label: 'ナワバリ' },
  { key: 'area',     label: 'ガチエリア' },
  { key: 'yagura',   label: 'ガチヤグラ' },
  { key: 'hoko',     label: 'ガチホコ' },
  { key: 'asari',    label: 'ガチアサリ' },
]

const LOBBY_LABEL: Record<string, string> = Object.fromEntries(LOBBY_OPTIONS.filter(o => o.key).map(o => [o.key, o.label]))
const RULE_LABEL:  Record<string, string> = Object.fromEntries(RULE_OPTIONS.filter(o => o.key).map(o => [o.key, o.label]))

// ---------------------------------------------------------------------------
// 指標メタデータ
// ---------------------------------------------------------------------------

const pct    = (v: number) => `${(v * 100).toFixed(1)}%`
const pct100 = (v: number) => `${v.toFixed(1)}%`
const num2   = (v: number) => v.toFixed(2)
const num1   = (v: number) => v.toFixed(1)
const pint   = (v: number) => Math.round(v).toLocaleString()

interface ScatterMetric {
  key:    string               // select/state 用の一意キー
  label:  string
  rate01: boolean              // 値が [0,1] のレート（% 表示）か
  fmt:    (v: number) => string
  get:    (s: EnvScatterStat) => number | null
  kda?:   boolean              // KDA 系（A1/B1 母数の注記対象）
}

/** EnvScatterStat の数値フィールドをそのまま取り出すアクセサ。 */
const field = (k: keyof EnvScatterStat) => (s: EnvScatterStat) => s[k] as number | null

const WEAPON_METRICS: ScatterMetric[] = [
  { key: 'pick_rate',  label: 'ピック率',   rate01: true,  fmt: pct,  get: field('pick_rate') },
  { key: 'win_rate',   label: '勝率',       rate01: true,  fmt: pct,  get: field('win_rate') },
  { key: 'avg_kill',   label: '平均キル',   rate01: false, fmt: num2, get: field('avg_kill'),   kda: true },
  { key: 'avg_death',  label: '平均デス',   rate01: false, fmt: num2, get: field('avg_death'),  kda: true },
  { key: 'avg_assist', label: '平均アシスト', rate01: false, fmt: num2, get: field('avg_assist'), kda: true },
  { key: 'kill_ratio', label: 'キルレ',     rate01: false, fmt: num2, kda: true,
    get: (s) => (s.avg_kill != null && s.avg_death != null && s.avg_death > 0) ? s.avg_kill / s.avg_death : null },
  { key: 'avg_inked',  label: '平均塗りP',  rate01: false, fmt: pint, get: field('avg_inked'),  kda: true },
]

const STAGE_METRICS: ScatterMetric[] = [
  { key: 'ko_rate',      label: 'KO率',        rate01: true,  fmt: pct,    get: field('ko_rate') },
  { key: 'avg_count',    label: '平均カウント', rate01: false, fmt: num1,   get: field('avg_count') },
  { key: 'avg_ink_self', label: '自分側 塗り%', rate01: false, fmt: pct100, get: field('avg_ink_self') },
  { key: 'avg_ink_opp',  label: '相手側 塗り%', rate01: false, fmt: pct100, get: field('avg_ink_opp') },
]

// ヒートマップのセル指標
type CellMetricKey = 'win_rate' | 'pick_rate' | 'ko_rate' | 'battles'
interface CellMetric {
  key:    CellMetricKey
  label:  string
  fmt:    (v: number) => string
  scale:  'sequential' | 'diverging'
  weapon: boolean   // weapon 次元が必要か
}
const CELL_METRICS: CellMetric[] = [
  { key: 'win_rate',  label: '勝率',     fmt: pct,  scale: 'diverging',  weapon: true },
  { key: 'pick_rate', label: 'ピック率', fmt: pct,  scale: 'sequential', weapon: true },
  { key: 'ko_rate',   label: 'KO率',     fmt: pct,  scale: 'sequential', weapon: false },
  { key: 'battles',   label: 'バトル数', fmt: pint, scale: 'sequential', weapon: false },
]

const DIM_OPTIONS = [
  { key: 'weapon', label: '武器' },
  { key: 'stage',  label: 'ステージ' },
  { key: 'rule',   label: 'ルール' },
  { key: 'lobby',  label: 'ロビー' },
]

// ステージ正式名 → 短縮名（コミュニティ通称）。未知のキーはそのまま返す。
const STAGE_SHORT: Record<string, string> = {
  'ユノハナ大渓谷': 'ユノハナ', 'ゴンズイ地区': 'ゴンズイ', 'ヤガラ市場': 'ヤガラ',
  'マテガイ放水路': 'マテガイ', 'ナメロウ金属': 'ナメロウ', 'マサバ海峡大橋': 'マサバ',
  'キンメダイ美術館': 'キンメ', 'マヒマヒリゾート＆スパ': 'マヒマヒ', '海女美術大学': '海女',
  'チョウザメ造船': 'チョウザメ', 'ザトウマーケット': 'ザトウ', 'スメーシーワールド': 'スメーシー',
  'タラポートショッピングパーク': 'タラポート', 'コンブトラック': 'コンブ', 'マンタマリア号': 'マンタ',
  'タカアシ経済特区': 'タカアシ', 'オヒョウ海運': 'オヒョウ', 'バイガイ亭': 'バイガイ',
  'ネギトロ炭鉱': 'ネギトロ', 'カジキ空港': 'カジキ', 'リュウグウターミナル': 'リュウグウ',
  'グランドバンカラアリーナ': 'バンカラ', 'ナンプラー遺跡': 'ナンプラー', 'クサヤ温泉': 'クサヤ',
  'ヒラメが丘団地': 'ヒラメ', 'デカライン高架下': 'デカライン', 'タチウオパーキング': 'タチウオ',
}
const shortStage = (k: string) => STAGE_SHORT[k] ?? k

const dimLabel = (dim: string) => DIM_OPTIONS.find(d => d.key === dim)?.label ?? dim
function dimKeyLabeller(dim: string): (k: string) => string {
  if (dim === 'rule')  return (k) => RULE_LABEL[k]  ?? k
  if (dim === 'lobby') return (k) => LOBBY_LABEL[k] ?? k
  if (dim === 'stage') return (k) => shortStage(k)
  return (k) => k
}

// ---------------------------------------------------------------------------
// 期間プリセット
// ---------------------------------------------------------------------------

type Period = 'all' | 'current_season' | '1y' | '180d' | '30d' | 'custom'
const PERIOD_OPTIONS: { key: Period; label: string }[] = [
  { key: 'all',            label: '全期間' },
  { key: 'current_season', label: '今シーズン' },
  { key: '1y',             label: '直近1年' },
  { key: '180d',           label: '180日' },
  { key: '30d',            label: '30日' },
  { key: 'custom',         label: 'カスタム' },
]

/** "YYYY-MM-DD" に日数を加算する（UTC 基準で tz ずれを避ける）。 */
function addDays(dateStr: string, delta: number): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + delta)
  return dt.toISOString().slice(0, 10)
}

/** ゲームバージョン表記の整形。stat.ink 由来の 3 桁コード（"800"）はドット区切り
 *  （"8.0.0"）へ。既にドット区切りならそのまま返す。 */
function formatGameVer(v: string): string {
  return /^\d{3}$/.test(v) ? `${v[0]}.${v[1]}.${v[2]}` : v
}

interface ImportProgress { current: number; total: number; phase: string }

// ---------------------------------------------------------------------------

export function EnvAnalysis() {
  const [status, setStatus]           = useState<EnvStatus | null>(null)
  const [importing, setImporting]     = useState(false)
  const [progress, setProgress]       = useState<ImportProgress | null>(null)
  const [error, setError]             = useState<string | null>(null)
  const [loading, setLoading]         = useState(false)   // 集計クエリ実行中

  // 共通フィルタ（#190: ロビー/ルールは複数選択）
  const [lobbyKeys, setLobbyKeys] = useState<string[]>([])
  const [ruleKeys, setRuleKeys]   = useState<string[]>([])
  const [period, setPeriod]     = useState<Period>('30d')   // 既定は直近30日
  const [customSince, setCustomSince] = useState('')
  const [customUntil, setCustomUntil] = useState('')

  // フィルタ拡充（#189）: バージョン / ウデマエ帯 / Xパワー帯
  const [versionOptions, setVersionOptions] = useState<EnvVersion[]>([])
  const [rankOptions, setRankOptions]       = useState<EnvRank[]>([])
  const [gameVers, setGameVers]       = useState<string[]>([])  // 選択中バージョン（複数）
  const [posterRanks, setPosterRanks] = useState<string[]>([])  // 選択中ウデマエ帯（複数）
  const [powerMin, setPowerMin] = useState('')                  // Xパワー下限（空 = 無指定）
  const [powerMax, setPowerMax] = useState('')                  // Xパワー上限（空 = 無指定）

  // 可視化モード
  const [vizMode, setVizMode] = useState<'scatter' | 'heatmap'>('scatter')

  // 散布図
  const [groupBy, setGroupBy] = useState<'weapon' | 'stage'>('weapon')
  const [xKey, setXKey]       = useState<string>('pick_rate')
  const [yKey, setYKey]       = useState<string>('win_rate')
  const [scatterData, setScatterData] = useState<EnvScatterStat[]>([])

  // ヒートマップ
  const [rowDim, setRowDim]         = useState('weapon')
  const [colDim, setColDim]         = useState('stage')
  const [cellMetric, setCellMetric] = useState<CellMetricKey>('win_rate')
  const [matrixData, setMatrixData] = useState<EnvMatrixCell[]>([])

  const hasData = status !== null && status.total_rows > 0

  // 集計軸を切り替えたら X/Y 指標を既定へ戻す
  useEffect(() => {
    if (groupBy === 'weapon') { setXKey('pick_rate'); setYKey('win_rate') }
    else                      { setXKey('ko_rate');   setYKey('avg_count') }
  }, [groupBy])

  // ヒートマップ次元を変えたらセル指標の妥当性を保つ
  const weaponInvolved = rowDim === 'weapon' || colDim === 'weapon'
  const bothWeapon     = rowDim === 'weapon' && colDim === 'weapon'
  const allowedCellMetrics = useMemo(
    () => CELL_METRICS.filter(m => (weaponInvolved && !bothWeapon ? m.weapon : !weaponInvolved ? !m.weapon : false)),
    [weaponInvolved, bothWeapon],
  )
  useEffect(() => {
    if (allowedCellMetrics.length > 0 && !allowedCellMetrics.some(m => m.key === cellMetric)) {
      setCellMetric(allowedCellMetrics[0].key)
    }
  }, [allowedCellMetrics, cellMetric])

  // 取得状況とシーズンレンジを読み込む
  const loadStatus = useCallback(async () => {
    try {
      const s = await invoke<EnvStatus>('env_status')
      setStatus(s)
      if (s.total_rows > 0) {
        try { setVersionOptions(await invoke<EnvVersion[]>('env_versions')) } catch { /* noop */ }
        try { setRankOptions(await invoke<EnvRank[]>('env_ranks')) } catch { /* noop */ }
      }
    } catch (e) {
      console.error('[EnvAnalysis] env_status 失敗:', e)
    }
  }, [])

  // 選択中の期間 → since / until
  const range = useMemo<{ since: string | null; until: string | null }>(() => {
    const maxd = status?.max_date ?? null
    switch (period) {
      case 'all':    return { since: null, until: null }
      // 他のプリセットは「データ最終取得日から遡る」相対期間だが、今シーズンだけは
      // 暦上のシーズン開始日（3/6/9/12 月始まりの 3 ヶ月サイクル）を since にする。
      // until は他と揃えて max_date（それ以降のデータは存在しない）。
      case 'current_season':
        return { since: currentSeasonStart(), until: maxd }
      case '1y':     return maxd ? { since: addDays(maxd, -364), until: maxd } : { since: null, until: null }
      case '180d':   return maxd ? { since: addDays(maxd, -179), until: maxd } : { since: null, until: null }
      case '30d':    return maxd ? { since: addDays(maxd, -29),  until: maxd } : { since: null, until: null }
      case 'custom': return { since: customSince || null, until: customUntil || null }
    }
  }, [period, status, customSince, customUntil])

  // 拡充フィルタ（#189）を invoke 引数へ。空配列 / 空文字は null（無指定）に正規化。
  const extFilters = useMemo(() => ({
    gameVers:    gameVers.length ? gameVers : null,
    posterRanks: posterRanks.length ? posterRanks : null,
    powerMin:    powerMin === '' ? null : Number(powerMin),
    powerMax:    powerMax === '' ? null : Number(powerMax),
  }), [gameVers, posterRanks, powerMin, powerMax])

  // データ読み込み（モード/フィルタ変更で再取得）
  const loadData = useCallback(async () => {
    if (!hasData) return
    setError(null)
    setLoading(true)
    try {
      if (vizMode === 'scatter') {
        const rows = await invoke<EnvScatterStat[]>('env_scatter_stats', {
          groupBy,
          side:     'all',
          lobbyKeys,
          ruleKeys,
          stageKey: null,
          since:    range.since,
          until:    range.until,
          ...extFilters,
        })
        setScatterData(rows)
      } else {
        if (bothWeapon) { setMatrixData([]); return }
        // 次元を変えた直後、セル指標が新しい次元にまだ整合していない一瞬は取得しない
        // （直後に走る useEffect が cellMetric を有効値へ補正し、再取得される）。
        if (!allowedCellMetrics.some(m => m.key === cellMetric)) return
        const cells = await invoke<EnvMatrixCell[]>('env_matrix_stats', {
          rowDim, colDim, cellMetric,
          lobbyKeys,
          ruleKeys,
          stageKey: null,
          since:    range.since,
          until:    range.until,
          ...extFilters,
        })
        setMatrixData(cells)
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [hasData, vizMode, groupBy, lobbyKeys, ruleKeys, range, rowDim, colDim, cellMetric, bothWeapon, allowedCellMetrics, extFilters])

  useEffect(() => { loadStatus() }, [loadStatus])
  useEffect(() => { loadData() }, [loadData])

  // 進捗イベント購読
  useEffect(() => {
    const unlisten = listen<ImportProgress>('env_import_progress', (e) => setProgress(e.payload))
    return () => { unlisten.then(fn => fn()) }
  }, [])

  async function handleDownloadFull() {
    if (importing) return
    setImporting(true); setError(null)
    setProgress({ current: 0, total: 1, phase: 'download' })
    try {
      await invoke<number>('import_env_full')
      await loadStatus()
    } catch (e) { setError(String(e)) }
    finally { setImporting(false); setProgress(null) }
  }

  async function handleDelta() {
    if (importing) return
    setImporting(true); setError(null)
    setProgress({ current: 0, total: 1, phase: 'download' })
    try {
      await invoke<number>('import_env_delta')
      await loadStatus()
    } catch (e) { setError(String(e)) }
    finally { setImporting(false); setProgress(null) }
  }

  // 散布図ポイント生成
  const metrics = groupBy === 'weapon' ? WEAPON_METRICS : STAGE_METRICS
  const xM = metrics.find(m => m.key === xKey) ?? metrics[0]
  const yM = metrics.find(m => m.key === yKey) ?? metrics[1]
  const usesKda = (xM.kda || yM.kda) ?? false

  const points: ScatterPoint[] = useMemo(() => scatterData.map(s => {
    const x = xM.get(s)
    const y = yM.get(s)
    return {
      name: s.key,
      x, y,
      size: null,
      color: 'var(--accent)',
      tooltipRows: [
        { label: groupBy === 'weapon' ? '武器' : 'ステージ', value: s.key },
        { label: xM.label, value: x == null ? '—' : xM.fmt(x) },
        { label: yM.label, value: y == null ? '—' : yM.fmt(y) },
        { label: 'サンプル', value: s.n.toLocaleString() },
      ],
    }
  }).filter(p => p.x !== null && p.y !== null), [scatterData, xM, yM, groupBy])

  const xDomain = useMemo(() => computeDomain(points.map(p => p.x as number), xM.rate01), [points, xM])
  const yDomain = useMemo(() => computeDomain(points.map(p => p.y as number), yM.rate01), [points, yM])

  const cm = CELL_METRICS.find(m => m.key === cellMetric) ?? CELL_METRICS[0]

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
        <div className="env-placeholder">
          <div className="env-placeholder-icon">🌍</div>
          <h3>環境データが未取得です</h3>
          <p>stat.ink の公開データから全世界のバトル統計を取得します</p>
          <p className="env-placeholder-sub">推定ダウンロード量: 約 944 MiB / 推定時間: 10〜15 分</p>
          <button className="btn-primary" onClick={handleDownloadFull} disabled={importing}>
            {importing ? 'ダウンロード中...' : 'データを取得する'}
          </button>
          {error && <p className="env-error">{error}</p>}
          {progress && <ProgressDisplay progress={progress} />}
        </div>
      ) : (
        <>
          <div className="env-data-header">
            <span className="env-data-range">
              データ: {status.min_date} 〜 {status.max_date} /&nbsp;
              {(status.total_rows / 10000).toFixed(1)} 万行
            </span>
            <button className="btn-secondary" onClick={handleDelta} disabled={importing}
                    title="最終取得日の翌日から昨日分を差分取得します">
              {importing ? '更新中...' : '差分更新'}
            </button>
            {error && <span className="env-error">{error}</span>}
          </div>

          {progress && <ProgressDisplay progress={progress} />}

          {/* モード切替 */}
          <div className="env-mode-tabs">
            <button className={vizMode === 'scatter' ? 'env-mode-tab is-active' : 'env-mode-tab'}
                    onClick={() => setVizMode('scatter')}>散布図</button>
            <button className={vizMode === 'heatmap' ? 'env-mode-tab is-active' : 'env-mode-tab'}
                    onClick={() => setVizMode('heatmap')}>ヒートマップ</button>
          </div>

          {/* 共通フィルタ */}
          <div className="env-filters">
            <MultiSelect
              label="ロビー"
              allLabel="すべてのロビー"
              selected={lobbyKeys}
              onChange={setLobbyKeys}
              options={LOBBY_OPTIONS.filter(o => o.key).map(o => ({ key: o.key, label: o.label }))}
            />
            <MultiSelect
              label="ルール"
              allLabel="すべてのルール"
              selected={ruleKeys}
              onChange={setRuleKeys}
              options={RULE_OPTIONS.filter(o => o.key).map(o => ({ key: o.key, label: o.label }))}
            />
            <label>期間
              <select value={period} onChange={e => setPeriod(e.target.value as Period)}>
                {PERIOD_OPTIONS.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
              </select>
            </label>
            {period === 'custom' && (
              <>
                <label>開始
                  <input type="date" value={customSince} max={status.max_date ?? undefined}
                         min={status.min_date ?? undefined} onChange={e => setCustomSince(e.target.value)} />
                </label>
                <label>終了
                  <input type="date" value={customUntil} max={status.max_date ?? undefined}
                         min={status.min_date ?? undefined} onChange={e => setCustomUntil(e.target.value)} />
                </label>
              </>
            )}
            <MultiSelect
              label="バージョン"
              allLabel="すべてのバージョン"
              selected={gameVers}
              onChange={setGameVers}
              options={versionOptions.map(v => ({
                key:   v.game_ver,
                label: `${formatGameVer(v.game_ver)}（${(v.n / 10000).toFixed(1)} 万）`,
                short: formatGameVer(v.game_ver),
              }))}
            />
            <MultiSelect
              label="ウデマエ帯"
              allLabel="すべてのウデマエ"
              selected={posterRanks}
              onChange={setPosterRanks}
              options={rankOptions.map(r => ({
                key:   r.poster_rank,
                label: `${r.poster_rank.toUpperCase()}（${r.n.toLocaleString()}）`,
                short: r.poster_rank.toUpperCase(),
              }))}
            />
            <label>Xパワー帯
              <span className="env-power-range">
                <input type="number" inputMode="numeric" placeholder="下限" step={50}
                       value={powerMin} onChange={e => setPowerMin(e.target.value)} />
                <span className="env-power-sep">〜</span>
                <input type="number" inputMode="numeric" placeholder="上限" step={50}
                       value={powerMax} onChange={e => setPowerMax(e.target.value)} />
              </span>
            </label>
          </div>

          {(posterRanks.length > 0 || powerMin !== '' || powerMax !== '') && (
            <p className="env-filter-note">
              ※ ウデマエ帯・Xパワーは投稿者（A1）のみの記録に基づく絞り込みです。
              対戦相手 7 名の帯は含まれないため、参加者全員がこの帯であることは保証されません。
              Xパワーは X マッチ等の投稿でのみ記録されます。
            </p>
          )}

          <div className="env-status-line">
            {loading
              ? <span className="env-loading"><span className="env-loading-spinner" />集計中…</span>
              : <span className="env-updated">✓ 表示は最新です</span>}
          </div>

          {vizMode === 'scatter' ? (
            <>
              <div className="env-filters">
                <label>集計軸
                  <select value={groupBy} onChange={e => setGroupBy(e.target.value as 'weapon' | 'stage')}>
                    <option value="weapon">武器別</option>
                    <option value="stage">ステージ別</option>
                  </select>
                </label>
                <label>X軸
                  <select value={xKey} onChange={e => setXKey(e.target.value)}>
                    {metrics.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
                  </select>
                </label>
                <label>Y軸
                  <select value={yKey} onChange={e => setYKey(e.target.value)}>
                    {metrics.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
                  </select>
                </label>
              </div>

              <div className="env-chart-section">
                <h3 className="env-chart-title">{xM.label} vs {yM.label}（{groupBy === 'weapon' ? '武器別' : 'ステージ別'}）</h3>
                {points.length === 0 ? (
                  <p className="env-no-data">条件に一致するデータがありません（50 サンプル未満は非表示）</p>
                ) : (
                  <ScatterChart
                    points={points}
                    xLabel={xM.label} yLabel={yM.label}
                    xIsRate={xM.rate01} yIsRate={yM.rate01}
                    xDomain={xDomain} yDomain={yDomain}
                    xRefLine={xM.key === 'win_rate' ? 0.5 : undefined}
                    yRefLine={yM.key === 'win_rate' ? 0.5 : undefined}
                    constSize={300}
                    fillOpacity={0.55}
                    height={440}
                  />
                )}
                <p className="env-chart-note">
                  50 サンプル未満は非表示。各点にマウスオーバーで詳細表示。
                  {usesKda && ' ※KDA系の指標は記録のある A1・B1（投稿者・相手代表）を母数にしています。'}
                </p>
              </div>
            </>
          ) : (
            <>
              <div className="env-filters">
                <label>行
                  <select value={rowDim} onChange={e => setRowDim(e.target.value)}>
                    {DIM_OPTIONS.map(d => <option key={d.key} value={d.key}>{d.label}</option>)}
                  </select>
                </label>
                <label>列
                  <select value={colDim} onChange={e => setColDim(e.target.value)}>
                    {DIM_OPTIONS.map(d => <option key={d.key} value={d.key}>{d.label}</option>)}
                  </select>
                </label>
                <label>セル指標
                  <select value={cellMetric} onChange={e => setCellMetric(e.target.value as CellMetricKey)}>
                    {allowedCellMetrics.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
                  </select>
                </label>
              </div>

              <div className="env-chart-section">
                <h3 className="env-chart-title">{dimLabel(rowDim)} × {dimLabel(colDim)}（{cm.label}）</h3>
                {bothWeapon ? (
                  <p className="env-no-data">武器 × 武器は非対応です。一方をステージ/ルール/ロビーにしてください。</p>
                ) : (
                  <Heatmap
                    cells={matrixData}
                    valueLabel={cm.fmt}
                    scale={cm.scale}
                    mid={0.5}
                    rowAxis={dimLabel(rowDim)}
                    colAxis={dimLabel(colDim)}
                    rowLabel={dimKeyLabeller(rowDim)}
                    colLabel={dimKeyLabeller(colDim)}
                    diagonalCols={colDim === 'stage'}
                  />
                )}
                <p className="env-chart-note">
                  30 サンプル未満のセルは非表示。セルにマウスオーバーで件数を表示。
                  {cellMetric === 'win_rate' && ' 勝率は 50% を中心に赤(低)〜青(高)。'}
                </p>
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}

/** 「キリのよい」目盛り幅（1 / 2 / 5 × 10^n）を返す。 */
function niceStep(x: number): number {
  if (x <= 0) return 1
  const base = Math.pow(10, Math.floor(Math.log10(x)))
  const f = x / base
  const nf = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10
  return nf * base
}

/** データ配列から、目盛りがキリのよい値になる軸ドメインを算出する（オートスケール）。
 *  値はすべて非負なので下端は 0 未満に伸ばさない。 */
function computeDomain(vals: number[], rate01: boolean): [number, number] {
  if (vals.length === 0) return [0, 1]
  let lo = Math.min(...vals)
  let hi = Math.max(...vals)
  if (lo === hi) {
    const pad = Math.abs(lo) * 0.1 || (rate01 ? 0.05 : 1)
    lo -= pad; hi += pad
  }
  const step = niceStep((hi - lo) / 4)
  let nlo = Math.floor(lo / step) * step
  let nhi = Math.ceil(hi / step) * step
  if (nlo < 0) nlo = 0                               // 値は非負
  if (rate01) { nlo = Math.max(0, nlo); nhi = Math.min(1, nhi) }
  const round = (x: number) => Math.round(x * 1e6) / 1e6  // 浮動小数の誤差を除去
  return [round(nlo), round(nhi)]
}

/** 進捗バー表示。 */
function ProgressDisplay({ progress }: { progress: ImportProgress }) {
  const pctv = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0
  const phaseLabel =
    progress.phase === 'download' ? 'ダウンロード中' :
    progress.phase === 'extract'  ? '解凍中' :
    progress.phase === 'index'    ? 'インデックス作成中' :
    'インポート中'
  return (
    <div className="env-progress">
      <div className="env-progress-label">
        {phaseLabel}... {pctv}% ({progress.current.toLocaleString()} / {progress.total.toLocaleString()})
      </div>
      <div className="env-progress-bar">
        <div className="env-progress-fill" style={{ width: `${pctv}%` }} />
      </div>
    </div>
  )
}
