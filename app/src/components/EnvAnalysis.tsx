/**
 * 環境分析タブ(#184 / 拡張 #187)。
 *
 * stat.ink の公開バトルデータを取り込み、
 * 散布図(ブキ/ステージ別)とマトリクスヒートマップ(カテゴリ×カテゴリ)で
 * 「ステージやブキによってバトル統計がどう変わるか」を見る。
 *
 * 散布図はピック率のようなロングテール指標を読むため、X/Y 軸ごとにログスケールへ
 * 切り替えられる(#473)。ピック率の表示は 2 桁固定(マイナーブキが 0.0% に潰れるため)。
 *
 * 注意: stat.ink ユーザーは一般プレイヤーより熱心な層に偏るため、
 *       データには投稿バイアスがあります。
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type {
  EnvScatterStat, EnvMatrixCell, EnvMatrixMarginal, EnvMatrixStats,
  EnvStatus, EnvVersion, EnvRank, EnvFilterOption, MetricKey, GroupByKey, Season,
  WeaponRecord,
} from '../types'
import { currentSeasonStart, SCATTER_IMAGE_PX } from '../types'
import type { ScatterImageSize } from '../types'
import { ScatterChart, buildSizeLegend, buildColorLegend, metricRefLine } from './charts/ScatterChart'
import type { ScatterPoint } from './charts/ScatterChart'
import { Heatmap } from './charts/Heatmap'
import { MultiSelect } from './MultiSelect'
import { SeasonSelect } from './SeasonSelect'
import { rateCellColor, sequentialCellColor, AXIS_MIN_TOTAL_SAMPLES } from '../utils/heatmapColors'
import { loadEnvPrefs, saveEnvPrefs, DEFAULT_ENV_PREFS } from '../utils/envPrefs'
import { loadEnvImportPrefs, resolveImportSince } from './EnvImportSince'
import {
  SCATTER_CATEGORY_COLOR_KEYS, isScatterCategoryColorKey, categoryStyleOf,
  buildCategoryColorLegend, categoryValueForEnvStat, kitIconsForWeapon,
  type WeaponMeta,
} from '../utils/scatterCategoryColors'
import { loadSubSpImageMaps, loadWeaponImageMap, weaponAxisTip } from '../utils/weaponKitImages'
import { PanelExportButton, PanelExportCaption, PanelExportLogo, PanelExportNote } from './PanelExport'
import { EXPORT_HIDE_CLASS } from '../utils/panelExport'
import {
  joinValues, formatAbsolutePeriodRange,
} from '../utils/filterSummary'
import { formatInvokeError } from '../utils/notify'

function lobbyOptions(t: TFunction) {
  return [
    { key: '',                  label: t('filter.allLobbies') },
    { key: 'regular',           label: t('filter.lobby_regular') },
    { key: 'bankara_open',      label: t('filter.lobby_bankara_open') },
    { key: 'bankara_challenge', label: t('filter.lobby_bankara_challenge') },
    { key: 'xmatch',            label: t('filter.lobby_xmatch') },
    { key: 'splatfest_open',    label: t('filter.lobby_splatfest_open') },
    { key: 'splatfest_challenge', label: t('filter.lobby_splatfest_challenge') },
    { key: 'event',             label: t('filter.lobby_event') },
  ]
}

function ruleOptions(t: TFunction) {
  return [
    { key: '',         label: t('filter.allRules') },
    { key: 'nawabari', label: t('filter.rule_turf_war') },
    { key: 'area',     label: t('filter.rule_area') },
    { key: 'yagura',   label: t('filter.rule_yagura') },
    { key: 'hoko',     label: t('filter.rule_hoko') },
    { key: 'asari',    label: t('filter.rule_asari') },
  ]
}

function lobbyLabelMap(t: TFunction): Record<string, string> {
  return Object.fromEntries(lobbyOptions(t).filter(o => o.key).map(o => [o.key, o.label]))
}

function ruleLabelMap(t: TFunction): Record<string, string> {
  return Object.fromEntries(ruleOptions(t).filter(o => o.key).map(o => [o.key, o.label]))
}

// ---------------------------------------------------------------------------
// 指標メタデータ
// ---------------------------------------------------------------------------

const pct    = (v: number) => `${(v * 100).toFixed(1)}%`
// ピック率専用(#473)。マイナーブキは 0.1% 未満に集まっていて 1 桁だと全部 0.0% になり
// 差が読めないため、2 桁にする。
const pct2   = (v: number) => `${(v * 100).toFixed(2)}%`
const pct100 = (v: number) => `${v.toFixed(1)}%`
const num2   = (v: number) => v.toFixed(2)
const num1   = (v: number) => v.toFixed(1)
const pint   = (v: number) => Math.round(v).toLocaleString()

interface ScatterMetric {
  key:    string               // select/state 用の一意キー
  label:  string
  rate01: boolean              // 値が [0,1] のレート(% 表示)か
  fmt:    (v: number) => string
  get:    (s: EnvScatterStat) => number | null
  kda?:   boolean              // KDA 系(記録のあるプレイヤーだけが母数・注記対象)
}

type ScatterMetricDef = Omit<ScatterMetric, 'label'> & { metricKey: string }

/** ログスケールを許さない指標(#473)。勝率は 0.5 前後の狭い帯に収まるので、
 *  ログにしても読みやすくならず、参照線 50% との相性も悪い。 */
const NO_LOG_METRICS = new Set(['win_rate'])

/** EnvScatterStat の数値フィールドをそのまま取り出すアクセサ。 */
const field = (k: keyof EnvScatterStat) => (s: EnvScatterStat) => s[k] as number | null

const WEAPON_METRIC_DEFS: ScatterMetricDef[] = [
  { key: 'pick_rate',  metricKey: 'pick_rate',  rate01: true,  fmt: pct2, get: field('pick_rate') },
  { key: 'win_rate',   metricKey: 'win_rate',   rate01: true,  fmt: pct,  get: field('win_rate') },
  { key: 'avg_kill',   metricKey: 'avg_kill',   rate01: false, fmt: num2, get: field('avg_kill'),   kda: true },
  { key: 'avg_assist', metricKey: 'avg_assist', rate01: false, fmt: num2, get: field('avg_assist'), kda: true },
  { key: 'contrib_kill', metricKey: 'contrib_kill', rate01: false, fmt: num2, kda: true,
    get: (s) => (s.avg_kill != null && s.avg_assist != null) ? s.avg_kill + s.avg_assist : null },
  { key: 'avg_death',  metricKey: 'avg_death',  rate01: false, fmt: num2, get: field('avg_death'),  kda: true },
  { key: 'kill_ratio', metricKey: 'kill_ratio', rate01: false, fmt: num2, kda: true,
    get: (s) => (s.avg_kill != null && s.avg_death != null && s.avg_death > 0) ? s.avg_kill / s.avg_death : null },
  { key: 'contrib_ratio', metricKey: 'contrib_ratio', rate01: false, fmt: num2, kda: true,
    get: (s) => (s.avg_kill != null && s.avg_assist != null && s.avg_death != null && s.avg_death > 0)
      ? (s.avg_kill + s.avg_assist) / s.avg_death : null },
  { key: 'avg_inked',  metricKey: 'avg_inked',  rate01: false, fmt: pint, get: field('avg_inked'),  kda: true },
]

const STAGE_METRIC_DEFS: ScatterMetricDef[] = [
  // 勝率・KDA はブキ絞り込み時だけ BE が埋める(#478)。未選択時は点が null で落ちる。
  { key: 'win_rate',   metricKey: 'win_rate',   rate01: true,  fmt: pct,  get: field('win_rate') },
  { key: 'avg_kill',   metricKey: 'avg_kill',   rate01: false, fmt: num2, get: field('avg_kill'),   kda: true },
  { key: 'avg_assist', metricKey: 'avg_assist', rate01: false, fmt: num2, get: field('avg_assist'), kda: true },
  { key: 'contrib_kill', metricKey: 'contrib_kill', rate01: false, fmt: num2, kda: true,
    get: (s) => (s.avg_kill != null && s.avg_assist != null) ? s.avg_kill + s.avg_assist : null },
  { key: 'avg_death',  metricKey: 'avg_death',  rate01: false, fmt: num2, get: field('avg_death'),  kda: true },
  { key: 'kill_ratio', metricKey: 'kill_ratio', rate01: false, fmt: num2, kda: true,
    get: (s) => (s.avg_kill != null && s.avg_death != null && s.avg_death > 0) ? s.avg_kill / s.avg_death : null },
  { key: 'contrib_ratio', metricKey: 'contrib_ratio', rate01: false, fmt: num2, kda: true,
    get: (s) => (s.avg_kill != null && s.avg_assist != null && s.avg_death != null && s.avg_death > 0)
      ? (s.avg_kill + s.avg_assist) / s.avg_death : null },
  { key: 'avg_count',    metricKey: 'avg_count',    rate01: false, fmt: num1,   get: field('avg_count') },
  { key: 'avg_ink_self', metricKey: 'avg_ink_self', rate01: false, fmt: pct100, get: field('avg_ink_self') },
  { key: 'avg_ink_opp',  metricKey: 'avg_ink_opp',  rate01: false, fmt: pct100, get: field('avg_ink_opp') },
]

