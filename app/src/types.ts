export type Tab = 'dashboard' | 'battles' | 'weapons' | 'ai' | 'settings'

export type Period = 'all' | 'current_season' | '30d' | '7d' | 'custom'

/** Splatoon 3 シーズンの開始日 (YYYY-MM-DD) を返す。
 *  シーズンは 3/6/9/12 月の 1 日始まりの 3 ヶ月サイクル。 */
export function currentSeasonStart(now: Date = new Date()): string {
  const month = now.getMonth() // 0-indexed
  let year = now.getFullYear()
  let startMonth: number
  if      (month >= 11) startMonth = 11      // Dec → Dec
  else if (month >=  8) startMonth =  8      // Sep–Nov → Sep
  else if (month >=  5) startMonth =  5      // Jun–Aug → Jun
  else if (month >=  2) startMonth =  2      // Mar–May → Mar
  else { startMonth = 11; year -= 1 }        // Jan–Feb → 前年 12 月
  const m = String(startMonth + 1).padStart(2, '0')
  return `${year}-${m}-01`
}

export interface Filters {
  period: Period
  mode: string | null
  rule: string | null
  result: string | null
  weapon: string[]
  stage: string[]
  customFrom: string | null
  customTo: string | null
}

export const DEFAULT_FILTERS: Filters = {
  period: 'all',
  mode: null,
  rule: null,
  result: null,
  weapon: [],
  stage: [],
  customFrom: null,
  customTo: null,
}

export function periodToSince(period: Period): string | null {
  if (period === 'all' || period === 'custom') return null
  if (period === 'current_season') return currentSeasonStart()
  const d = new Date()
  d.setDate(d.getDate() - (period === '30d' ? 30 : 7))
  return d.toISOString().slice(0, 10)
}

export function filtersToRange(filters: Filters): { since: string | null; until: string | null } {
  if (filters.period === 'custom') {
    return { since: filters.customFrom, until: filters.customTo }
  }
  return { since: periodToSince(filters.period), until: null }
}

// ---------------------------------------------------------------------------
// バトル詳細用の型（my_team / other_teams JSON から復元）
// ---------------------------------------------------------------------------

export interface Color {
  r: number
  g: number
  b: number
  a: number
}

export interface Ability {
  name?: string
  image?: { url?: string }
}

export interface Gear {
  primaryGearPower?: Ability
  additionalGearPowers?: Ability[]
}

export interface PlayerResult {
  kill?: number
  death?: number
  assist?: number
  special?: number
  noroshiTry?: number
}

export interface Player {
  name?: string
  byname?: string
  nameId?: string
  species?: string
  isMyself?: boolean
  paint?: number
  crown?: boolean
  festDragonCert?: string
  weapon?: {
    name?: string
    image?: { url?: string }
    subWeapon?: { name?: string; image?: { url?: string } }
    specialWeapon?: { name?: string; image?: { url?: string } }
  }
  headGear?: Gear
  clothingGear?: Gear
  shoesGear?: Gear
  result?: PlayerResult | null
}

export interface TeamResult {
  paintRatio?: number | null
  score?: number | null
  noroshi?: number | null
}

export interface Team {
  color?: Color
  result?: TeamResult
  players?: Player[]
}

/**
 * battles.parent_json に保存される履歴クエリの親ノード。
 * バンカラチャレンジ時は bankaraMatchChallenge、X マッチ評価戦時は xMatchMeasurement の中身。
 * 各 historyGroup の最新バトル（idx==0）にのみ非 null。
 */
export interface ParentJson {
  // 両方共通
  winCount?:  number
  loseCount?: number
  // バンカラチャレンジ
  earnedUdemaePoint?: number
  udemaeAfter?:        string | null
  isPromo?:            boolean
  isUdemaeUp?:         boolean
  // X マッチ評価戦
  xPowerAfter?: number | null
}

export interface VsHistoryDetail {
  myTeam?: Team
  otherTeams?: Team[]
  judgement?: string
  knockout?: string
  awards?: Award[]
  bankaraMatch?: { earnedUdemaePoint?: number; bankaraPower?: { power?: number } | null }
  xMatch?: { lastXPower?: number | null }
  festMatch?: { contribution?: number | null }
}

export interface Award {
  name?: string
  rank?: 'GOLD' | 'SILVER' | string
  image?: { url?: string }
}

