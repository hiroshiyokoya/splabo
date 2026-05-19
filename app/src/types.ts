export type Tab = 'dashboard' | 'battles' | 'weapons' | 'ai' | 'settings'

export type Period = 'all' | '30d' | '7d'

export interface Filters {
  period: Period
  mode: string | null
  rule: string | null
  result: string | null
  weapon: string | null
}

export const DEFAULT_FILTERS: Filters = {
  period: 'all',
  mode: null,
  rule: null,
  result: null,
  weapon: null,
}

export function periodToSince(period: Period): string | null {
  if (period === 'all') return null
  const d = new Date()
  d.setDate(d.getDate() - (period === '30d' ? 30 : 7))
  return d.toISOString().slice(0, 10)
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

export interface ChartSpec {
  chartType: 'bar' | 'line' | 'scatter' | 'pie'
  title: string
  data: Record<string, unknown>[]
  xKey: string
  yKey: string
  colorKey?: string
}
