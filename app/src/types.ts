export type Tab = 'dashboard' | 'battles' | 'weapons' | 'ai' | 'settings'

export type Period = 'all' | '30d' | '7d' | 'custom'

export interface Filters {
  period: Period
  mode: string | null
  rule: string | null
  result: string | null
  weapon: string | null
  stage: string | null
  customFrom: string | null
  customTo: string | null
}

export const DEFAULT_FILTERS: Filters = {
  period: 'all',
  mode: null,
  rule: null,
  result: null,
  weapon: null,
  stage: null,
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

export interface BattleRow {
  id: string
  played_at: string
  mode: string
  rule: string
  stage: string
  weapon: string
  result: 'WIN' | 'LOSE' | 'DRAW'
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
}

export interface AiSettings {
  provider: 'openai' | 'gemini'
  apiKey: string
  model: string
}

export interface AppSettings {
  ai: AiSettings
  autoFetchEnabled: boolean
  autoFetchHour: number
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

export function stageAbbr(name: string): string {
  if (STAGE_ABBR_OVERRIDE[name]) return STAGE_ABBR_OVERRIDE[name]
  const m = name.match(/^[゠-ヿ]+/)
  return m ? m[0] : name
}

const MODE_LABELS: Record<string, string> = {
  'BANKARA':  'バンカラ',
  'REGULAR':  'ナワバリ',
  'XMATCH':   'Xマッチ',
  'LEAGUE':   'リーグ',
  'PRIVATE':  'プライベート',
}

export function modeLabel(mode: string): string {
  return MODE_LABELS[mode] ?? mode
}

export function resultLabel(result: string): string {
  if (result === 'WIN')  return 'Win'
  if (result === 'LOSE') return 'Lose'
  if (result === 'DRAW') return 'Draw'
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