export interface BattleRow {
  id: string
  played_at: string
  mode: string
  rule: string
  stage: string
  stage_name: string | null
  weapon: string
  result: 'win' | 'lose' | 'draw'
  kill: number
  death: number
  assist: number
  special: number
  inked: number
  duration: number
  rank_before: string | null
  rank_after: string | null
  x_power: number | null
  raw_json: string
  fetched_at: string
  knockout: string | null
  sub_weapon: string | null
  special_weapon: string | null
  awards: string | null
  my_team: string | null
  other_teams: string | null
  statink_uuid: string | null
  /** 履歴クエリの親ノード（bankaraMatchChallenge / xMatchMeasurement）の JSON。
   *  各 historyGroup の最新バトルのみ非 null。stat.ink 連携や詳細表示で使う。 */
  parent_json: string | null
}

export interface SummaryEntry {
  name: string
  total: number
  wins: number
  draws: number
  win_rate: number
}

export interface Summary {
  by_weapon: SummaryEntry[]
  by_mode: SummaryEntry[]
  by_stage: SummaryEntry[]
  by_rule: SummaryEntry[]
}

export interface WeaponRecord {
  name: string
  category: string
  sub_weapon: string | null
  special_weapon: string | null
  sub_weapon_image: string | null
  special_weapon_image: string | null
  total: number
  wins: number
  draws: number
}

export interface AiSettings {
  provider: 'openai' | 'gemini' | 'anthropic' | 'grok'
  apiKey: string
  model: string
}

export interface StatinkSettings {
  apiKey: string
  autoUpload: boolean
  screenName: string | null
}

export interface AppSettings {
  ai: AiSettings
  autoFetchEnabled: boolean
  /** 自動取得の実行間隔（分）。例: 15, 30, 60, 120, 360, 720, 1440 */
  autoFetchIntervalMin: number
  statink: StatinkSettings
}

const STAGE_ABBR_OVERRIDE: Record<string, string> = {
  'ザトウマーケット':           'ザトウ',
  'タラポートショッピングパーク': 'タラポ',
  'スメーシーワールド':          'スメーシー',
  'マンタマリア号':             'マンタ',
  'リュウグウターミナル':        'リュウグウ',
  'コンブトラック':             'コンブ',
  'マヒマヒリゾート&スパ':       'マヒマヒ',
  '海女美術大学':              '海女美',
}

/** ステージ表示名を省略形にする（stage_name 等のフルネームを渡す）。 */
export function stageAbbr(name: string): string {
  if (!name) return ''
  if (STAGE_ABBR_OVERRIDE[name]) return STAGE_ABBR_OVERRIDE[name]
  const m = name.match(/^[゠-ヿ]+/)
  return m ? m[0] : name
}

const MODE_LABELS: Record<string, string> = {
  // 新形式（stat.ink ID）
  'regular':           'レギュラー',
  'bankara':           'バンカラ',           // フィルター・ダッシュボード用
  'bankara_challenge': 'バンカラ(チャレンジ)', // バトルログ行表示用
  'bankara_open':      'バンカラ(オープン)',   // バトルログ行表示用
  'x':                 'Xマッチ',
  // 旧形式（後方互換）
  'BANKARA':  'バンカラ',
  'REGULAR':  'レギュラー',
  'XMATCH':   'Xマッチ',
  'LEAGUE':   'リーグ',
  'PRIVATE':  'プライベート',
}

export const RULE_LABELS: Record<string, string> = {
  'turf_war': 'ナワバリバトル',
  'area':     'ガチエリア',
  'yagura':   'ガチヤグラ',
  'hoko':     'ガチホコバトル',
  'asari':    'ガチアサリ',
}

export function modeLabel(mode: string): string {
  return MODE_LABELS[mode] ?? mode
}

export function ruleLabel(rule: string): string {
  return RULE_LABELS[rule] ?? rule
}

export function resultLabel(result: string): string {
  if (result === 'win'  || result === 'WIN')  return 'Win'
  if (result === 'lose' || result === 'LOSE') return 'Lose'
  if (result === 'draw' || result === 'DRAW') return 'Draw'
  return result
}

export interface ChartSpec {
  chartType: 'bar' | 'line' | 'scatter' | 'pie'
  title: string
  data: Record<string, unknown>[]
  xKey: string
  yKey: string
  colorKey?: string
}

/** db_battle_stats の返り値型。
 *  avg_kill / avg_death は detail_fetched=1 のバトルのみで集計。詳細未取得しかない場合は null。 */
export interface BattleStats {
  total: number
  wins: number
  draws: number
  win_rate: number
  weapon_count: number
  avg_kill: number | null
  avg_death: number | null
}

