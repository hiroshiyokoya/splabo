/**
 * 環境分析タブ（#184 / 拡張 #187）。
 *
 * stat.ink の公開バトルデータ（全世界のプレイヤー投稿）を取り込み、
 * 散布図（武器/ステージ別）とマトリクスヒートマップ（カテゴリ×カテゴリ）で
 * 「ステージや武器によってバトル統計がどう変わるか」を見る。
 *
 * 散布図はピック率のようなロングテール指標を読むため、X/Y 軸ごとにログスケールへ
 * 切り替えられる（#473）。ピック率の表示は 2 桁固定（マイナー武器が 0.0% に潰れるため）。
 *
 * 注意: stat.ink ユーザーは一般プレイヤーより熱心な層に偏るため、
 *       データには投稿バイアスがあります。
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type {
  EnvScatterStat, EnvMatrixCell, EnvMatrixMarginal, EnvMatrixStats,
  EnvStatus, EnvVersion, EnvRank, EnvFilterOption, MetricKey, GroupByKey,
} from '../types'
import { currentSeasonStart, GROUP_BY_LABELS } from '../types'
import { ScatterChart, buildSizeLegend, buildColorLegend } from './charts/ScatterChart'
import type { ScatterPoint } from './charts/ScatterChart'
import { Heatmap } from './charts/Heatmap'
import { MultiSelect } from './MultiSelect'
import { rateCellColor, sequentialCellColor, AXIS_MIN_TOTAL_SAMPLES } from '../utils/heatmapColors'
import { loadEnvPrefs, saveEnvPrefs, DEFAULT_ENV_PREFS } from '../utils/envPrefs'
import {
  SCATTER_CATEGORY_COLOR_KEYS, isScatterCategoryColorKey, categoryStyleOf,
  buildCategoryColorLegend, categoryValueForEnvStat,
} from '../utils/scatterCategoryColors'
import { PanelExportButton, PanelExportCaption, PanelExportLogo, PanelExportNote } from './PanelExport'
import { EXPORT_HIDE_CLASS } from '../utils/panelExport'
import { joinConditions, joinValues, formatAbsolutePeriodRange } from '../utils/filterSummary'

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
// ピック率専用（#473）。マイナー武器は 0.1% 未満に集まっていて 1 桁だと全部 0.0% になり
// 差が読めないため、2 桁にする。
const pct2   = (v: number) => `${(v * 100).toFixed(2)}%`
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
  kda?:   boolean              // KDA 系（記録のあるプレイヤーだけが母数・注記対象）
}

/** ログスケールを許さない指標（#473）。勝率は 0.5 前後の狭い帯に収まるので、
 *  ログにしても読みやすくならず、参照線 50% との相性も悪い。 */
const NO_LOG_METRICS = new Set(['win_rate'])

/** EnvScatterStat の数値フィールドをそのまま取り出すアクセサ。 */
const field = (k: keyof EnvScatterStat) => (s: EnvScatterStat) => s[k] as number | null

const WEAPON_METRICS: ScatterMetric[] = [
  { key: 'pick_rate',  label: 'ピック率',   rate01: true,  fmt: pct2, get: field('pick_rate') },
  { key: 'win_rate',   label: '勝率',       rate01: true,  fmt: pct,  get: field('win_rate') },
  { key: 'avg_kill',   label: '平均キル',   rate01: false, fmt: num2, get: field('avg_kill'),   kda: true },
  { key: 'avg_assist', label: '平均アシスト', rate01: false, fmt: num2, get: field('avg_assist'), kda: true },
  { key: 'contrib_kill', label: '平均貢献キル', rate01: false, fmt: num2, kda: true,
    get: (s) => (s.avg_kill != null && s.avg_assist != null) ? s.avg_kill + s.avg_assist : null },
  { key: 'avg_death',  label: '平均デス',   rate01: false, fmt: num2, get: field('avg_death'),  kda: true },
  { key: 'kill_ratio', label: 'キルレ',     rate01: false, fmt: num2, kda: true,
    get: (s) => (s.avg_kill != null && s.avg_death != null && s.avg_death > 0) ? s.avg_kill / s.avg_death : null },
  { key: 'contrib_ratio', label: '貢献キルレ', rate01: false, fmt: num2, kda: true,
    get: (s) => (s.avg_kill != null && s.avg_assist != null && s.avg_death != null && s.avg_death > 0)
      ? (s.avg_kill + s.avg_assist) / s.avg_death : null },
  { key: 'avg_inked',  label: '平均塗りP',  rate01: false, fmt: pint, get: field('avg_inked'),  kda: true },
]

const STAGE_METRICS: ScatterMetric[] = [
  // 勝率・KDA は武器絞り込み時だけ BE が埋める（#478）。未選択時は点が null で落ちる。
  { key: 'win_rate',   label: '勝率',       rate01: true,  fmt: pct,  get: field('win_rate') },
  { key: 'avg_kill',   label: '平均キル',   rate01: false, fmt: num2, get: field('avg_kill'),   kda: true },
  { key: 'avg_assist', label: '平均アシスト', rate01: false, fmt: num2, get: field('avg_assist'), kda: true },
  { key: 'contrib_kill', label: '平均貢献キル', rate01: false, fmt: num2, kda: true,
    get: (s) => (s.avg_kill != null && s.avg_assist != null) ? s.avg_kill + s.avg_assist : null },
  { key: 'avg_death',  label: '平均デス',   rate01: false, fmt: num2, get: field('avg_death'),  kda: true },
  { key: 'kill_ratio', label: 'キルレ',     rate01: false, fmt: num2, kda: true,
    get: (s) => (s.avg_kill != null && s.avg_death != null && s.avg_death > 0) ? s.avg_kill / s.avg_death : null },
  { key: 'contrib_ratio', label: '貢献キルレ', rate01: false, fmt: num2, kda: true,
    get: (s) => (s.avg_kill != null && s.avg_assist != null && s.avg_death != null && s.avg_death > 0)
      ? (s.avg_kill + s.avg_assist) / s.avg_death : null },
  { key: 'avg_count',    label: '平均カウント', rate01: false, fmt: num1,   get: field('avg_count') },
  { key: 'avg_ink_self', label: '自分側 塗り%', rate01: false, fmt: pct100, get: field('avg_ink_self') },
  { key: 'avg_ink_opp',  label: '相手側 塗り%', rate01: false, fmt: pct100, get: field('avg_ink_opp') },
]