function withScatterLabels(t: TFunction, defs: ScatterMetricDef[]): ScatterMetric[] {
  return defs.map(d => ({ ...d, label: t(`env.metric.${d.metricKey}`) }))
}

/** ステージ散布図でブキ未選択だと無意味な指標(#478)。 */
const STAGE_WEAPON_ONLY = new Set([
  'win_rate', 'avg_kill', 'avg_assist', 'contrib_kill', 'avg_death', 'kill_ratio', 'contrib_ratio',
])

// ヒートマップのセル指標
type CellMetricKey =
  | 'win_rate' | 'pick_rate' | 'battles'
  | 'avg_kill' | 'avg_assist' | 'contrib_kill' | 'avg_death' | 'kill_ratio' | 'contrib_ratio' | 'avg_inked'
// キル系(記録のあるプレイヤーだけが母数・専用しきい値)。注記・母数表示の切り替えに使う。
// 平均塗りP(avg_inked)も同じ母数なのでここに含める(#336 で元データの列マッピングを修正済み)。
const KDA_CELL_KEYS: CellMetricKey[] = [
  'avg_kill', 'avg_assist', 'contrib_kill', 'avg_death', 'kill_ratio', 'contrib_ratio', 'avg_inked',
]
interface CellMetric {
  key:    CellMetricKey
  label:  string
  fmt:    (v: number) => string
  scale:  'sequential' | 'diverging'
  weapon: boolean   // weapon 次元が必要か
  mid?:   number    // diverging の中心値(既定 0.5)
  hue?:   number    // sequential の色相(既定 210=青)。デスは 8=赤(高いほど悪い)
}

type CellMetricDef = Omit<CellMetric, 'label'> & { metricKey: string }

const CELL_METRIC_DEFS: CellMetricDef[] = [
  { key: 'win_rate',      metricKey: 'win_rate',      fmt: pct,  scale: 'diverging',  weapon: true, mid: 0.5 },
  { key: 'pick_rate',     metricKey: 'pick_rate',     fmt: pct2, scale: 'sequential', weapon: true },
  { key: 'avg_kill',      metricKey: 'avg_kill',      fmt: num2, scale: 'sequential', weapon: true },
  { key: 'avg_assist',    metricKey: 'avg_assist',    fmt: num2, scale: 'sequential', weapon: true },
  { key: 'contrib_kill',  metricKey: 'contrib_kill',  fmt: num2, scale: 'sequential', weapon: true },
  { key: 'avg_death',     metricKey: 'avg_death',     fmt: num2, scale: 'sequential', weapon: true, hue: 8 },
  { key: 'kill_ratio',    metricKey: 'kill_ratio',    fmt: num2, scale: 'diverging',  weapon: true, mid: 1.0 },
  { key: 'contrib_ratio', metricKey: 'contrib_ratio', fmt: num2, scale: 'diverging',  weapon: true, mid: 1.0 },
  { key: 'avg_inked',     metricKey: 'avg_inked',     fmt: pint, scale: 'sequential', weapon: true },
  { key: 'battles',       metricKey: 'battles',       fmt: pint, scale: 'sequential', weapon: false },
]

function withCellLabels(t: TFunction, defs: CellMetricDef[]): CellMetric[] {
  return defs.map(d => ({ ...d, label: t(`env.metric.${d.metricKey}`) }))
}
// ルールを次元にしたときの並び順(ガチ系を先・ナワバリを最後)。
const RULE_HEATMAP_ORDER = ['area', 'yagura', 'hoko', 'asari', 'nawabari']

/** スロット単位の集計が必要なヒートマップ次元(#481)。 */
const WEAPON_SLOT_DIMS = ['weapon', 'weapon_category', 'sub_weapon', 'special_weapon'] as const
const isWeaponSlotDim = (dim: string) =>
  (WEAPON_SLOT_DIMS as readonly string[]).includes(dim)

type DimOption = { key: string; label: string }

function dimOptions(t: TFunction): DimOption[] {
  return [
    { key: 'weapon',          label: t('env.groupBy.weapon') },
    { key: 'weapon_category', label: t('env.groupBy.weapon_category') },
    { key: 'sub_weapon',      label: t('env.groupBy.sub_weapon') },
    { key: 'special_weapon',  label: t('env.groupBy.special_weapon') },
    { key: 'stage',           label: t('env.groupBy.stage') },
    { key: 'rule',            label: t('env.groupBy.rule') },
    { key: 'lobby',           label: t('env.groupBy.lobby') },
  ]
}

function groupByLabel(t: TFunction, key: GroupByKey): string {
  const envKeys = ['weapon', 'weapon_category', 'sub_weapon', 'special_weapon', 'stage', 'rule', 'lobby'] as const
  if ((envKeys as readonly string[]).includes(key)) return t(`env.groupBy.${key}`)
  return key
}

