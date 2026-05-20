export type Tab = 'dashboard' | 'battles' | 'weapons' | 'ai' | 'settings'

export type Period = 'all' | '30d' | '7d' | 'custom'

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
  provider: 'openai' | 'gemini'
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
  autoFetchHour: number
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