/** ステージ散布図で武器未選択だと無意味な指標（#478）。 */
const STAGE_WEAPON_ONLY = new Set([
  'win_rate', 'avg_kill', 'avg_assist', 'contrib_kill', 'avg_death', 'kill_ratio', 'contrib_ratio',
])

// ヒートマップのセル指標
type CellMetricKey =
  | 'win_rate' | 'pick_rate' | 'ko_rate' | 'battles'
  | 'avg_kill' | 'avg_assist' | 'contrib_kill' | 'avg_death' | 'kill_ratio' | 'contrib_ratio' | 'avg_inked'
// キル系（記録のあるプレイヤーだけが母数・専用しきい値）。注記・母数表示の切り替えに使う。
// 平均塗りP(avg_inked)も同じ母数なのでここに含める（#336 で元データの列マッピングを修正済み）。
const KDA_CELL_KEYS: CellMetricKey[] = [
  'avg_kill', 'avg_assist', 'contrib_kill', 'avg_death', 'kill_ratio', 'contrib_ratio', 'avg_inked',
]
interface CellMetric {
  key:    CellMetricKey
  label:  string
  fmt:    (v: number) => string
  scale:  'sequential' | 'diverging'
  weapon: boolean   // weapon 次元が必要か
  mid?:   number    // diverging の中心値（既定 0.5）
  hue?:   number    // sequential の色相（既定 210=青）。デスは 8=赤（高いほど悪い）
}
const CELL_METRICS: CellMetric[] = [
  { key: 'win_rate',      label: '勝率',         fmt: pct,  scale: 'diverging',  weapon: true, mid: 0.5 },
  { key: 'pick_rate',     label: 'ピック率',     fmt: pct2, scale: 'sequential', weapon: true },
  { key: 'avg_kill',      label: '平均キル',     fmt: num2, scale: 'sequential', weapon: true },
  { key: 'avg_assist',    label: '平均アシスト', fmt: num2, scale: 'sequential', weapon: true },
  { key: 'contrib_kill',  label: '平均貢献キル', fmt: num2, scale: 'sequential', weapon: true },
  { key: 'avg_death',     label: '平均デス',     fmt: num2, scale: 'sequential', weapon: true, hue: 8 },
  { key: 'kill_ratio',    label: 'キルレ',       fmt: num2, scale: 'diverging',  weapon: true, mid: 1.0 },
  { key: 'contrib_ratio', label: '貢献キルレ',   fmt: num2, scale: 'diverging',  weapon: true, mid: 1.0 },
  { key: 'avg_inked',     label: '平均塗りP',   fmt: pint, scale: 'sequential', weapon: true },
  { key: 'ko_rate',       label: 'KO率',         fmt: pct,  scale: 'sequential', weapon: false },
  { key: 'battles',       label: 'バトル数',     fmt: pint, scale: 'sequential', weapon: false },
]
// ルールを次元にしたときの並び順（ガチ系を先・ナワバリを最後）。
const RULE_HEATMAP_ORDER = ['area', 'yagura', 'hoko', 'asari', 'nawabari']

/** 投稿者除外の説明（#501）。stat.ink の全体統計と同じく、投稿者本人を母数から外して
 *  残り 7 人で集計している。散布図・ヒートマップ・保存画像で同じ文言を使う。 */
const POSTER_EXCLUDED_TEXT = '集計は投稿者を除く 7 人分（stat.ink の全体統計と同じ）'
/** 画面の注釈用。 */
const POSTER_EXCLUDED_NOTE = `※ ${POSTER_EXCLUDED_TEXT}。`

/** 画像に焼き込む注釈（#500）。パネル上の長文をそのまま入れるとレイアウトが崩れるので、
 *  足切り・母数だけの 1 行に抑える。出典はキャプション先頭に出す。 */
const SCATTER_EXPORT_NOTE =
  `50 サンプル未満は非表示／${POSTER_EXCLUDED_TEXT}`
const heatmapExportNote = (kda: boolean) =>
  `${kda ? 20 : 30} サンプル未満のセルは非表示／${POSTER_EXCLUDED_TEXT}`

/** 保存画像のキャプション先頭。出典を最初に出す。 */
function envExportCaption(filterSummary: string): string {
  return filterSummary ? `出典: stat.ink／${filterSummary}` : '出典: stat.ink'
}

/** スロット単位の集計が必要なヒートマップ次元（#481）。 */
const WEAPON_SLOT_DIMS = ['weapon', 'weapon_category', 'sub_weapon', 'special_weapon'] as const
const isWeaponSlotDim = (dim: string) =>
  (WEAPON_SLOT_DIMS as readonly string[]).includes(dim)

