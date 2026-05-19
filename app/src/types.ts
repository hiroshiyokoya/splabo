export type Tab = 'dashboard' | 'battles' | 'ai' | 'settings'

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