/** 平均キル / 平均デスから集計キルレシオを文字列で返す。null・D=0 を考慮。 */
export function avgKillRatio(avgKill: number | null, avgDeath: number | null): string {
  if (avgKill === null || avgDeath === null) return '—'
  if (avgDeath === 0) return '∞'
  return (avgKill / avgDeath).toFixed(2)
}

// ---------------------------------------------------------------------------
// カスタムグラフ（#86）用の型
// ---------------------------------------------------------------------------

/** db_grouped_stats の集計キー（X 軸候補）。 */
export type GroupByKey =
  | 'weapon'
  | 'stage'
  | 'rule'
  | 'mode'
  | 'sub_weapon'
  | 'special_weapon'
  | 'weapon_category'
  | 'result'

/** シンプル棒チャートで Y 軸に使えるメトリクス。 */
export type MetricKey =
  | 'total'         // バトル数
  | 'wins'          // 勝数
  | 'win_rate'      // 勝率（0-1）
  | 'avg_kill'      // 平均キル
  | 'avg_death'     // 平均デス
  | 'avg_assist'    // 平均アシスト
  | 'avg_kd'        // 平均キル/デス（クライアント側で算出）
  | 'avg_special'   // 平均スペシャル
  | 'avg_inked'     // 平均塗り
  | 'avg_duration'  // 平均バトル時間（秒）

/** カスタムグラフ 1 個分の設定。localStorage に CustomChart[] として保存する想定。 */
export type CustomChartType = 'stacked_winrate' | 'simple_bar' | 'attack_defense'

export interface CustomChart {
  id:       string
  title:    string
  type:     CustomChartType
  groupBy:  GroupByKey
  /** `simple_bar` のときのみ必要。それ以外は無視される。 */
  metric?:  MetricKey
}

/** db_grouped_stats の返却 1 行分。
 *  `avg_*` は detail_fetched=1 のバトルだけで集計しているため、未取得しかない場合は null。 */
export interface GroupedStatsRow {
  key:           string
  name:          string
  total:         number
  wins:          number
  draws:         number
  win_rate:      number
  avg_kill:      number | null
  avg_death:     number | null
  avg_assist:    number | null
  avg_special:   number | null
  avg_inked:     number | null
  avg_duration:  number | null
}

/** UI 表示用のラベル。 */
export const GROUP_BY_LABELS: Record<GroupByKey, string> = {
  weapon:          '武器',
  stage:           'ステージ',
  rule:            'ルール',
  mode:            'モード',
  sub_weapon:      'サブ',
  special_weapon:  'スペシャル',
  weapon_category: '武器カテゴリ',
  result:          '結果',
}

export const METRIC_LABELS: Record<MetricKey, string> = {
  total:        'バトル数',
  wins:         '勝数',
  win_rate:     '勝率',
  avg_kill:     '平均キル',
  avg_death:    '平均デス',
  avg_assist:   '平均アシスト',
  avg_kd:       '平均キル/デス',
  avg_special:  '平均SP',
  avg_inked:    '平均塗り',
  avg_duration: '平均バトル時間',
}

/** GroupedStatsRow から指定メトリクスの数値を取り出す。NULL は null を返す。
 *  `avg_kd` は avg_kill / avg_death をクライアント側で算出（D=0 は null）。 */
export function getMetric(row: GroupedStatsRow, metric: MetricKey): number | null {
  switch (metric) {
    case 'total':        return row.total
    case 'wins':         return row.wins
    case 'win_rate':     return row.win_rate
    case 'avg_kill':     return row.avg_kill
    case 'avg_death':    return row.avg_death
    case 'avg_assist':   return row.avg_assist
    case 'avg_kd':
      if (row.avg_kill === null || row.avg_death === null) return null
      if (row.avg_death === 0) return null
      return row.avg_kill / row.avg_death
    case 'avg_special':  return row.avg_special
    case 'avg_inked':    return row.avg_inked
    case 'avg_duration': return row.avg_duration
  }
}

/** メトリクス値の表示文字列。勝率は %、時間は m:ss、それ以外は小数 2 桁。 */
export function formatMetric(value: number | null, metric: MetricKey): string {
  if (value === null) return '—'
  if (metric === 'win_rate') return `${(value * 100).toFixed(1)}%`
  if (metric === 'avg_duration') {
    const m = Math.floor(value / 60)
    const s = Math.round(value % 60)
    return `${m}:${String(s).padStart(2, '0')}`
  }
  if (metric === 'total' || metric === 'wins') return value.toLocaleString()
  return value.toFixed(2)
}