/** 保存画像のキャプション。順序は **出典 → 絞り込み条件 → 該当バトル数**(#545 / #554)。 */
function joinEnvConditions(parts: [string, string | null][]): string {
  const kept = parts.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`)
  return kept.length ? kept.join(' / ') : ''
}

function envExportCaption(t: TFunction, conditions: string, filteredCount: number | null): string {
  return [
    t('env.sourceStatink'),
    conditions,
    filteredCount != null ? t('env.matchedBattles', { count: filteredCount.toLocaleString() }) : '',
  ].filter(Boolean).join(' / ')
}

// ステージ正式名 → 短縮名(コミュニティ通称)。未知のキーはそのまま返す。
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

function dimLabel(opts: DimOption[], dim: string): string {
  return opts.find(d => d.key === dim)?.label ?? dim
}

function dimKeyLabeller(t: TFunction, dim: string): (k: string) => string {
  const lobbies = lobbyLabelMap(t)
  const rules = ruleLabelMap(t)
  if (dim === 'rule')  return (k) => rules[k]  ?? k
  if (dim === 'lobby') return (k) => lobbies[k] ?? k
  if (dim === 'stage') return (k) => shortStage(k)
  return (k) => k
}

// ---------------------------------------------------------------------------
// 期間プリセット
// ---------------------------------------------------------------------------

/** `season` は特定のシーズンを名指しで選んだ状態（#585）。範囲は seasonName から引く。 */
type Period = 'all' | 'current_season' | 'season' | '1y' | '180d' | '30d' | 'custom'

const PERIOD_KEYS: Period[] = ['all', '1y', '180d', '30d', 'custom']

function periodLabelKey(id: Period): string {
  return id === 'all' ? 'filter.allPeriod' : `filter.${id}`
}

/** "YYYY-MM-DD" に日数を加算する(UTC 基準で tz ずれを避ける)。 */
function addDays(dateStr: string, delta: number): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + delta)
  return dt.toISOString().slice(0, 10)
}

/** ゲームバージョン表記の整形。stat.ink 由来の 3 桁コード("800")はドット区切り
 *  ("8.0.0")へ。既にドット区切りならそのまま返す。 */
function formatGameVer(v: string): string {
  return /^\d{3}$/.test(v) ? `${v[0]}.${v[1]}.${v[2]}` : v
}

interface ImportProgress { current: number; total: number; phase: string }

// ---------------------------------------------------------------------------
// 散布図ツールチップの行(#406)
// ---------------------------------------------------------------------------

type TooltipRow = { label: string; value: string; muted?: boolean }

/**
 * X / Y / サイズ / 色 は同じ指標を割り当てられるため(例: サイズと色を両方「勝率」)、
 * そのまま並べると同じ行が 2 度出る。指標キーで重複排除し、先に積んだ行を優先する
 * (= X/Y 側が残る)。#388(カスタムグラフ)の dedupe と同じ考え方。
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

/** BE の周辺集計 → 軸見出し用の射影値マップ(#411)。
 *  合計標本数が少ない軸は色を付けない(null＝既定色)。セル単位ではなく軸単位で足切りする。 */
function marginalProjection(ms: EnvMatrixMarginal[]): Map<string, number | null> {
  return new Map(ms.map(m => [m.key, m.n >= AXIS_MIN_TOTAL_SAMPLES ? m.value : null]))
}

export function EnvAnalysis() {
  const { t } = useTranslation()
  const cellMetrics = useMemo(() => withCellLabels(t, CELL_METRIC_DEFS), [t])
  const dims = useMemo(() => dimOptions(t), [t])
  const lobbies = useMemo(() => lobbyLabelMap(t), [t])
  const rules = useMemo(() => ruleLabelMap(t), [t])
  const posterExcludedText = t('env.posterExcluded')
  const posterExcludedNote = t('env.posterExcludedNote', { text: posterExcludedText })
  const scatterExportNote = `${t('env.hideUnder50')} / ${posterExcludedText}`
  const heatmapExportNote = useCallback((kda: boolean) =>
    `${t('env.hideUnderN', { n: kda ? 20 : 30 })} / ${posterExcludedText}`,
  [t, posterExcludedText])
  const scatterImageSizeLabels = useMemo((): Record<ScatterImageSize, string> => ({
    small:  t('env.imageSizeSmall'),
    medium: t('env.imageSizeMedium'),
    large:  t('env.imageSizeLarge'),
  }), [t])
  // 選択状態の永続化(#407)。mount 時に localStorage から一度だけ読む。
  const [prefs] = useState(loadEnvPrefs)
  const [status, setStatus]           = useState<EnvStatus | null>(null)
  const [importing, setImporting]     = useState(false)
  const [progress, setProgress]       = useState<ImportProgress | null>(null)
  const [error, setError]             = useState<string | null>(null)
  const [loading, setLoading]         = useState(false)   // 集計クエリ実行中
  // 連続フィルタ変更で古い結果が後から来るのを防ぐ(#511)
  const loadSeqRef = useRef(0)
  /** 共通フィルタに合うバトル件数(#529)。 */
  const [filteredCount, setFilteredCount] = useState<number | null>(null)
  const countSeqRef = useRef(0)

  // 共通フィルタ(#190: ロビー/ルールは複数選択)
  const [lobbyKeys, setLobbyKeys] = useState<string[]>(prefs.lobbyKeys)
  const [ruleKeys, setRuleKeys]   = useState<string[]>(prefs.ruleKeys)
  // 🔴 保存された period は**古いビルドでも読める値**しか入っていない（下の save を参照）。
  // シーズン指定は `seasonName` の有無で判別して復元する。
  // 知らない値が入っていたら既定に落とす（将来値を増やしたときに落ちないように）。
  const [period, setPeriod] = useState<Period>(() => {
    if (prefs.seasonName) return 'season'
    const known: Period[] = ['all', 'current_season', 'season', '1y', '180d', '30d', 'custom']
    return known.includes(prefs.period as Period)
      ? (prefs.period as Period)
      : (DEFAULT_ENV_PREFS.period as Period)
  })
  const [customSince, setCustomSince] = useState(prefs.customSince)
  const [customUntil, setCustomUntil] = useState(prefs.customUntil)
  /** 選べるシーズン（新しい順）。計算は Rust の `season.rs`（#585）。 */
  const [seasons, setSeasons] = useState<Season[]>([])
  /** 名指しで選んだシーズン名（`period === 'season'` のときだけ意味を持つ）。 */
  const [seasonName, setSeasonName] = useState<string | null>(prefs.seasonName ?? null)

  // フィルタ拡充(#189): バージョン / ウデマエ帯 / Xパワー帯
  // ブキ・ステージ(#477)
  const [versionOptions, setVersionOptions] = useState<EnvVersion[]>([])
  const [rankOptions, setRankOptions]       = useState<EnvRank[]>([])
  const [weaponOptions, setWeaponOptions]   = useState<EnvFilterOption[]>([])
  /**
   * 選択肢を取りに行っている最中か（#602）。
   *
   * ブキの選択肢は 554 万件を数えるので時間がかかる。空のまま「選択肢がありません」と
   * 出していたので、**まだ来ていない**のか**本当に無い**のか分からなかった。
   */
  const [optionsLoading, setOptionsLoading] = useState(false)
  const [stageOptions, setStageOptions]     = useState<EnvFilterOption[]>([])
  const [gameVers, setGameVers]       = useState<string[]>(prefs.gameVers)      // 選択中バージョン(複数)
  const [posterRanks, setPosterRanks] = useState<string[]>(prefs.posterRanks)   // 選択中ウデマエ帯(複数)
  const [weaponKeys, setWeaponKeys]   = useState<string[]>(prefs.weaponKeys)
  const [stageKeys, setStageKeys]     = useState<string[]>(prefs.stageKeys)
  const [powerMin, setPowerMin] = useState(prefs.powerMin)                       // Xパワー下限(空 = 無指定)
  const [powerMax, setPowerMax] = useState(prefs.powerMax)                       // Xパワー上限(空 = 無指定)

  /** 共通フィルタが既定(クリア済み)かどうか(#456)。 */
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

  /** 共通フィルタを未指定(初期状態)に戻す(#456)。永続化は既存の save 用 effect が拾う。 */
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
    setSeasonName(null)
    // 🔴 表示するブキ（#593）はここで消さない。これは共通フィルタではなく
    // グラフ設定（見せ方）で、軸や指標の選択と同じ扱いにする。
    // 解除はプルダウン内の「選択をクリア」から。
  }

  // 画像保存(#500)。共通フィルタはパネルの外にあるので、画像には条件を焼き込む。
  const scatterPanelRef = useRef<HTMLDivElement>(null)
  const heatmapPanelRef = useRef<HTMLDivElement>(null)

  // 可視化モード
  const [vizMode, setVizMode] = useState<'scatter' | 'heatmap'>(prefs.vizMode)

  // 散布図
  const [groupBy, setGroupBy] = useState<'weapon' | 'stage'>(prefs.groupBy)
  const [xKey, setXKey]       = useState<string>(prefs.xKey)
  const [yKey, setYKey]       = useState<string>(prefs.yKey)
  const [sizeKey, setSizeKey] = useState<string>(prefs.sizeKey)   // 散布図サイズ指標(''=なし・#406)
  const [colorKey, setColorKey] = useState<string>(prefs.colorKey) // 散布図色指標(''=なし・#406)
  const [xLog, setXLog]       = useState<boolean>(prefs.xLog)     // 散布図 X 軸ログスケール(#473)
  const [yLog, setYLog]       = useState<boolean>(prefs.yLog)
  // 点をブキ画像にする(#631)。ブキ軸のときだけ。ステージ画像は横長で正方形に収まらない。
  const [pointStyle, setPointStyle] = useState<string>(prefs.pointStyle)
  const [imageSize,  setImageSize]  = useState<string>(prefs.imageSize)
  // 🔴 画像モードではサイズ・色メトリクスが効かない。ダッシュボードと同じ約束(#627)。
  // 設定は消さずに無視するので、丸に戻せばそのまま復帰する。
  const imageMode = pointStyle === 'image' && groupBy === 'weapon'
  const imagePx   = imageMode
    ? SCATTER_IMAGE_PX[(imageSize as ScatterImageSize) in SCATTER_IMAGE_PX ? (imageSize as ScatterImageSize) : 'medium']
    : undefined
  /**
   * 表示するブキ（#593）。空なら全部出す。
   *
   * 🔴 **共通フィルタのブキとは意味が違う。** 上のフィルタは「そのブキがいるバトルに
   * 母集団を絞る」（#477）。こちらは**集計を一切動かさず、出す点・行だけを選ぶ**。
   * ピック率の分母も母数も変わらないので、選んだ数個の合計は 100% にならない。
   *
   * 画面の領域で意味を分けている: 上の共通フィルタ = どのバトルを集計するか /
   * パネル内のグラフ設定 = どう見せるか。
   */
  const [displayWeapons, setDisplayWeapons] = useState<string[]>(prefs.displayWeapons)
  const [scatterData, setScatterData] = useState<EnvScatterStat[]>([])
  // scatterData がどちらの集計軸のものか(#412)。groupBy は選択した瞬間に変わるが
  // scatterData は再取得が終わるまで前の軸のまま。アイコンの kind をこの遅れた軸で決めないと、
  // 切り替え直後に「ブキ名を kind:'stage' で読みに行く」空振りの invoke が飛ぶ。
  const [scatterAxis, setScatterAxis] = useState<'weapon' | 'stage'>(groupBy)

  /**
   * 表示するブキで絞ったあとの散布図データ（#593）。
   *
   * **取得も集計もそのまま。**ここで落とすのは描く点だけなので、
   * 軸の範囲・色の割り当ても「表示する点」に対して決まる（見えない点に引きずられない）。
   * `scatterAxis` を見るのは、切り替え直後に前の軸のデータが残っているため。
   */
  const shownScatter = useMemo(
    () =>
      displayWeapons.length === 0 || scatterAxis !== 'weapon'
        ? scatterData
        : scatterData.filter(s => displayWeapons.includes(s.key)),
    [scatterData, displayWeapons, scatterAxis],
  )

  // ヒートマップ
  const [rowDim, setRowDim]         = useState(prefs.rowDim)
  const [colDim, setColDim]         = useState(prefs.colDim)
  const [cellMetric, setCellMetric] = useState<CellMetricKey>(prefs.cellMetric as CellMetricKey)
  const [matrixData, setMatrixData] = useState<EnvMatrixCell[]>([])
  // 行・列の周辺集計(#411)。セルの足切りに影響されない値なので BE から受け取る。
  const [rowMarginals, setRowMarginals] = useState<EnvMatrixMarginal[]>([])
  const [colMarginals, setColMarginals] = useState<EnvMatrixMarginal[]>([])

  /**
   * 表示するブキで絞ったあとのヒートマップのセル（#593）。
   *
   * 行か列がブキのときだけ効く。**周辺集計（`rowMarginals` / `colMarginals`）は絞らない。**
   * あれは全バトルから出した値で、表示を減らしても母数は変わらないため。
   */
  const shownMatrix = useMemo(() => {
    if (displayWeapons.length === 0) return matrixData
    const keep = new Set(displayWeapons)
    return matrixData.filter(c =>
      (rowDim !== 'weapon' || keep.has(c.row_key)) &&
      (colDim !== 'weapon' || keep.has(c.col_key)),
    )
  }, [matrixData, displayWeapons, rowDim, colDim])
  // ヒートマップ列見出しクリックによる行ソート(#479)。永続化しない。
  const [heatmapSortCol, setHeatmapSortCol] = useState<string | null>(null)
  const [heatmapSortDir, setHeatmapSortDir] = useState<'asc' | 'desc'>('desc')

  const hasData = status !== null && status.total_rows > 0

  // 選択状態の永続化(#407)。変更のたびに localStorage(+ settings.json ミラー)へ保存する。
  // mount 直後の初回は復元値をそのまま書き戻すだけなのでスキップ(無駄なミラーを避ける)。
  const firstSaveRun = useRef(true)
  useEffect(() => {
    if (firstSaveRun.current) { firstSaveRun.current = false; return }
    // 🔴 **古いビルドが知らない値を保存しない。**
    // `period: 'season'` を書いたら v0.9.10 が switch でどれにも当たらず、
    // range が undefined になって起動時に落ちた（設定は新旧のビルドで共有される）。
    // シーズン指定は「日付範囲を指定したカスタム期間」として保存する。
    // 古いビルドはカスタム期間として正しく動き、新しいビルドは seasonName で復元する。
    // 範囲は保存のためにここで引き直す（`range` はこの下で定義されるので使えない）。
    const picked = period === 'season' ? seasons.find(s => s.name === seasonName) : undefined
    const isSeason = period === 'season' && !!picked
    saveEnvPrefs({
      vizMode, groupBy, xKey, yKey, sizeKey, colorKey, xLog, yLog,
      pointStyle, imageSize,
      rowDim, colDim, cellMetric,
      period:      isSeason ? 'custom' : period === 'season' ? 'current_season' : period,
      customSince: isSeason ? picked!.since : customSince,
      customUntil: isSeason ? picked!.until : customUntil,
      // シーズン以外を選んでいる間は消す（残すと次回シーズンとして復元してしまう）。
      seasonName:  isSeason ? (seasonName ?? '') : '',
      displayWeapons,
      lobbyKeys, ruleKeys, weaponKeys, stageKeys, gameVers, posterRanks, powerMin, powerMax,
    })
  }, [vizMode, groupBy, xKey, yKey, sizeKey, colorKey, xLog, yLog, pointStyle, imageSize,
      rowDim, colDim, cellMetric,
      period, customSince, customUntil, seasonName, seasons, displayWeapons,
      lobbyKeys, ruleKeys, weaponKeys, stageKeys, gameVers, posterRanks, powerMin, powerMax])

  // 集計軸を切り替えたら X/Y・サイズ・色 指標を既定へ戻す。
  // 「初回だけスキップ」の ref フラグは StrictMode の二重マウントで false のまま
  // 再マウントされ、復元済みの選択(特に sizeKey/colorKey)を潰す。値の比較で
  // 実際に groupBy が変わったときだけリセットする(マウント・StrictMode 再マウントは素通し・#407)。
  const prevGroupBy = useRef(groupBy)
  useEffect(() => {
    if (prevGroupBy.current === groupBy) return   // マウント / 変化なし
    prevGroupBy.current = groupBy
    if (groupBy === 'weapon') { setXKey('pick_rate'); setYKey('win_rate') }
    else                      { setXKey('avg_ink_self'); setYKey('avg_count') }
    setSizeKey(''); setColorKey('')   // 指標セットが変わるのでサイズ/色はリセット(#406)
  }, [groupBy])

  // ステージ軸でブキフィルタが空のとき、勝率・KDA が選ばれていたらステージ固有指標へ戻す(#478)。
  // ブキを選んだ直後は勝率 vs キルレを既定にする。
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
  const hasWeaponFilter    = weaponKeys.length > 0
  // ブキ系軸あり → 勝率/ピック率/KDA。非ブキ×非ブキはバトル数。
  // ただしブキフィルタありなら散布図(#478)と同様に勝率・KDA も出す（ピック率はブキ軸必須・#520）。
  // KO率はヒートマップから外した(#522)。
  const allowedCellMetrics = useMemo(() => {
    if (bothWeaponSlot) return []
    if (weaponSlotInvolved) return cellMetrics.filter(m => m.weapon)
    if (hasWeaponFilter) return cellMetrics.filter(m => m.key !== 'pick_rate')
    return cellMetrics.filter(m => !m.weapon)
  }, [weaponSlotInvolved, bothWeaponSlot, hasWeaponFilter, cellMetrics])
  useEffect(() => {
    if (allowedCellMetrics.length > 0 && !allowedCellMetrics.some(m => m.key === cellMetric)) {
      setCellMetric(allowedCellMetrics[0].key)
    }
  }, [allowedCellMetrics, cellMetric])

  // ヒートマップの軸・指標を変えたら列ソートを既定に戻す(#479)。
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
        // 🔴 シーズンを最初に取る（#585）。以降の選択肢は 550 万行を集計するので秒単位かかり、
        // 直列に await していると**シーズンのプルダウンだけ最後まで出てこない**。
        // こちらは MIN/MAX を引くだけなので一瞬で返る。
        // 失敗すると選択肢が空になってプルダウンが黙って消えるため、握り潰さずログに出す。
        try {
          setSeasons(await invoke<Season[]>('list_seasons', { source: 'env' }))
        } catch (e) {
          console.error('[EnvAnalysis] list_seasons 失敗:', e)
        }
        // 🔴 直列に await しない。どれも 550 万行の集計で数秒かかるため
        // （実測: バージョン 2.6 秒 / ウデマエ帯 3.9 秒）、順に待つと**後ろのものほど
        // 遅れて出てくる**。互いに依存しないので同時に投げ、取れたものから反映する。
        setOptionsLoading(true)
        void Promise.allSettled([
          invoke<EnvVersion[]>('env_versions').then(setVersionOptions),
          invoke<EnvRank[]>('env_ranks').then(setRankOptions),
          invoke<EnvFilterOption[]>('env_weapons').then(setWeaponOptions),
          invoke<EnvFilterOption[]>('env_stages').then(setStageOptions),
        ]).then(results => {
          setOptionsLoading(false)
          // 失敗しても選択肢が空になるだけで画面は動く。原因が追えるようログには出す。
          for (const r of results) {
            if (r.status === 'rejected') console.error('[EnvAnalysis] 選択肢の取得に失敗:', r.reason)
          }
        })
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
      // 暦上のシーズン開始日(3/6/9/12 月始まりの 3 ヶ月サイクル)を since にする。
      // until は他と揃えて max_date(それ以降のデータは存在しない)。
      case 'current_season':
        return { since: currentSeasonStart(), until: maxd }
      // 名指しのシーズン(#585)。範囲は Rust が出した一覧から引く。
      // until はデータの最終日で頭打ちにする（今シーズンの終端はまだ未来）。
      case 'season': {
        const s = seasons.find(x => x.name === seasonName)
        if (!s) return { since: null, until: null }
        return { since: s.since, until: maxd && maxd < s.until ? maxd : s.until }
      }
      case '1y':     return maxd ? { since: addDays(maxd, -364), until: maxd } : { since: null, until: null }
      case '180d':   return maxd ? { since: addDays(maxd, -179), until: maxd } : { since: null, until: null }
      case '30d':    return maxd ? { since: addDays(maxd, -29),  until: maxd } : { since: null, until: null }
      case 'custom': return { since: customSince || null, until: customUntil || null }
      // 🔴 網羅していない値でも undefined を返さない。
      // ここが undefined を返すと呼び出し側が range.since で落ちる（実際に起きた）。
      default:       return { since: null, until: null }
    }
  }, [period, status, customSince, customUntil, seasons, seasonName])

  // 画像に焼き込む条件(#500 / #506)。期間はクエリと同じ since/until を絶対日付で。
  const envFilterSummary = useMemo(() => {
    const optLabel = (opts: { key: string; label: string }[], k: string) =>
      opts.find(o => o.key === k)?.label ?? k
    // データ未取得で相対期間が解けないときだけ、UI と同じラベルにフォールバックする。
    const periodCaption = (() => {
      if (period === 'all') return t('filter.allPeriod')
      // シーズンは名前を出す(#585)。後から見ても一意に決まるので日付に開かなくてよい。
      if (period === 'season' && seasonName) {
        return `${seasonName} (${range.since || '-'}~${range.until || '-'})`
      }
      if (period === 'custom') {
        return `${range.since || '-'}~${range.until || '-'}`
      }
      if (range.since || range.until) {
        return formatAbsolutePeriodRange(range.since, range.until)
      }
      return t(periodLabelKey(period))
    })()
    const conditions = joinEnvConditions([
      [t('env.exportCaption.lobby'),     lobbyKeys.length ? joinValues(lobbyKeys.map(k => lobbies[k] ?? k)) : null],
      [t('env.exportCaption.period'),    periodCaption],
      [t('env.exportCaption.rule'),      ruleKeys.length ? joinValues(ruleKeys.map(k => rules[k] ?? k)) : null],
      [t('env.exportCaption.weapon'),    weaponKeys.length ? joinValues(weaponKeys.map(k => optLabel(weaponOptions, k))) : null],
      [t('env.exportCaption.stage'),     stageKeys.length ? joinValues(stageKeys.map(k => optLabel(stageOptions, k))) : null],
      [t('env.exportCaption.version'),   gameVers.length ? joinValues(gameVers.map(formatGameVer)) : null],
      [t('env.exportCaption.rank'),      posterRanks.length ? joinValues(posterRanks.map(r => r.toUpperCase())) : null],
      [t('env.exportCaption.xPower'),    (powerMin || powerMax) ? `${powerMin || '-'}~${powerMax || '-'}` : null],
      // 表示を絞ったなら画像にも書く(#593)。集計は全体のままだと分かるよう「表示」と付ける。
      [t('env.exportCaption.displayWeapon'), displayWeapons.length ? joinValues(displayWeapons.map(k => optLabel(weaponOptions, k))) : null],
    ])
    return conditions || t('env.noFilters')
  }, [period, seasonName, range, lobbyKeys, ruleKeys, weaponKeys, stageKeys,
      weaponOptions, stageOptions, gameVers, posterRanks, powerMin, powerMax, displayWeapons,
      t, lobbies, rules])

  // 拡充フィルタ(#189 / #477)を invoke 引数へ。空配列 / 空文字は null(無指定)に正規化。
  const extFilters = useMemo(() => ({
    weaponKeys:  weaponKeys.length ? weaponKeys : null,
    stageKeys:   stageKeys.length ? stageKeys : null,
    gameVers:    gameVers.length ? gameVers : null,
    posterRanks: posterRanks.length ? posterRanks : null,
    powerMin:    powerMin === '' ? null : Number(powerMin),
    powerMax:    powerMax === '' ? null : Number(powerMax),
  }), [weaponKeys, stageKeys, gameVers, posterRanks, powerMin, powerMax])

  // データ読み込み(モード/フィルタ変更で再取得)
  const loadData = useCallback(async () => {
    if (!hasData) return
    const seq = ++loadSeqRef.current
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
        if (seq !== loadSeqRef.current) return
        setScatterData(rows)
        setScatterAxis(groupBy)   // 行と軸は必ずセットで更新する(#412)
      } else {
        if (bothWeaponSlot) {
          if (seq !== loadSeqRef.current) return
          setMatrixData([]); setRowMarginals([]); setColMarginals([]); return
        }
        // 次元を変えた直後、セル指標が新しい次元にまだ整合していない一瞬は取得しない
        // (直後に走る useEffect が cellMetric を有効値へ補正し、再取得される)。
        if (!allowedCellMetrics.some(m => m.key === cellMetric)) return
        const res = await invoke<EnvMatrixStats>('env_matrix_stats', {
          rowDim, colDim, cellMetric,
          lobbyKeys,
          ruleKeys,
          since:    range.since,
          until:    range.until,
          ...extFilters,
        })
        if (seq !== loadSeqRef.current) return
        setMatrixData(res.cells)
        setRowMarginals(res.row_marginals)
        setColMarginals(res.col_marginals)
      }
    } catch (e) {
      if (seq !== loadSeqRef.current) return
      setError(formatInvokeError(e))
    } finally {
      // 最新リクエストだけ loading を落とす(古い完了で「最新です」にしない)
      if (seq === loadSeqRef.current) setLoading(false)
    }
  }, [hasData, vizMode, groupBy, lobbyKeys, ruleKeys, range, rowDim, colDim, cellMetric, bothWeaponSlot, allowedCellMetrics, extFilters])

  useEffect(() => { loadStatus() }, [loadStatus])
  useEffect(() => { loadData() }, [loadData])

  // 絞り込みに合うバトル件数(#529)。グラフ集計とは独立に取り、軸切替でも同じ条件で更新する。
  useEffect(() => {
    if (!hasData) { setFilteredCount(null); return }
    const seq = ++countSeqRef.current
    invoke<number>('env_filtered_count', {
      lobbyKeys,
      ruleKeys,
      since: range.since,
      until: range.until,
      ...extFilters,
    })
      .then(n => { if (seq === countSeqRef.current) setFilteredCount(n) })
      .catch(() => { if (seq === countSeqRef.current) setFilteredCount(null) })
  }, [hasData, lobbyKeys, ruleKeys, range, extFilters])

  // ------------------------------------------------------------------
  // 散布図ツールチップのアイコン画像(#412)
  // ------------------------------------------------------------------
  //
  // 他画面(BattleLog / Dashboard / FilterBar)と同じく **まとめて事前ロード** して
  // Map に持つ。ツールチップ側は同期的に引くだけで、ホバーのたびに invoke は飛ばさない。
  //
  // キーは `${kind}:${正式名}`。ブキとステージで同名が衝突しないよう kind を前置する。
  // 取りに行った名前は `iconTried` に積み、画像が無かったものを毎回引き直さない
  // (stat.ink 由来でローカルマスターに無いブキは永久に見つからないため)。
  const [iconUrls, setIconUrls] = useState<Map<string, string>>(new Map())
  const iconTried = useRef<Set<string>>(new Set())
  const iconKind = scatterAxis === 'weapon' ? 'weapon' : 'stage'
  const [weaponMeta, setWeaponMeta] = useState<Map<string, WeaponMeta>>(new Map())
  const [weaponImages, setWeaponImages] = useState<Map<string, string>>(new Map())
  const [subImages, setSubImages] = useState<Map<string, string>>(new Map())
  const [spImages, setSpImages] = useState<Map<string, string>>(new Map())
  const weaponJaByKey = useMemo(
    () => new Map(weaponOptions.map(w => [w.key, w.label])),
    [weaponOptions],
  )
  const heatmapWeaponTip = useCallback((key: string) => {
    const name = weaponJaByKey.get(key) ?? key
    const tip = weaponAxisTip(name, weaponMeta, weaponImages, subImages, spImages)
    if (!tip) return undefined
    if (!tip.iconUrl) {
      const byKey = weaponImages.get(key)
      if (byKey) return { ...tip, iconUrl: byKey }
    }
    return tip
  }, [weaponJaByKey, weaponMeta, weaponImages, subImages, spImages])

  useEffect(() => {
    invoke<WeaponRecord[]>('db_list_weapons').then(list => {
      setWeaponMeta(new Map(list.map(w => [w.name, {
        category: w.category,
        sub_weapon: w.sub_weapon,
        special_weapon: w.special_weapon,
      }])))
      loadSubSpImageMaps(list).then(({ subImages: sub, spImages: sp }) => {
        setSubImages(sub)
        setSpImages(sp)
      }).catch(console.error)
      loadWeaponImageMap(list.map(w => w.name)).then(setWeaponImages).catch(console.error)
    }).catch(console.error)
  }, [])

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
      iconTried.current.add(ck)   // 解決前に積む(再レンダーで二重に invoke しない)
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
      // 軸を切り替えても古い結果が混ざらない(unmount 後の set も無害)。
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
    const prefs = loadEnvImportPrefs()
    const since = resolveImportSince(prefs.kind, prefs.custom)
    if (prefs.kind === 'custom' && !since) {
      setError(t('env.pickStartDate'))
      return
    }
    setImporting(true); setError(null)
    setProgress({ current: 0, total: 1, phase: 'download' })
    try {
      await invoke<number>('import_env_full', { since })
      await loadStatus()
    } catch (e) { setError(formatInvokeError(e)) }
    finally { setImporting(false); setProgress(null) }
  }

  async function handleDelta() {
    if (importing) return
    setImporting(true); setError(null)
    setProgress({ current: 0, total: 1, phase: 'download' })
    try {
      await invoke<number>('import_env_delta')
      await loadStatus()
    } catch (e) { setError(formatInvokeError(e)) }
    finally { setImporting(false); setProgress(null) }
  }

  // 散布図ポイント生成
  const stageWeaponReady = groupBy === 'stage' && weaponKeys.length > 0
  const metrics = useMemo(() => {
    if (groupBy === 'weapon') return withScatterLabels(t, WEAPON_METRIC_DEFS)
    const stageDefs = stageWeaponReady
      ? STAGE_METRIC_DEFS
      : STAGE_METRIC_DEFS.filter(m => !STAGE_WEAPON_ONLY.has(m.key))
    return withScatterLabels(t, stageDefs)
  }, [groupBy, stageWeaponReady, t])
  const xM = metrics.find(m => m.key === xKey) ?? metrics[0]
  const yM = metrics.find(m => m.key === yKey) ?? metrics[1]
  // ログスケールの可否(#473)。設定が残っていても不可の指標では効かせない。
  const xLogOk = !NO_LOG_METRICS.has(xM.key)
  const yLogOk = !NO_LOG_METRICS.has(yM.key)
  // サイズ・色 指標(#406)。見つからなければ「なし」。カテゴリ色(#480)は metrics 外。
  //
  // 🔴 画像モードでは**ここで落とす**(#631)。点・凡例・ZAxis はすべてこの 3 つから
  // 派生するので、大元で無効にすれば「凡例だけ残る」ようなズレが起きない。
  const sizeM  = imageMode ? undefined : metrics.find(m => m.key === sizeKey)
  const colorM = imageMode || isScatterCategoryColorKey(colorKey)
    ? undefined
    : metrics.find(m => m.key === colorKey)
  const isCatColor = !imageMode && groupBy === 'weapon' && isScatterCategoryColorKey(colorKey)

  // 色指標が sequential のときの正規化レンジ(勝率＝divergent は min/max 不要)。
  // カスタムグラフ CustomChartCard.colorOfValue と揃える(#406)。
  const colorRange = useMemo(() => {
    if (!colorM || colorM.key === 'win_rate') return null
    let mn = Infinity, mx = -Infinity
    for (const s of shownScatter) {
      const v = colorM.get(s)
      if (v == null) continue
      if (v < mn) mn = v
      if (v > mx) mx = v
    }
    return isFinite(mn) ? { min: mn, max: mx } : null
  }, [shownScatter, colorM])

  // 色指標の値 → セル色。勝率は divergent(rateCellColor)、それ以外は sequential 濃淡。
  // heatmapColors の共通スケールを流用(CustomChartCard と同じ)。
  const pointColor = useCallback((v: number | null): string => {
    if (!colorM || v == null) return 'var(--accent)'
    if (colorM.key === 'win_rate') return rateCellColor(v)
    if (!colorRange || colorRange.max <= colorRange.min) return sequentialCellColor(0.5, colorM.key as MetricKey)
    return sequentialCellColor((v - colorRange.min) / (colorRange.max - colorRange.min), colorM.key as MetricKey)
  }, [colorM, colorRange])

  // カテゴリ色は出現中セットに対して色相をばらけさせて割り当てる。
  const presentCategories = useMemo(
    () => isCatColor ? shownScatter.map(s => categoryValueForEnvStat(s, colorKey)) : [],
    [isCatColor, shownScatter, colorKey],
  )

  const points: ScatterPoint[] = useMemo(() => shownScatter.map(s => {
    const x = xM.get(s)
    const y = yM.get(s)
    const sv = sizeM ? sizeM.get(s) : null
    const cv = colorM ? colorM.get(s) : null
    const catVal = isCatColor ? categoryValueForEnvStat(s, colorKey) : null
    const catStyle = isCatColor && catVal ? categoryStyleOf(catVal, presentCategories) : null
    const metricRows = dedupeMetricRows([
      { key: xM.key,    row: { label: xM.label, value: x == null ? '-' : xM.fmt(x) } },
      { key: yM.key,    row: { label: yM.label, value: y == null ? '-' : yM.fmt(y) } },
      ...(sizeM  ? [{ key: sizeM.key,  row: { label: sizeM.label,  value: sv == null ? '-' : sizeM.fmt(sv),  muted: true } }] : []),
      ...(colorM ? [{ key: colorM.key, row: { label: colorM.label, value: cv == null ? '-' : colorM.fmt(cv), muted: true } }] : []),
      ...(isCatColor ? [{ key: colorKey, row: { label: groupByLabel(t, colorKey as GroupByKey), value: catVal!, muted: true } }] : []),
    ])
    return {
      name: s.key,
      x, y,
      size: sv,
      color: catStyle ? catStyle.color : pointColor(cv),
      markerShape: catStyle?.shape,
      // アイコンは **表示名ではなく BE が返した正式名(icon_name)** で引く(#412)。
      // 表示名(= key)はローカルマスターに無いブキだとスラッグのままで、当たらないパスを
      // 取りに行ってしまう。未ロード / 画像なしは undefined でアイコンなしになる。
      iconUrl: s.icon_name ? iconUrls.get(`${iconKind}:${s.icon_name}`) ?? null : null,
      ...(iconKind === 'weapon' ? kitIconsForWeapon(s.icon_name, weaponMeta, subImages, spImages) : undefined),
      // 見出しにアイコン + 名前が出るので、ブキ/ステージ行は重複になる (#433)
      tooltipRows: [
        ...metricRows,
        { label: t('env.sample'), value: s.n.toLocaleString() },
      ],
    }
  }).filter(p => p.x !== null && p.y !== null), [shownScatter, xM, yM, sizeM, colorM, isCatColor, colorKey, pointColor, iconUrls, iconKind, presentCategories, weaponMeta, subImages, spImages, t])

  // サイズ・色の凡例(#420)。
  // サイズは **描画された点** の値から作る(Recharts の ZAxis も描画データから
  // ドメインを取るので、X/Y が欠けて落ちた点を混ぜるとレンジがズレる)。
  const sizeLegend = useMemo(
    () => (sizeM ? buildSizeLegend(sizeM.label, points.map(p => p.size), sizeM.fmt) : null),
    [sizeM, points],
  )
  // 色は **colorRange と同じ shownScatter** から作り、色も本体と同じ pointColor で引く。
  // 別のレンジ・別の関数で作ると凡例が本体とズレる。
  const colorLegend = useMemo(() => {
    if (isCatColor) {
      return buildCategoryColorLegend(
        groupByLabel(t, colorKey as GroupByKey),
        shownScatter.map(s => categoryValueForEnvStat(s, colorKey)),
      )
    }
    return colorM
      ? buildColorLegend(colorM.label, shownScatter.map(s => colorM.get(s)), colorM.fmt, pointColor)
      : null
  }, [isCatColor, colorKey, colorM, shownScatter, pointColor, t])

  const xDomain = useMemo(() => computeDomain(points.map(p => p.x as number), xM.rate01), [points, xM])
  const yDomain = useMemo(() => computeDomain(points.map(p => p.y as number), yM.rate01), [points, yM])

  const cm = cellMetrics.find(m => m.key === cellMetric) ?? cellMetrics[0]

  // 軸ラベル色付け用の射影値(#405 / #411)。
  //
  // 返ってきたセルから計算してはいけない: env_matrix_stats はサンプル不足のセルを
  // 落として返すため、クライアントには全データが無い。落ち方は交差する軸で変わるので、
  // セルから加重平均すると「ガチエリアの勝率が ブキ×ルール と ステージ×ルール で違う」
  // ことになる(#411)。BE がセルの足切りとは無関係に全バトルから算出した
  // 周辺集計(marginals)をそのまま使う。
  const rowProj = useMemo(() => marginalProjection(rowMarginals), [rowMarginals])
  const colProj = useMemo(() => marginalProjection(colMarginals), [colMarginals])

  return (
    <div className="env-analysis">
      <div className="env-analysis-header">
        <h2>{t('env.title')}</h2>
        <p className="env-bias-notice">
          {t('env.biasNoticeBefore')}{' '}
          <a href="https://stat.ink" target="_blank" rel="noopener noreferrer">stat.ink</a>
          {t('env.biasNoticeAfter')}
        </p>
      </div>

      {!hasData ? (
        <div className="env-placeholder">
          <div className="env-placeholder-icon">🌍</div>
          <h3>{t('env.noDataTitle')}</h3>
          <p>{t('env.noDataDesc')}</p>
          <p className="env-placeholder-sub">{t('env.noDataSub')}</p>
          <button className="btn-primary" onClick={handleDownloadFull} disabled={importing}>
            {importing ? t('env.downloading') : t('env.download')}
          </button>
          {error && <p className="env-error">{error}</p>}
          {progress && <ProgressDisplay progress={progress} />}
        </div>
      ) : (
        <>
          <div className="env-data-header">
            <span className="env-data-range">
              {t('env.dataRange', {
                min: status.min_date,
                max: status.max_date,
                rows: (status.total_rows / 10000).toFixed(1),
              })}
            </span>
            <button className="btn-primary" onClick={handleDelta} disabled={importing}
                    title={t('env.deltaTitle')}>
              {importing ? t('env.updating') : t('env.deltaUpdate')}
            </button>
            {error && <span className="env-error">{error}</span>}
          </div>

          {!status.full_kda && (
            <p className="env-filter-note">{t('env.kdaLegacyNote')}</p>
          )}

          {progress && <ProgressDisplay progress={progress} />}

          {/* モード切替 */}
          <div className="env-mode-tabs">
            <button className={vizMode === 'scatter' ? 'env-mode-tab is-active' : 'env-mode-tab'}
                    onClick={() => setVizMode('scatter')}>{t('env.scatter')}</button>
            <button className={vizMode === 'heatmap' ? 'env-mode-tab is-active' : 'env-mode-tab'}
                    onClick={() => setVizMode('heatmap')}>{t('env.heatmap')}</button>
          </div>

          {/* 共通フィルタ(並びは FilterBar＝期間→ロビー→ルール→ブキ→ステージ に合わせる) */}
          <div className="env-filters">
            {/* 期間はバトル・ブキ・ステージと同じくボタンを並べる（#585）。
                「今シーズン」はボタンではなくシーズンのプルダウンの先頭にある。 */}
            <label>{t('filter.period')}
              <span className="env-period-btns">
                {/* シーズンは期間の先頭。既定が「今シーズン」なので、ボタンより前に置く。 */}
                <SeasonSelect
                  seasons={seasons}
                  value={period === 'season' ? seasonName : null}
                  isCurrent={period === 'current_season'}
                  onSelect={s => {
                    if (s) { setSeasonName(s.name); setPeriod('season') }
                    // 先頭は「今シーズン」= 自動追従。外したらそこへ戻す。
                    else   { setSeasonName(null);   setPeriod('current_season') }
                  }}
                />
                {PERIOD_KEYS.map(key => (
                  <button
                    key={key}
                    type="button"
                    className={`filter-btn${period === key ? ' active' : ''}`}
                    onClick={() => setPeriod(key)}
                  >{t(periodLabelKey(key))}</button>
                ))}
              </span>
            </label>
            {period === 'custom' && (
              <>
                <label>{t('env.periodStart')}
                  <input type="date" value={customSince} max={status.max_date ?? undefined}
                         min={status.min_date ?? undefined} onChange={e => setCustomSince(e.target.value)} />
                </label>
                <label>{t('env.periodEnd')}
                  <input type="date" value={customUntil} max={status.max_date ?? undefined}
                         min={status.min_date ?? undefined} onChange={e => setCustomUntil(e.target.value)} />
                </label>
              </>
            )}
            <MultiSelect
              label={t('filter.lobby')}
              allLabel={t('filter.allLobbies')}
              selected={lobbyKeys}
              onChange={setLobbyKeys}
              options={lobbyOptions(t).filter(o => o.key).map(o => ({ key: o.key, label: o.label }))}
            />
            <MultiSelect
              label={t('filter.rule')}
              allLabel={t('filter.allRules')}
              selected={ruleKeys}
              onChange={setRuleKeys}
              options={ruleOptions(t).filter(o => o.key).map(o => ({ key: o.key, label: o.label }))}
            />
          </div>
          {/* ブキから行を変える（#585）。期間・シーズン・ロビー・ルールで 1 行目。 */}
          <div className="env-filters">
            <MultiSelect
              label={t('filter.weapon')}
              allLabel={t('filter.allWeapons')}
              loading={optionsLoading}
              selected={weaponKeys}
              onChange={setWeaponKeys}
              options={weaponOptions.map(w => ({
                key:   w.key,
                label: `${w.label}(${w.n.toLocaleString()})`,
                short: w.label,
                group: w.category || undefined,
              }))}
            />
            <MultiSelect
              label={t('filter.stage')}
              allLabel={t('filter.allStages')}
              loading={optionsLoading}
              selected={stageKeys}
              onChange={setStageKeys}
              options={stageOptions.map(s => ({
                key:   s.key,
                label: `${shortStage(s.label)}(${s.n.toLocaleString()})`,
                short: shortStage(s.label),
              }))}
            />
            <MultiSelect
              label={t('env.version')}
              allLabel={t('env.allVersions')}
              loading={optionsLoading}
              selected={gameVers}
              onChange={setGameVers}
              options={versionOptions.map(v => ({
                key:   v.game_ver,
                label: `${formatGameVer(v.game_ver)}${t('env.tenThousand', { n: (v.n / 10000).toFixed(1) })}`,
                short: formatGameVer(v.game_ver),
              }))}
            />
            <MultiSelect
              label={t('env.rankBand')}
              allLabel={t('env.allRanks')}
              loading={optionsLoading}
              selected={posterRanks}
              onChange={setPosterRanks}
              options={rankOptions.map(r => ({
                key:   r.poster_rank,
                label: `${r.poster_rank.toUpperCase()}(${r.n.toLocaleString()})`,
                short: r.poster_rank.toUpperCase(),
              }))}
            />
            <label>{t('env.xPower')}
              <span className="env-power-range">
                <input type="number" inputMode="numeric" placeholder={t('env.powerMin')} step={50}
                       value={powerMin} onChange={e => setPowerMin(e.target.value)} />
                <span className="env-power-sep">~</span>
                <input type="number" inputMode="numeric" placeholder={t('env.powerMax')} step={50}
                       value={powerMax} onChange={e => setPowerMax(e.target.value)} />
              </span>
            </label>
            <button
              type="button"
              className="env-filter-clear"
              onClick={clearFilters}
              disabled={filtersAreDefault}
              title={filtersAreDefault ? t('env.clearDefaultTitle') : t('env.clearTitle')}
            >{t('env.clear')}</button>
          </div>

          {(posterRanks.length > 0 || powerMin !== '' || powerMax !== '') && (
            <p className="env-filter-note">{t('env.rankFilterNote')}</p>
          )}

          <div className="env-status-line">
            {filteredCount != null && (
              <span className="env-filtered-count">{t('env.matchedBattles', { count: filteredCount.toLocaleString() })}</span>
            )}
            {loading
              ? <span className="env-loading"><span className="env-loading-spinner" />{t('env.graphUpdating')}</span>
              : <span className="env-updated">{t('env.graphUpdated')}</span>}
          </div>

          {vizMode === 'scatter' ? (
            <>
              <div className="env-filters">
                <label>{t('env.groupByAxis')}
                  <select value={groupBy} onChange={e => setGroupBy(e.target.value as 'weapon' | 'stage')}>
                    <option value="weapon">{t('env.byWeapon')}</option>
                    <option value="stage">{t('env.byStage')}</option>
                  </select>
                </label>
                {/* 表示するブキ（#593）。集計は動かさず、描く点だけを選ぶ。
                    上の共通フィルタ（そのブキがいるバトルに限定）とは意味が違う。 */}
                {groupBy === 'weapon' && <DisplayWeaponSelect
                  options={weaponOptions} selected={displayWeapons} onChange={setDisplayWeapons}
                  loading={optionsLoading} />}
                <label>{t('env.xAxis')}
                  <select value={xKey} onChange={e => setXKey(e.target.value)}>
                    {metrics.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
                  </select>
                </label>
                <LogToggle
                  label={t('env.xLog')} checked={xLog} allowed={xLogOk}
                  metricLabel={xM.label} onChange={setXLog}
                />
                <label>{t('env.yAxis')}
                  <select value={yKey} onChange={e => setYKey(e.target.value)}>
                    {metrics.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
                  </select>
                </label>
                <LogToggle
                  label={t('env.yLog')} checked={yLog} allowed={yLogOk}
                  metricLabel={yM.label} onChange={setYLog}
                />
                {/* 点をブキ画像にする(#631)。ステージ画像は横長で正方形に収まらないので出さない。 */}
                {groupBy === 'weapon' && (
                  <label>{t('env.pointStyle')}
                    <select value={pointStyle} onChange={e => setPointStyle(e.target.value)}>
                      <option value="dot">{t('env.pointDot')}</option>
                      <option value="image">{t('env.pointImage')}</option>
                    </select>
                  </label>
                )}
                {imageMode && (
                  <label>{t('env.imageSize')}
                    <select value={imageSize} onChange={e => setImageSize(e.target.value)}>
                      {(['small', 'medium', 'large'] as ScatterImageSize[]).map(s => (
                        <option key={s} value={s}>{scatterImageSizeLabels[s]}</option>
                      ))}
                    </select>
                  </label>
                )}
                {/* 🔴 画像モードでは**出さない**。画像が塗りを埋めるので色は読めず、
                    サイズは一定にする約束（AGENTS.md「設定 UI のルール」）。 */}
                {!imageMode && <label>{t('env.size')}
                  <select value={sizeKey} onChange={e => setSizeKey(e.target.value)}>
                    <option value="">{t('env.none')}</option>
                    {metrics.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
                  </select>
                </label>}
                {!imageMode && <label>{t('env.colorShape')}
                  <select value={colorKey} onChange={e => setColorKey(e.target.value)}>
                    <option value="">{t('env.none')}</option>
                    {metrics.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
                    {groupBy === 'weapon' && SCATTER_CATEGORY_COLOR_KEYS.map(k => (
                      <option key={k} value={k}>{groupByLabel(t, k)}</option>
                    ))}
                  </select>
                </label>}
              </div>

              <div className={`env-chart-section${loading ? ' is-loading' : ''}`} ref={scatterPanelRef}>
                {loading && (
                  <div className={`env-chart-loading ${EXPORT_HIDE_CLASS}`} aria-live="polite">
                    <span className="env-loading-spinner" />
                    {t('env.graphUpdating')}
                  </div>
                )}
                <PanelExportLogo />
                <div className="env-chart-title-row">
                  <h3 className="env-chart-title">{t('env.chartTitle', {
                    x: xM.label,
                    y: yM.label,
                    group: groupBy === 'weapon' ? t('env.byWeapon') : t('env.byStage'),
                  })}</h3>
                  <PanelExportButton
                    targetRef={scatterPanelRef}
                    screen={t('nav.env')}
                    panel={groupBy === 'weapon'
                      ? t('env.scatterPanelWeapon', { x: xM.label, y: yM.label })
                      : t('env.scatterPanelStage', { x: xM.label, y: yM.label })}
                  />
                </div>
                <PanelExportCaption conditions={envExportCaption(t, envFilterSummary, filteredCount)} />
                {points.length === 0 ? (
                  <p className="env-no-data">{t('env.noScatterData')}</p>
                ) : (
                  <ScatterChart
                    points={points}
                    xLabel={xM.label} yLabel={yM.label}
                    xIsRate={xM.rate01} yIsRate={yM.rate01}
                    xLogScale={xLog && xLogOk} yLogScale={yLog && yLogOk}
                    xDomain={xDomain} yDomain={yDomain}
                    xRefLine={metricRefLine(xM.key)}
                    yRefLine={metricRefLine(yM.key)}
                    hasSize={!!sizeM}
                    sizeLegend={sizeLegend}
                    colorLegend={colorLegend}
                    imagePx={imagePx}
                    constSize={300}
                    fillOpacity={0.55}
                    height={440}
                  />
                )}
                <p className={`env-chart-note ${EXPORT_HIDE_CLASS}`}>
                  {t('env.scatterNoteBase')}
                  {groupBy === 'stage' && weaponKeys.length === 0 && t('env.scatterNoteStageWeapon')}
                  {' '}{posterExcludedNote}
                </p>
                <PanelExportNote note={scatterExportNote} />
              </div>
            </>
          ) : (
            <>
              <div className="env-filters">
                <label>{t('env.row')}
                  <select value={rowDim} onChange={e => setRowDim(e.target.value)}>
                    {dims.map(d => <option key={d.key} value={d.key}>{d.label}</option>)}
                  </select>
                </label>
                <label>{t('env.col')}
                  <select value={colDim} onChange={e => setColDim(e.target.value)}>
                    {dims.map(d => <option key={d.key} value={d.key}>{d.label}</option>)}
                  </select>
                </label>
                {/* 行か列がブキのときだけ、表示するブキを選べる（#593）。 */}
                {(rowDim === 'weapon' || colDim === 'weapon') && <DisplayWeaponSelect
                  options={weaponOptions} selected={displayWeapons} onChange={setDisplayWeapons}
                  loading={optionsLoading} />}
                <label>{t('env.cellMetric')}
                  <select value={cellMetric} onChange={e => setCellMetric(e.target.value as CellMetricKey)}>
                    {allowedCellMetrics.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
                  </select>
                </label>
              </div>
              {!weaponSlotInvolved && !bothWeaponSlot && !hasWeaponFilter && (
                <p className={`env-filter-note ${EXPORT_HIDE_CLASS}`}>{t('env.heatmapWeaponHint')}</p>
              )}

              <div className={`env-chart-section${loading ? ' is-loading' : ''}`} ref={heatmapPanelRef}>
                {loading && (
                  <div className={`env-chart-loading ${EXPORT_HIDE_CLASS}`} aria-live="polite">
                    <span className="env-loading-spinner" />
                    {t('env.graphUpdating')}
                  </div>
                )}
                <PanelExportLogo />
                <div className="env-chart-title-row">
                  <h3 className="env-chart-title">{t('env.heatmapTitle', {
                    row: dimLabel(dims, rowDim),
                    col: dimLabel(dims, colDim),
                    metric: cm.label,
                  })}</h3>
                  {heatmapSortCol && (
                    <button
                      type="button"
                      className={`env-heatmap-sort-reset ${EXPORT_HIDE_CLASS}`}
                      onClick={clearHeatmapSort}
                      title={t('env.sortResetTitle')}
                    >{t('env.sortReset')}</button>
                  )}
                  <PanelExportButton
                    targetRef={heatmapPanelRef}
                    screen={t('nav.env')}
                    panel={t('env.heatmapPanel', {
                      row: dimLabel(dims, rowDim),
                      col: dimLabel(dims, colDim),
                      metric: cm.label,
                    })}
                  />
                </div>
                <PanelExportCaption conditions={envExportCaption(t, envFilterSummary, filteredCount)} />
                {bothWeaponSlot ? (
                  <p className="env-no-data">{t('env.bothWeaponSlot')}</p>
                ) : (
                  <Heatmap
                    cells={shownMatrix}
                    valueLabel={cm.fmt}
                    scale={cm.scale}
                    mid={cm.mid ?? 0.5}
                    sequentialHue={cm.hue ?? 210}
                    rowAxis={dimLabel(dims, rowDim)}
                    colAxis={dimLabel(dims, colDim)}
                    rowLabel={dimKeyLabeller(t, rowDim)}
                    colLabel={dimKeyLabeller(t, colDim)}
                    diagonalCols={colDim === 'stage'}
                    rowOrder={rowDim === 'rule' ? RULE_HEATMAP_ORDER : undefined}
                    colOrder={colDim === 'rule' ? RULE_HEATMAP_ORDER : undefined}
                    sortColKey={heatmapSortCol}
                    sortDir={heatmapSortDir}
                    onColHeaderClick={handleHeatmapColHeaderClick}
                    rowValue={rowProj}
                    colValue={colProj}
                    // バトル数は合計なので、セルの min/max ではなく軸内の相対で色付けする(#411)。
                    axisRelative={cellMetric === 'battles'}
                    rowTip={rowDim === 'weapon' ? heatmapWeaponTip : undefined}
                    colTip={colDim === 'weapon' ? heatmapWeaponTip : undefined}
                  />
                )}
                <p className={`env-chart-note ${EXPORT_HIDE_CLASS}`}>
                  {t('env.heatmapNoteBase', { n: KDA_CELL_KEYS.includes(cellMetric) ? 20 : 30 })}
                  {cellMetric === 'win_rate' && t('env.heatmapNoteWinRate')}
                  {cellMetric === 'avg_death' && t('env.heatmapNoteDeath')}
                  {(cellMetric === 'kill_ratio' || cellMetric === 'contrib_ratio') && t('env.heatmapNoteRatio')}
                  {cm.weapon && ` ${posterExcludedNote}`}
                  {cellMetric === 'battles'
                    ? t('env.heatmapNoteBattlesAxis')
                    : t('env.heatmapNoteMarginalAxis')}
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

/**
 * データ配列から軸ドメインを算出する(オートスケール)。値はすべて非負。
 *
 * 🔴 **キリのいい値へ外側に丸めない。** 以前は (hi - lo) / 4 の刻みで外へ広げていたが、
 * 勝率のように幅の狭い指標だと上下に空白ができて点が中央に寄る
 * （37〜59% のデータが 35〜60% の軸になり、さらに軸側の余白が乗る）。
 *
 * 目盛りは `ScatterChart` が domain から改めてキリのいい値で作るので、ここで
 * 揃えておく必要は無い。**データに寄せるほど点が散らばって読みやすい。**
 */
function computeDomain(vals: number[], rate01: boolean): [number, number] {
  if (vals.length === 0) return [0, 1]
  let lo = Math.min(...vals)
  let hi = Math.max(...vals)
  if (lo === hi) {
    // 幅が無いと軸が潰れるので、ここだけは広げる。
    const pad = Math.abs(lo) * 0.1 || (rate01 ? 0.05 : 1)
    lo -= pad; hi += pad
  }
  if (lo < 0) lo = 0                                 // 値は非負
  if (rate01) { lo = Math.max(0, lo); hi = Math.min(1, hi) }
  const round = (x: number) => Math.round(x * 1e6) / 1e6  // 浮動小数の誤差を除去
  return [round(lo), round(hi)]
}

/**
 * 散布図の軸ログスケール切替(#473)。
 *
 * ピック率のようにロングテールな指標は、リニアだとマイナーブキが原点付近に潰れる。
 * `allowed` が false(勝率など)のときは押せなくし、理由を title で出す。
 */
/**
 * 「表示するブキ」の選択（#593）。
 *
 * 🔴 **共通フィルタのブキとは別物。** あちらは母集団を絞る（そのブキがいるバトルに限定）。
 * こちらは集計を動かさず、描く点・行だけを選ぶ。
 * 取り違えないよう、置き場所（グラフ設定の中）とラベルの両方で区別している。
 */
function DisplayWeaponSelect({ options, selected, onChange, loading }: {
  options:  EnvFilterOption[]
  selected: string[]
  onChange: (v: string[]) => void
  loading:  boolean
}) {
  const { t } = useTranslation()
  return (
    <MultiSelect
      label={t('env.displayWeapons')}
      allLabel={t('env.displayAll')}
      selected={selected}
      onChange={onChange}
      loading={loading}
      options={options.map(w => ({
        key:   w.key,
        label: `${w.label}(${w.n.toLocaleString()})`,
        short: w.label,
        group: w.category || undefined,
      }))}
    />
  )
}

function LogToggle({ label, checked, allowed, metricLabel, onChange }: {
  label:       string
  checked:     boolean
  allowed:     boolean
  metricLabel: string
  onChange:    (v: boolean) => void
}) {
  const { t } = useTranslation()
  return (
    <label
      className={`env-log-toggle${allowed ? '' : ' is-disabled'}`}
      title={allowed
        ? t('env.logToggleAllowed', { metric: metricLabel })
        : t('env.logToggleDisallowed', { metric: metricLabel })}
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
  const { t } = useTranslation()
  const pctv = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0
  const phaseLabel =
    progress.phase === 'download' ? t('settings.envPhaseDownload') :
    progress.phase === 'extract'  ? t('settings.envPhaseExtract') :
    progress.phase === 'index'    ? t('settings.envPhaseIndex') :
    t('settings.envPhaseImport')
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