const DIM_OPTIONS = [
  { key: 'weapon',          label: GROUP_BY_LABELS.weapon },
  { key: 'weapon_category', label: GROUP_BY_LABELS.weapon_category },
  { key: 'sub_weapon',      label: GROUP_BY_LABELS.sub_weapon },
  { key: 'special_weapon',  label: GROUP_BY_LABELS.special_weapon },
  { key: 'stage',           label: GROUP_BY_LABELS.stage },
  { key: 'rule',            label: GROUP_BY_LABELS.rule },
  { key: 'lobby',           label: GROUP_BY_LABELS.mode },
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
  { key: '1y',             label: '1年' },
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
// 散布図ツールチップの行（#406）
// ---------------------------------------------------------------------------

type TooltipRow = { label: string; value: string; muted?: boolean }

/**
 * X / Y / サイズ / 色 は同じ指標を割り当てられるため（例: サイズと色を両方「勝率」）、
 * そのまま並べると同じ行が 2 度出る。指標キーで重複排除し、先に積んだ行を優先する
 * （= X/Y 側が残る）。#388（カスタムグラフ）の dedupe と同じ考え方。
 */
function dedupeMetricRows(entries: { key: string; row: TooltipRow }[]): TooltipRow[] {
  const seen = new Set<string>()
  const out: TooltipRow[] = []
  for (const { key, row } of entries) {
    if (seen.has(key)) continue
    seen.add(key)
    out.push(row)
  }
  return out
}

/** BE の周辺集計 → 軸見出し用の射影値マップ（#411）。
 *  合計標本数が少ない軸は色を付けない（null＝既定色）。セル単位ではなく軸単位で足切りする。 */
function marginalProjection(ms: EnvMatrixMarginal[]): Map<string, number | null> {
  return new Map(ms.map(m => [m.key, m.n >= AXIS_MIN_TOTAL_SAMPLES ? m.value : null]))
}

export function EnvAnalysis() {
  // 選択状態の永続化（#407）。mount 時に localStorage から一度だけ読む。
  const [prefs] = useState(loadEnvPrefs)
  const [status, setStatus]           = useState<EnvStatus | null>(null)
  const [importing, setImporting]     = useState(false)
  const [progress, setProgress]       = useState<ImportProgress | null>(null)
  const [error, setError]             = useState<string | null>(null)
  const [loading, setLoading]         = useState(false)   // 集計クエリ実行中

  // 共通フィルタ（#190: ロビー/ルールは複数選択）
  const [lobbyKeys, setLobbyKeys] = useState<string[]>(prefs.lobbyKeys)
  const [ruleKeys, setRuleKeys]   = useState<string[]>(prefs.ruleKeys)
  const [period, setPeriod]     = useState<Period>(prefs.period as Period)   // 既定は直近30日
  const [customSince, setCustomSince] = useState(prefs.customSince)
  const [customUntil, setCustomUntil] = useState(prefs.customUntil)

  // フィルタ拡充（#189）: バージョン / ウデマエ帯 / Xパワー帯
  // 武器・ステージ（#477）
  const [versionOptions, setVersionOptions] = useState<EnvVersion[]>([])
  const [rankOptions, setRankOptions]       = useState<EnvRank[]>([])
  const [weaponOptions, setWeaponOptions]   = useState<EnvFilterOption[]>([])
  const [stageOptions, setStageOptions]     = useState<EnvFilterOption[]>([])
  const [gameVers, setGameVers]       = useState<string[]>(prefs.gameVers)      // 選択中バージョン（複数）
  const [posterRanks, setPosterRanks] = useState<string[]>(prefs.posterRanks)   // 選択中ウデマエ帯（複数）
  const [weaponKeys, setWeaponKeys]   = useState<string[]>(prefs.weaponKeys)
  const [stageKeys, setStageKeys]     = useState<string[]>(prefs.stageKeys)
  const [powerMin, setPowerMin] = useState(prefs.powerMin)                       // Xパワー下限（空 = 無指定）
  const [powerMax, setPowerMax] = useState(prefs.powerMax)                       // Xパワー上限（空 = 無指定）

  /** 共通フィルタが既定（クリア済み）かどうか（#456）。 */
  const filtersAreDefault =
    lobbyKeys.length === 0 &&
    ruleKeys.length === 0 &&
    weaponKeys.length === 0 &&
    stageKeys.length === 0 &&
    gameVers.length === 0 &&
    posterRanks.length === 0 &&
    powerMin === '' &&
    powerMax === '' &&
    period === DEFAULT_ENV_PREFS.period &&
    customSince === '' &&
    customUntil === ''

  /** 共通フィルタを未指定（初期状態）に戻す（#456）。永続化は既存の save 用 effect が拾う。 */
  function clearFilters() {
    setLobbyKeys([])
    setRuleKeys([])
    setWeaponKeys([])
    setStageKeys([])
    setGameVers([])
    setPosterRanks([])
    setPowerMin('')
    setPowerMax('')
    setPeriod(DEFAULT_ENV_PREFS.period as Period)
    setCustomSince('')
    setCustomUntil('')
  }

  // 画像保存（#500）。共通フィルタはパネルの外にあるので、画像には条件を焼き込む。
  const scatterPanelRef = useRef<HTMLDivElement>(null)
  const heatmapPanelRef = useRef<HTMLDivElement>(null)

  // 可視化モード
  const [vizMode, setVizMode] = useState<'scatter' | 'heatmap'>(prefs.vizMode)

  // 散布図
  const [groupBy, setGroupBy] = useState<'weapon' | 'stage'>(prefs.groupBy)
  const [xKey, setXKey]       = useState<string>(prefs.xKey)
  const [yKey, setYKey]       = useState<string>(prefs.yKey)
  const [sizeKey, setSizeKey] = useState<string>(prefs.sizeKey)   // 散布図サイズ指標（''=なし・#406）
  const [colorKey, setColorKey] = useState<string>(prefs.colorKey) // 散布図色指標（''=なし・#406）
  const [xLog, setXLog]       = useState<boolean>(prefs.xLog)     // 散布図 X 軸ログスケール（#473）
  const [yLog, setYLog]       = useState<boolean>(prefs.yLog)
  const [scatterData, setScatterData] = useState<EnvScatterStat[]>([])
  // scatterData がどちらの集計軸のものか（#412）。groupBy は選択した瞬間に変わるが
  // scatterData は再取得が終わるまで前の軸のまま。アイコンの kind をこの遅れた軸で決めないと、
  // 切り替え直後に「武器名を kind:'stage' で読みに行く」空振りの invoke が飛ぶ。
  const [scatterAxis, setScatterAxis] = useState<'weapon' | 'stage'>(groupBy)

  // ヒートマップ
  const [rowDim, setRowDim]         = useState(prefs.rowDim)
  const [colDim, setColDim]         = useState(prefs.colDim)
  const [cellMetric, setCellMetric] = useState<CellMetricKey>(prefs.cellMetric as CellMetricKey)
  const [matrixData, setMatrixData] = useState<EnvMatrixCell[]>([])
  // 行・列の周辺集計（#411）。セルの足切りに影響されない値なので BE から受け取る。
  const [rowMarginals, setRowMarginals] = useState<EnvMatrixMarginal[]>([])
  const [colMarginals, setColMarginals] = useState<EnvMatrixMarginal[]>([])
  // ヒートマップ列見出しクリックによる行ソート（#479）。永続化しない。
  const [heatmapSortCol, setHeatmapSortCol] = useState<string | null>(null)
  const [heatmapSortDir, setHeatmapSortDir] = useState<'asc' | 'desc'>('desc')

  const hasData = status !== null && status.total_rows > 0

  // 選択状態の永続化（#407）。変更のたびに localStorage（+ settings.json ミラー）へ保存する。
  // mount 直後の初回は復元値をそのまま書き戻すだけなのでスキップ（無駄なミラーを避ける）。
  const firstSaveRun = useRef(true)
  useEffect(() => {
    if (firstSaveRun.current) { firstSaveRun.current = false; return }
    saveEnvPrefs({
      vizMode, groupBy, xKey, yKey, sizeKey, colorKey, xLog, yLog,
      rowDim, colDim, cellMetric,
      period, customSince, customUntil,
      lobbyKeys, ruleKeys, weaponKeys, stageKeys, gameVers, posterRanks, powerMin, powerMax,
    })
  }, [vizMode, groupBy, xKey, yKey, sizeKey, colorKey, xLog, yLog, rowDim, colDim, cellMetric,
      period, customSince, customUntil, lobbyKeys, ruleKeys, weaponKeys, stageKeys, gameVers, posterRanks, powerMin, powerMax])

  // 集計軸を切り替えたら X/Y・サイズ・色 指標を既定へ戻す。
  // 「初回だけスキップ」の ref フラグは StrictMode の二重マウントで false のまま
  // 再マウントされ、復元済みの選択（特に sizeKey/colorKey）を潰す。値の比較で
  // 実際に groupBy が変わったときだけリセットする（マウント・StrictMode 再マウントは素通し・#407）。
  const prevGroupBy = useRef(groupBy)
  useEffect(() => {
    if (prevGroupBy.current === groupBy) return   // マウント / 変化なし
    prevGroupBy.current = groupBy
    if (groupBy === 'weapon') { setXKey('pick_rate'); setYKey('win_rate') }
    else                      { setXKey('avg_ink_self'); setYKey('avg_count') }
    setSizeKey(''); setColorKey('')   // 指標セットが変わるのでサイズ/色はリセット（#406）
  }, [groupBy])

  // ステージ軸で武器フィルタが空のとき、勝率・KDA が選ばれていたらステージ固有指標へ戻す（#478）。
  // 武器を選んだ直後は勝率 vs キルレを既定にする。
  const prevWeaponFilter = useRef(weaponKeys.length > 0)
  useEffect(() => {
    if (groupBy !== 'stage') { prevWeaponFilter.current = weaponKeys.length > 0; return }
    const hasW = weaponKeys.length > 0
    if (!hasW) {
      if (STAGE_WEAPON_ONLY.has(xKey)) setXKey('avg_ink_self')
      if (STAGE_WEAPON_ONLY.has(yKey)) setYKey('avg_count')
      if (STAGE_WEAPON_ONLY.has(sizeKey)) setSizeKey('')
      if (STAGE_WEAPON_ONLY.has(colorKey)) setColorKey('')
    } else if (!prevWeaponFilter.current) {
      setXKey('win_rate'); setYKey('kill_ratio')
    }
    prevWeaponFilter.current = hasW
  }, [groupBy, weaponKeys, xKey, yKey, sizeKey, colorKey])

  // ヒートマップ次元を変えたらセル指標の妥当性を保つ
  const weaponSlotInvolved = isWeaponSlotDim(rowDim) || isWeaponSlotDim(colDim)
  const bothWeaponSlot     = isWeaponSlotDim(rowDim) && isWeaponSlotDim(colDim)
  const allowedCellMetrics = useMemo(
    () => CELL_METRICS.filter(m => (weaponSlotInvolved && !bothWeaponSlot ? m.weapon : !weaponSlotInvolved ? !m.weapon : false)),
    [weaponSlotInvolved, bothWeaponSlot],
  )
  useEffect(() => {
    if (allowedCellMetrics.length > 0 && !allowedCellMetrics.some(m => m.key === cellMetric)) {
      setCellMetric(allowedCellMetrics[0].key)
    }
  }, [allowedCellMetrics, cellMetric])

  // ヒートマップの軸・指標を変えたら列ソートを既定に戻す（#479）。
  useEffect(() => {
    setHeatmapSortCol(null)
    setHeatmapSortDir('desc')
  }, [rowDim, colDim, cellMetric])

  function handleHeatmapColHeaderClick(colKey: string) {
    if (heatmapSortCol === colKey) setHeatmapSortDir(d => (d === 'desc' ? 'asc' : 'desc'))
    else { setHeatmapSortCol(colKey); setHeatmapSortDir('desc') }
  }

  function clearHeatmapSort() {
    setHeatmapSortCol(null)
    setHeatmapSortDir('desc')
  }

  // 取得状況とシーズンレンジを読み込む
  const loadStatus = useCallback(async () => {
    try {
      const s = await invoke<EnvStatus>('env_status')
      setStatus(s)
      if (s.total_rows > 0) {
        try { setVersionOptions(await invoke<EnvVersion[]>('env_versions')) } catch { /* noop */ }
        try { setRankOptions(await invoke<EnvRank[]>('env_ranks')) } catch { /* noop */ }
        try { setWeaponOptions(await invoke<EnvFilterOption[]>('env_weapons')) } catch { /* noop */ }
        try { setStageOptions(await invoke<EnvFilterOption[]>('env_stages')) } catch { /* noop */ }
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

  // 画像に焼き込む条件（#500 / #506）。期間はクエリと同じ since/until を絶対日付で。
  const envFilterSummary = useMemo(() => {
    const optLabel = (opts: { key: string; label: string }[], k: string) =>
      opts.find(o => o.key === k)?.label ?? k
    // データ未取得で相対期間が解けないときだけ、UI と同じラベルにフォールバックする。
    const periodCaption = (() => {
      if (period === 'all') return '全期間'
      if (period === 'custom') {
        return `${range.since || '—'}〜${range.until || '—'}`
      }
      if (range.since || range.until) {
        return formatAbsolutePeriodRange(range.since, range.until)
      }
      return PERIOD_OPTIONS.find(o => o.key === period)?.label ?? period
    })()
    return joinConditions([
      ['期間', periodCaption],
      ['ロビー',     lobbyKeys.length ? joinValues(lobbyKeys.map(k => LOBBY_LABEL[k] ?? k)) : null],
      ['ルール',     ruleKeys.length ? joinValues(ruleKeys.map(k => RULE_LABEL[k] ?? k)) : null],
      ['武器',       weaponKeys.length ? joinValues(weaponKeys.map(k => optLabel(weaponOptions, k))) : null],
      ['ステージ',   stageKeys.length ? joinValues(stageKeys.map(k => optLabel(stageOptions, k))) : null],
      ['バージョン', gameVers.length ? joinValues(gameVers.map(formatGameVer)) : null],
      ['ウデマエ',   posterRanks.length ? joinValues(posterRanks.map(r => r.toUpperCase())) : null],
      ['Xパワー',    (powerMin || powerMax) ? `${powerMin || '—'}〜${powerMax || '—'}` : null],
    ])
  }, [period, range, lobbyKeys, ruleKeys, weaponKeys, stageKeys,
      weaponOptions, stageOptions, gameVers, posterRanks, powerMin, powerMax])

  // 拡充フィルタ（#189 / #477）を invoke 引数へ。空配列 / 空文字は null（無指定）に正規化。
  const extFilters = useMemo(() => ({
    weaponKeys:  weaponKeys.length ? weaponKeys : null,
    stageKeys:   stageKeys.length ? stageKeys : null,
    gameVers:    gameVers.length ? gameVers : null,
    posterRanks: posterRanks.length ? posterRanks : null,
    powerMin:    powerMin === '' ? null : Number(powerMin),
    powerMax:    powerMax === '' ? null : Number(powerMax),
  }), [weaponKeys, stageKeys, gameVers, posterRanks, powerMin, powerMax])

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
          since:    range.since,
          until:    range.until,
          ...extFilters,
        })
        setScatterData(rows)
        setScatterAxis(groupBy)   // 行と軸は必ずセットで更新する（#412）
      } else {
        if (bothWeaponSlot) { setMatrixData([]); setRowMarginals([]); setColMarginals([]); return }
        // 次元を変えた直後、セル指標が新しい次元にまだ整合していない一瞬は取得しない
        // （直後に走る useEffect が cellMetric を有効値へ補正し、再取得される）。
        if (!allowedCellMetrics.some(m => m.key === cellMetric)) return
        const res = await invoke<EnvMatrixStats>('env_matrix_stats', {
          rowDim, colDim, cellMetric,
          lobbyKeys,
          ruleKeys,
          since:    range.since,
          until:    range.until,
          ...extFilters,
        })
        setMatrixData(res.cells)
        setRowMarginals(res.row_marginals)
        setColMarginals(res.col_marginals)
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [hasData, vizMode, groupBy, lobbyKeys, ruleKeys, range, rowDim, colDim, cellMetric, bothWeaponSlot, allowedCellMetrics, extFilters])

  useEffect(() => { loadStatus() }, [loadStatus])
  useEffect(() => { loadData() }, [loadData])

  // ------------------------------------------------------------------
  // 散布図ツールチップのアイコン画像（#412）
  // ------------------------------------------------------------------
  //
  // 他画面（BattleLog / Dashboard / FilterBar）と同じく **まとめて事前ロード** して
  // Map に持つ。ツールチップ側は同期的に引くだけで、ホバーのたびに invoke は飛ばさない。
  //
  // キーは `${kind}:${正式名}`。武器とステージで同名が衝突しないよう kind を前置する。
  // 取りに行った名前は `iconTried` に積み、画像が無かったものを毎回引き直さない
  // （stat.ink 由来でローカルマスターに無い武器は永久に見つからないため）。
  const [iconUrls, setIconUrls] = useState<Map<string, string>>(new Map())
  const iconTried = useRef<Set<string>>(new Set())
  const iconKind = scatterAxis === 'weapon' ? 'weapon' : 'stage'

  useEffect(() => {
    if (vizMode !== 'scatter') return
    const targets: [string, string][] = []
    const seen = new Set<string>()
    for (const s of scatterData) {
      const name = s.icon_name
      if (!name || seen.has(name)) continue
      seen.add(name)
      const ck = `${iconKind}:${name}`
      if (iconTried.current.has(ck)) continue
      iconTried.current.add(ck)   // 解決前に積む（再レンダーで二重に invoke しない）
      targets.push([ck, name])
    }
    if (targets.length === 0) return
    Promise.all(targets.map(([ck, name]) =>
      invoke<string | null>('read_image', { kind: iconKind, name })
        .then(url => (url ? [ck, url] as [string, string] : null))
        .catch(() => null)
    )).then(res => {
      const hits = res.filter((x): x is [string, string] => x !== null)
      if (hits.length === 0) return
      // 累積マージのみ。取り違えないようキーに kind を含めてあるので、
      // 軸を切り替えても古い結果が混ざらない（unmount 後の set も無害）。
      setIconUrls(prev => {
        const next = new Map(prev)
        for (const [k, u] of hits) next.set(k, u)
        return next
      })
    })
  }, [scatterData, iconKind, vizMode])

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

  // 全期間の再取得。既存 env_battles を削除して stat.ink から取り込み直す。
  // #336 で per-player 列（kill/assist/death/inked）の取り込み位置を修正し、
  // #501 で投稿者以外 6 人分のキル系も取り込むようにしたため、
  // それ以前に取り込んだデータを最新の集計に揃えるには全期間の再取得が必要になる。
  async function handleRefetchFull() {
    if (importing) return
    const ok = window.confirm(
      '全期間データを削除して stat.ink から取り込み直します（約 944 MiB・10〜15 分）。\n\n' +
      'このバージョンから、キル・デス・アシスト・塗りポイントを投稿者を除く 7 人分すべて取り込みます。' +
      'それ以前に取得したデータは 1 人分しか記録が無く、キル系の母数が不足します。実行しますか？'
    )
    if (!ok) return
    await handleDownloadFull()
  }

  // 散布図ポイント生成
  const stageWeaponReady = groupBy === 'stage' && weaponKeys.length > 0
  const metrics = useMemo(() => {
    if (groupBy === 'weapon') return WEAPON_METRICS
    // 武器未選択時は勝率・KDA を選択肢から外す（#478）
    if (!stageWeaponReady) return STAGE_METRICS.filter(m => !STAGE_WEAPON_ONLY.has(m.key))
    return STAGE_METRICS
  }, [groupBy, stageWeaponReady])
  const xM = metrics.find(m => m.key === xKey) ?? metrics[0]
  const yM = metrics.find(m => m.key === yKey) ?? metrics[1]
  // ログスケールの可否（#473）。設定が残っていても不可の指標では効かせない。
  const xLogOk = !NO_LOG_METRICS.has(xM.key)
  const yLogOk = !NO_LOG_METRICS.has(yM.key)
  // サイズ・色 指標（#406）。見つからなければ「なし」。カテゴリ色（#480）は metrics 外。
  const sizeM  = metrics.find(m => m.key === sizeKey)
  const colorM = isScatterCategoryColorKey(colorKey) ? undefined : metrics.find(m => m.key === colorKey)
  const isCatColor = groupBy === 'weapon' && isScatterCategoryColorKey(colorKey)
  // KDA 系の注記は X/Y に加えサイズ・色の指標も対象にする（#406）。
  const usesKda = (xM.kda || yM.kda || sizeM?.kda || colorM?.kda) ?? false

  // 色指標が sequential のときの正規化レンジ（勝率＝divergent は min/max 不要）。
  // カスタムグラフ CustomChartCard.colorOfValue と揃える（#406）。
  const colorRange = useMemo(() => {
    if (!colorM || colorM.key === 'win_rate') return null
    let mn = Infinity, mx = -Infinity
    for (const s of scatterData) {
      const v = colorM.get(s)
      if (v == null) continue
      if (v < mn) mn = v
      if (v > mx) mx = v
    }
    return isFinite(mn) ? { min: mn, max: mx } : null
  }, [scatterData, colorM])

  // 色指標の値 → セル色。勝率は divergent（rateCellColor）、それ以外は sequential 濃淡。
  // heatmapColors の共通スケールを流用（CustomChartCard と同じ）。
  const pointColor = useCallback((v: number | null): string => {
    if (!colorM || v == null) return 'var(--accent)'
    if (colorM.key === 'win_rate') return rateCellColor(v)
    if (!colorRange || colorRange.max <= colorRange.min) return sequentialCellColor(0.5, colorM.key as MetricKey)
    return sequentialCellColor((v - colorRange.min) / (colorRange.max - colorRange.min), colorM.key as MetricKey)
  }, [colorM, colorRange])

  // カテゴリ色は出現中セットに対して色相をばらけさせて割り当てる。
  const presentCategories = useMemo(
    () => isCatColor ? scatterData.map(s => categoryValueForEnvStat(s, colorKey)) : [],
    [isCatColor, scatterData, colorKey],
  )

  const points: ScatterPoint[] = useMemo(() => scatterData.map(s => {
    const x = xM.get(s)
    const y = yM.get(s)
    const sv = sizeM ? sizeM.get(s) : null
    const cv = colorM ? colorM.get(s) : null
    const catVal = isCatColor ? categoryValueForEnvStat(s, colorKey) : null
    const catStyle = isCatColor && catVal ? categoryStyleOf(catVal, presentCategories) : null
    const metricRows = dedupeMetricRows([
      { key: xM.key,    row: { label: xM.label, value: x == null ? '—' : xM.fmt(x) } },
      { key: yM.key,    row: { label: yM.label, value: y == null ? '—' : yM.fmt(y) } },
      ...(sizeM  ? [{ key: sizeM.key,  row: { label: sizeM.label,  value: sv == null ? '—' : sizeM.fmt(sv),  muted: true } }] : []),
      ...(colorM ? [{ key: colorM.key, row: { label: colorM.label, value: cv == null ? '—' : colorM.fmt(cv), muted: true } }] : []),
      ...(isCatColor ? [{ key: colorKey, row: { label: GROUP_BY_LABELS[colorKey as GroupByKey], value: catVal!, muted: true } }] : []),
    ])
    return {
      name: s.key,
      x, y,
      size: sv,
      color: catStyle ? catStyle.color : pointColor(cv),
      markerShape: catStyle?.shape,
      // アイコンは **表示名ではなく BE が返した正式名（icon_name）** で引く（#412）。
      // 表示名（= key）はローカルマスターに無い武器だとスラッグのままで、当たらないパスを
      // 取りに行ってしまう。未ロード / 画像なしは undefined でアイコンなしになる。
      iconUrl: s.icon_name ? iconUrls.get(`${iconKind}:${s.icon_name}`) ?? null : null,
      // 見出しにアイコン + 名前が出るので、武器/ステージ行は重複になる (#433)
      tooltipRows: [
        ...metricRows,
        { label: 'サンプル', value: s.n.toLocaleString() },
      ],
    }
  }).filter(p => p.x !== null && p.y !== null), [scatterData, xM, yM, sizeM, colorM, isCatColor, colorKey, pointColor, iconUrls, iconKind, presentCategories])

  // サイズ・色の凡例（#420）。
  // サイズは **描画された点** の値から作る（Recharts の ZAxis も描画データから
  // ドメインを取るので、X/Y が欠けて落ちた点を混ぜるとレンジがズレる）。
  const sizeLegend = useMemo(
    () => (sizeM ? buildSizeLegend(sizeM.label, points.map(p => p.size), sizeM.fmt) : null),
    [sizeM, points],
  )
  // 色は **colorRange と同じ scatterData** から作り、色も本体と同じ pointColor で引く。
  // 別のレンジ・別の関数で作ると凡例が本体とズレる。
  const colorLegend = useMemo(() => {
    if (isCatColor) {
      return buildCategoryColorLegend(
        GROUP_BY_LABELS[colorKey as GroupByKey],
        scatterData.map(s => categoryValueForEnvStat(s, colorKey)),
      )
    }
    return colorM
      ? buildColorLegend(colorM.label, scatterData.map(s => colorM.get(s)), colorM.fmt, pointColor)
      : null
  }, [isCatColor, colorKey, colorM, scatterData, pointColor])

  const xDomain = useMemo(() => computeDomain(points.map(p => p.x as number), xM.rate01), [points, xM])
  const yDomain = useMemo(() => computeDomain(points.map(p => p.y as number), yM.rate01), [points, yM])

  const cm = CELL_METRICS.find(m => m.key === cellMetric) ?? CELL_METRICS[0]

  // 軸ラベル色付け用の射影値（#405 / #411）。
  //
  // 返ってきたセルから計算してはいけない: env_matrix_stats はサンプル不足のセルを
  // 落として返すため、クライアントには全データが無い。落ち方は交差する軸で変わるので、
  // セルから加重平均すると「ガチエリアの勝率が 武器×ルール と ステージ×ルール で違う」
  // ことになる（#411）。BE がセルの足切りとは無関係に全バトルから算出した
  // 周辺集計（marginals）をそのまま使う。
  const rowProj = useMemo(() => marginalProjection(rowMarginals), [rowMarginals])
  const colProj = useMemo(() => marginalProjection(colMarginals), [colMarginals])

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
            <button className="btn-secondary" onClick={handleRefetchFull} disabled={importing}
                    title="全期間データを削除して stat.ink から取り込み直します（約 944 MiB・10〜15 分）">
              全期間再取得
            </button>
            {error && <span className="env-error">{error}</span>}
          </div>

          {!status.full_kda && (
            <p className="env-filter-note">
              ※ 取り込み済みのデータは、キル・デス・アシスト・塗りポイントを 1 人分しか持っていません
              （v0.9.7 から 7 人分を取り込みます）。「全期間再取得」でキル系の母数が 7 倍になります。
              勝率・ピック率は再取得しなくても 7 人分で集計されます。
            </p>
          )}

          {progress && <ProgressDisplay progress={progress} />}

          {/* モード切替 */}
          <div className="env-mode-tabs">
            <button className={vizMode === 'scatter' ? 'env-mode-tab is-active' : 'env-mode-tab'}
                    onClick={() => setVizMode('scatter')}>散布図</button>
            <button className={vizMode === 'heatmap' ? 'env-mode-tab is-active' : 'env-mode-tab'}
                    onClick={() => setVizMode('heatmap')}>ヒートマップ</button>
          </div>

          {/* 共通フィルタ（並びは FilterBar＝期間→ロビー→ルール→武器→ステージ に合わせる） */}
          <div className="env-filters">
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
            <MultiSelect
              label="武器"
              allLabel="すべての武器"
              selected={weaponKeys}
              onChange={setWeaponKeys}
              options={weaponOptions.map(w => ({
                key:   w.key,
                label: `${w.label}（${w.n.toLocaleString()}）`,
                short: w.label,
              }))}
            />
            <MultiSelect
              label="ステージ"
              allLabel="すべてのステージ"
              selected={stageKeys}
              onChange={setStageKeys}
              options={stageOptions.map(s => ({
                key:   s.key,
                label: `${shortStage(s.label)}（${s.n.toLocaleString()}）`,
                short: shortStage(s.label),
              }))}
            />
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
            <button
              type="button"
              className="env-filter-clear"
              onClick={clearFilters}
              disabled={filtersAreDefault}
              title={filtersAreDefault ? 'すでに初期状態です' : '共通フィルタをすべて初期状態に戻す'}
            >✕ クリア</button>
          </div>

          {(posterRanks.length > 0 || powerMin !== '' || powerMax !== '') && (
            <p className="env-filter-note">
              ※ ウデマエ帯・Xパワーは投稿者のみの記録に基づく絞り込みです。
              残る 7 名（味方 3 人・相手 4 人）の帯は含まれないため、参加者全員がこの帯であることは保証されません。
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
                <LogToggle
                  label="X軸ログ" checked={xLog} allowed={xLogOk}
                  metricLabel={xM.label} onChange={setXLog}
                />
                <label>Y軸
                  <select value={yKey} onChange={e => setYKey(e.target.value)}>
                    {metrics.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
                  </select>
                </label>
                <LogToggle
                  label="Y軸ログ" checked={yLog} allowed={yLogOk}
                  metricLabel={yM.label} onChange={setYLog}
                />
                <label>サイズ
                  <select value={sizeKey} onChange={e => setSizeKey(e.target.value)}>
                    <option value="">なし</option>
                    {metrics.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
                  </select>
                </label>
                <label>色・形
                  <select value={colorKey} onChange={e => setColorKey(e.target.value)}>
                    <option value="">なし</option>
                    {metrics.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
                    {groupBy === 'weapon' && SCATTER_CATEGORY_COLOR_KEYS.map(k => (
                      <option key={k} value={k}>{GROUP_BY_LABELS[k]}</option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="env-chart-section" ref={scatterPanelRef}>
                <PanelExportLogo />
                <div className="env-chart-title-row">
                  <h3 className="env-chart-title">{xM.label} vs {yM.label}（{groupBy === 'weapon' ? '武器別' : 'ステージ別'}）</h3>
                  <PanelExportButton
                    targetRef={scatterPanelRef}
                    screen="環境分析"
                    panel={`${groupBy === 'weapon' ? '武器' : 'ステージ'}散布図 ${xM.label}×${yM.label}`}
                  />
                </div>
                <PanelExportCaption conditions={envExportCaption(envFilterSummary)} />
                {points.length === 0 ? (
                  <p className="env-no-data">条件に一致するデータがありません（50 サンプル未満は非表示）</p>
                ) : (
                  <ScatterChart
                    points={points}
                    xLabel={xM.label} yLabel={yM.label}
                    xIsRate={xM.rate01} yIsRate={yM.rate01}
                    xLogScale={xLog && xLogOk} yLogScale={yLog && yLogOk}
                    xDomain={xDomain} yDomain={yDomain}
                    xRefLine={xM.key === 'win_rate' ? 0.5 : undefined}
                    yRefLine={yM.key === 'win_rate' ? 0.5 : undefined}
                    hasSize={!!sizeM}
                    sizeLegend={sizeLegend}
                    colorLegend={colorLegend}
                    constSize={300}
                    fillOpacity={0.55}
                    height={440}
                  />
                )}
                <p className={`env-chart-note ${EXPORT_HIDE_CLASS}`}>
                  50 サンプル未満は非表示。各点にマウスオーバーで詳細表示。
                  {groupBy === 'stage' && weaponKeys.length === 0 &&
                    ' ※勝率・キル系は武器を絞り込むと選べます。'}
                  {' '}{POSTER_EXCLUDED_NOTE}
                  {usesKda && !status.full_kda && ' キル系は再取得前のデータでは 1 人分のみが母数です。'}
                </p>
                <PanelExportNote note={SCATTER_EXPORT_NOTE} />
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

              <div className="env-chart-section" ref={heatmapPanelRef}>
                <PanelExportLogo />
                <div className="env-chart-title-row">
                  <h3 className="env-chart-title">{dimLabel(rowDim)} × {dimLabel(colDim)}（{cm.label}）</h3>
                  {heatmapSortCol && (
                    <button
                      type="button"
                      className={`env-heatmap-sort-reset ${EXPORT_HIDE_CLASS}`}
                      onClick={clearHeatmapSort}
                      title="列クリックによる並べ替えを解除し、サンプル数順などの既定並びに戻す"
                    >既定の並び</button>
                  )}
                  <PanelExportButton
                    targetRef={heatmapPanelRef}
                    screen="環境分析"
                    panel={`ヒートマップ ${dimLabel(rowDim)}×${dimLabel(colDim)} ${cm.label}`}
                  />
                </div>
                <PanelExportCaption conditions={envExportCaption(envFilterSummary)} />
                {bothWeaponSlot ? (
                  <p className="env-no-data">武器 × 武器は非対応です。一方をステージ/ルール/ロビーにしてください。</p>
                ) : (
                  <Heatmap
                    cells={matrixData}
                    valueLabel={cm.fmt}
                    scale={cm.scale}
                    mid={cm.mid ?? 0.5}
                    sequentialHue={cm.hue ?? 210}
                    rowAxis={dimLabel(rowDim)}
                    colAxis={dimLabel(colDim)}
                    rowLabel={dimKeyLabeller(rowDim)}
                    colLabel={dimKeyLabeller(colDim)}
                    diagonalCols={colDim === 'stage'}
                    rowOrder={rowDim === 'rule' ? RULE_HEATMAP_ORDER : undefined}
                    colOrder={colDim === 'rule' ? RULE_HEATMAP_ORDER : undefined}
                    sortColKey={heatmapSortCol}
                    sortDir={heatmapSortDir}
                    onColHeaderClick={handleHeatmapColHeaderClick}
                    rowValue={rowProj}
                    colValue={colProj}
                    // バトル数は合計なので、セルの min/max ではなく軸内の相対で色付けする（#411）。
                    axisRelative={cellMetric === 'battles'}
                  />
                )}
                <p className={`env-chart-note ${EXPORT_HIDE_CLASS}`}>
                  {KDA_CELL_KEYS.includes(cellMetric) ? '20' : '30'} サンプル未満のセルは非表示。セルにマウスオーバーで件数を表示。
                  列見出しをクリックすると、その列の値で行を並べ替えられます（再クリックで昇順/降順切替）。
                  {cellMetric === 'win_rate' && ' 勝率は 50% を中心に赤(低)〜青(高)。'}
                  {cellMetric === 'avg_death' && ' デスは多いほど濃い赤（少ないほど良い）。'}
                  {(cellMetric === 'kill_ratio' || cellMetric === 'contrib_ratio') && ' 1.0 を中心に赤(低)〜青(高)。'}
                  {cm.weapon && ` ${POSTER_EXCLUDED_NOTE}`}
                  {KDA_CELL_KEYS.includes(cellMetric) && !status.full_kda &&
                    ' キル系は再取得前のデータでは 1 人分のみが母数です。'}
                  {cellMetric === 'battles'
                    ? ' 行・列の見出し色は、その軸の合計バトル数（軸内で最大を最も濃く）です。'
                    : ' 行・列の見出し色は、その軸の全バトルから算出した値です（非表示のセルも含むので、交差する軸を変えても同じ値になります）。'}
                </p>
                <PanelExportNote note={heatmapExportNote(KDA_CELL_KEYS.includes(cellMetric))} />
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

/**
 * 散布図の軸ログスケール切替（#473）。
 *
 * ピック率のようにロングテールな指標は、リニアだとマイナー武器が原点付近に潰れる。
 * `allowed` が false（勝率など）のときは押せなくし、理由を title で出す。
 */
function LogToggle({ label, checked, allowed, metricLabel, onChange }: {
  label:       string
  checked:     boolean
  allowed:     boolean
  metricLabel: string
  onChange:    (v: boolean) => void
}) {
  return (
    <label
      className={`env-log-toggle${allowed ? '' : ' is-disabled'}`}
      title={allowed
        ? `${metricLabel}を対数軸にする。0 以下の点は描けないため除外されます。`
        : `${metricLabel}は狭い範囲に収まるためログスケールは使えません。`}
    >
      <input
        type="checkbox"
        checked={checked && allowed}
        disabled={!allowed}
        onChange={e => onChange(e.target.checked)}
      />
      {label}
    </label>
  )
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
