export type Tab = 'battles' | 'weapons' | 'stages' | 'ai' | 'env' | 'gear' | 'settings'

/** 「バトル」タブ内のビュー(#296: 旧ダッシュボードタブ + 旧バトルログタブの統合)。 */
export type BattlesView = 'dashboard' | 'list'

/** ブキ・ステージタブ内のビュー(#297)。 */
export type BookView = 'panel' | 'list'

/** 設定タブ内のサブタブ(#428 / #434)。連携・データ・表示・AI。 */
export type SettingsTab = 'link' | 'data' | 'display' | 'ai'

/**
 * 期間の絞り込み。
 *
 * `current_season` は**今のシーズンに自動で追従する**（日が変わればシーズンも変わる）。
 * `season` は**特定のシーズンを名指しで選んだ状態**（#585）。過去のシーズンを見るために使う。
 */
export type Period = 'all' | 'current_season' | 'season' | '1y' | '180d' | '30d' | '7d' | 'custom'

/**
 * AI 分析のグラフ（#587）。**点への振り分けは Rust の `ai_present` が済ませている。**
 *
 * 数値は SQLite が出したまま。フロントは受け取った系列を描くだけで、選別も並べ替えもしない。
 */
export interface ShapedChart {
  kind: 'bar' | 'line' | 'scatter'
  title?: string
  x_label: string
  y_label: string
  /** 横軸が数値か。軸の型を決めるのに使う。 */
  x_numeric: boolean
  series: { name: string; points: { x: string | number; y: number }[] }[]
  warnings: string[]
}

/** `list_seasons` コマンドの返却型（#585）。計算は Rust の `season.rs` が持つ。 */
export interface Season {
  name: string
  /** 開始日 (YYYY-MM-DD)。 */
  since: string
  /** 終了日 (YYYY-MM-DD)。**この日を含む。** */
  until: string
}

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
  mode: string[]       // #190: 複数選択(OR)。キーは lobby.key(regular / bankara_open / xmatch …)
  rule: string[]       // #190: 複数選択(OR)。キーは FE スラッグ(turf_war / area …)
  result: string | null
  weapon: string[]
  stage: string[]
  customFrom: string | null
  customTo: string | null
  /**
   * 名指しで選んだシーズン名（`period === 'season'` のときだけ意味を持つ・#585）。
   *
   * 日付範囲は `customFrom` / `customTo` に入れる。**シーズンの計算はフロントに置かない**
   * （Rust の `season.rs` が唯一の出力元）ので、選んだ時点で解決した範囲を持ち回る。
   * 名前を別に持つのは、保存画像のキャプションに日付ではなくシーズン名を出すため。
   */
  seasonName: string | null
}

export const DEFAULT_FILTERS: Filters = {
  period: 'current_season',
  mode: [],
  rule: [],
  result: null,
  weapon: [],
  stage: [],
  customFrom: null,
  customTo: null,
  seasonName: null,
}

/** 複数選択モード配列 → バックエンドのパイプ区切り mode 引数(空なら null)。
 *  キーは lobby.key に一致させてあるのでそのまま結合する。 */
export function modeFilterArg(mode: string[]): string | null {
  return mode.length ? mode.join('|') : null
}

/** 複数選択ルール配列 → バックエンドのパイプ区切り rule 引数(空なら null)。
 *  FE は 'turf_war' を使うが DB の rule.key は 'nawabari' なので変換する。 */
export function ruleFilterArg(rule: string[]): string | null {
  if (!rule.length) return null
  return rule.map(r => (r === 'turf_war' ? 'nawabari' : r)).join('|')
}

/** 相対期間プリセットを「今日を含む N 日間」の開始日 (YYYY-MM-DD) にする(#466)。
 *  環境分析と同じく終端日を含めて N 日になるよう、今日から (N-1) 日遡る。 */
export function periodToSince(period: Period): string | null {
  // 'season' は選んだ時点で解決した範囲を customFrom / customTo に持つ（#585）。
  if (period === 'all' || period === 'custom' || period === 'season') return null
  if (period === 'current_season') return currentSeasonStart()
  const daysBack =
    period === '1y'   ? 364 :
    period === '180d' ? 179 :
    period === '30d'  ?  29 :
    /* 7d */             6
  const d = new Date()
  d.setDate(d.getDate() - daysBack)
  return d.toISOString().slice(0, 10)
}

export function filtersToRange(filters: Filters): { since: string | null; until: string | null } {
  // シーズン指定も、選んだ時点で解決した範囲をそのまま使う（#585）。
  if (filters.period === 'custom' || filters.period === 'season') {
    return { since: filters.customFrom, until: filters.customTo }
  }
  return { since: periodToSince(filters.period), until: null }
}

/** ブキ・ステージ用の集計フィルタ引数(#298)。
 *
 *  ブキタブをブキで、ステージタブをステージで絞るのは自己言及的で不自然なため、
 *  `weapon` / `stage` は常に null にする(FilterBar 側でもこれらのタブでは非表示)。
 *  フィルタ state 自体は「バトル」タブと共有なので、ここで明示的に落とす必要がある。 */
export function filtersToBookArgs(filters: Filters): {
  since: string | null
  until: string | null
  mode: string | null
  rule: string | null
  resultFilter: string | null
  weapon: null
  stage: null
} {
  const { since, until } = filtersToRange(filters)
  return {
    since,
    until,
    mode: modeFilterArg(filters.mode),
    rule: ruleFilterArg(filters.rule),
    resultFilter: filters.result,
    weapon: null,
    stage: null,
  }
}

/** 図鑑の詳細モーダル用。FilterBar と同じ期間・モード・ルール・結果に、対象ブキ/ステージだけ足す。 */
export function filtersToBookDetailArgs(
  filters: Filters,
  extra: { weapon?: string | null; stage?: string | null },
) {
  return {
    ...filtersToBookArgs(filters),
    weapon: extra.weapon ?? null,
    stage: extra.stage ?? null,
  }
}

// ---------------------------------------------------------------------------
// バトル詳細用の型(my_team / other_teams JSON から復元)
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
 * 各 historyGroup の最新バトル(idx==0)にのみ非 null。
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
  /** 履歴クエリの親ノード(bankaraMatchChallenge / xMatchMeasurement)の JSON。
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
  // WeaponRecordQuery 由来 (#49)。未取得ブキは null。
  // FE 側は null を 0 にフォールバックするか「未取得」表示にするか選ぶ。
  weapon_level: number | null
  win_count_total: number | null
  paint_point_total: number | null
  weapon_power: number | null
  weapon_power_max: number | null
  last_used_at: number | null
}

/** 公式アプリのステージ通算勝率（StageRecordQuery）。未取得は null。 */
export interface StageRecord {
  stage_id: string
  vs_stage_id: number | null
  win_rate_tw: number | null
  win_rate_ar: number | null
  win_rate_lf: number | null
  win_rate_gl: number | null
  win_rate_cl: number | null
  last_played_at: number | null
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
  /** 自動取得の実行間隔(分)。例: 15, 30, 60, 120, 360, 720, 1440 */
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

/** ステージ表示名を省略形にする(stage_name 等のフルネームを渡す)。 */
export function stageAbbr(name: string): string {
  if (!name) return ''
  if (STAGE_ABBR_OVERRIDE[name]) return STAGE_ABBR_OVERRIDE[name]
  const m = name.match(/^[゠-ヿ]+/)
  return m ? m[0] : name
}

const MODE_LABELS: Record<string, string> = {
  // 新形式(stat.ink ID)
  'regular':           'レギュラー',
  'bankara':           'バンカラ',           // フィルター・ダッシュボード用
  'bankara_challenge': 'バンカラ(チャレンジ)', // バトルログ行表示用
  'bankara_open':      'バンカラ(オープン)',   // バトルログ行表示用
  'x':                 'Xマッチ',
  'event':             'イベントマッチ',
  'splatfest':           'フェス',              // フィルター・ダッシュボード用
  'splatfest_open':      'フェス(オープン)',     // バトルログ行表示用
  'splatfest_challenge': 'フェス(チャレンジ)',   // バトルログ行表示用
  // 旧形式(後方互換)
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

// ---------------------------------------------------------------------------
// 環境分析(#184)
// ---------------------------------------------------------------------------

/** env_status コマンドの返却型。 */
export interface EnvStatus {
  min_date:   string | null
  max_date:   string | null
  total_rows: number
  /** 取り込み済みデータが 7 人分のキル系記録を持っているか(#501)。
   *  v0.9.7 より前に取り込んだ行は投稿者と相手 1 人分しか記録が無い。 */
  full_kda:   boolean
}

/** env_scatter_stats コマンドの返却 1 行分(#187)。
 *  集計軸(ブキ/ステージ)によって埋まる指標が異なり、該当しないものは null。 */
export interface EnvScatterStat {
  key:          string
  /** アイコン画像を引くための正式名(ローカルマスターの name_ja・#412)。
   *  `read_image` は表示名でキャッシュされているため `key` では当たらないことがある。
   *  ローカルマスターに無いブキはスラッグのままで、画像は見つからない(アイコンなしで名前だけ)。 */
  icon_name:    string | null
  n:            number
  // ブキ集計
  pick_rate:    number | null
  win_rate:     number | null
  avg_kill:     number | null
  avg_death:    number | null
  avg_assist:   number | null
  avg_inked:    number | null
  // ステージ集計
  ko_rate:      number | null
  avg_ink_self: number | null
  avg_ink_opp:  number | null
  avg_count:    number | null
  /** ブキ集計のみ。カテゴリ色分け(#480)用。 */
  category_key?: string | null
  sub_key?:      string | null
  special_key?:  string | null
}

/** env_matrix_stats コマンドの 1 セル(#187)。 */
export interface EnvMatrixCell {
  row_key: string
  col_key: string
  value:   number | null
  n:       number
}

/** env_matrix_stats が返す行・列の周辺集計の 1 キー分(#411)。
 *  セルの足切り(サンプル不足セルを返さない)とは無関係に、全バトルから算出された値。
 *  `n` はそのキーの合計サンプル数(軸ラベルを色付けするかの足切り判定に使う)。 */
export interface EnvMatrixMarginal {
  key:   string
  value: number | null
  n:     number
}

/** env_matrix_stats コマンドの返却(#411 で marginals を追加)。 */
export interface EnvMatrixStats {
  cells:         EnvMatrixCell[]
  row_marginals: EnvMatrixMarginal[]
  col_marginals: EnvMatrixMarginal[]
}

/** env_season_range コマンドの返却型(#187)。 */
export interface EnvSeasonRange {
  season: string | null
  since:  string | null
  until:  string | null
}

/** env_versions コマンドの 1 件(#189)。取り込み済みデータのゲームバージョン。 */
export interface EnvVersion {
  game_ver: string
  n:        number
  min_date: string | null
  max_date: string | null
}

/** env_ranks コマンドの 1 件(#189)。投稿者のウデマエ帯。 */
export interface EnvRank {
  poster_rank: string
  n:           number
}

/** env_weapons / env_stages の 1 件(#477)。 */
export interface EnvFilterOption {
  key:   string
  label: string
  n:     number
  /** ブキカテゴリ（公式準拠）。ステージでは空(#523)。 */
  category?: string
}

/** db_battle_stats の返り値型。
 *  avg_kill / avg_death / avg_assist は detail_fetched=1 のバトルのみで集計。詳細未取得しかない場合は null。 */
export interface BattleStats {
  total: number
  wins: number
  draws: number
  win_rate: number
  weapon_count: number
  avg_kill: number | null
  avg_death: number | null
  avg_assist: number | null
}

/** 平均キル / 平均デスから集計キルレを文字列で返す。null・D=0 を考慮。 */
export function avgKillRatio(avgKill: number | null, avgDeath: number | null): string {
  if (avgKill === null || avgDeath === null) return '-'
  if (avgDeath === 0) return '∞'
  return (avgKill / avgDeath).toFixed(2)
}

/**
 * 統計パネルの `平均キル (平均アシスト)`(#561)。
 *
 * 以前は Dashboard と BattleLog に同じ実装が二重にあり、コメントで「同期」と
 * 書いて運用していた。1 本に寄せる。
 */
export function fmtKillWithAssist(
  kill: number | null | undefined,
  assist: number | null | undefined,
): string {
  if (kill == null) return '-'
  return `${kill.toFixed(2)} (${assist != null ? assist.toFixed(2) : '-'})`
}

/**
 * 統計パネルの `キルレ (貢献キルレ)`(#561)。
 *
 * 貢献キルレは (キル + アシスト) ÷ デス。アシストが取れないデータでは
 * `平均キル (平均アシスト)` と同じ考え方でカッコ内を `-` にする。
 */
export function fmtKillRatioWithContrib(
  avgKill: number | null | undefined,
  avgAssist: number | null | undefined,
  avgDeath: number | null | undefined,
): string {
  const kd = avgKillRatio(avgKill ?? null, avgDeath ?? null)
  if (kd === '-') return '-'
  const contrib = avgAssist == null
    ? '-'
    : avgKillRatio((avgKill ?? 0) + avgAssist, avgDeath ?? null)
  return `${kd} (${contrib})`
}

/** 公式アプリの最終使用日。`2026/8/14`。 */
export function fmtOfficialDate(ts: number | null | undefined): string {
  if (ts == null || ts <= 0) return '-'
  const d = new Date(ts * 1000)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

/** 公式の通算勝率（0–1）。 */
export function fmtOfficialWinRate(n: number | null | undefined): string {
  if (n == null) return '-'
  return `${(n * 100).toFixed(1)}%`
}

/**
 * バトル数の勝敗内訳 `70 勝 50 敗 3 分`(#562)。
 *
 * 引き分けは発生したときだけ出す。ヒートマップ・散布図のツールチップで
 * 同じ書き方を使うため、文言はここ 1 か所に置く(#388 で決めた形)。
 */
export function winLoseBreakdown(total: number, wins: number, draws: number): string {
  const losses = total - wins - draws
  return `${wins} 勝 ${losses} 敗${draws > 0 ? ` ${draws} 分` : ''}`
}

/** チップ用の勝敗 1 行 `バトル数: 42 (15 勝 27 敗)`。ヒートマップ・散布図・カレンダーで共用。 */
export function winCountTooltipText(total: number, wins: number, draws: number): string {
  return `バトル数: ${total} (${winLoseBreakdown(total, wins, draws)})`
}

// ---------------------------------------------------------------------------
// カスタムグラフ(#86)用の型
// ---------------------------------------------------------------------------

/** db_grouped_stats の集計キー(X 軸候補)。 */
export type GroupByKey =
  | 'weapon'
  | 'stage'
  | 'rule'
  | 'mode'
  | 'sub_weapon'
  | 'special_weapon'
  | 'weapon_category'
  | 'result'
  | 'ally_weapon'
  | 'enemy_weapon'
  // 時系列バケット(線グラフ・カレンダーで使用)。全て 9 時境界。
  | 'day'        // 1 日(9:00–翌 8:59)
  | 'three_day'  // 3 日(直近基準で遡る)
  | 'week'       // 週(月曜 9:00 開始)
  | 'month'      // 月(月初 9:00 開始)

/** 時系列バケット用の GroupByKey 判定。 */
export const TIME_BUCKET_GROUP_BYS: GroupByKey[] = ['day', 'three_day', 'week', 'month']
export function isTimeBucketGroupBy(g: GroupByKey): boolean {
  return TIME_BUCKET_GROUP_BYS.includes(g)
}

/** シンプル棒チャートで Y 軸に使えるメトリクス。
 *  KDA 系の並びは キル → アシスト → 貢献キル → デス → キルレ → 貢献キルレ(#465)。 */
export type MetricKey =
  | 'total'              // バトル数
  | 'wins'               // 勝数
  | 'win_rate'           // 勝率(0-1)
  | 'avg_kill'           // 平均キル
  | 'avg_assist'         // 平均アシスト
  | 'avg_contrib_kill'   // 平均貢献キル = 平均キル + 平均アシスト(クライアント算出)
  | 'avg_death'          // 平均デス
  | 'avg_kd'             // キルレ = 平均キル ÷ 平均デス(クライアント算出)
  | 'avg_contrib_kd'     // 貢献キルレ = (平均キル+平均アシスト) ÷ 平均デス(クライアント算出)
  | 'avg_special'        // 平均スペシャル
  | 'avg_inked'          // 平均塗り
  | 'sum_kill'           // キル数合計
  | 'sum_assist'         // アシスト数合計
  | 'sum_contrib_kill'   // 貢献キル合計 = キル合計 + アシスト合計(クライアント算出)
  | 'sum_death'          // デス数合計
  | 'sum_inked'          // 塗りポイント合計
  // 公式アプリ（全期間。ブキ軸 / ステージ軸だけで値が入る）
  | 'official_weapon_level'
  | 'official_win_count'
  | 'official_paint'
  | 'official_weapon_power'
  | 'official_weapon_power_max'
  | 'official_last_used_at'
  | 'official_win_rate_tw'
  | 'official_win_rate_ar'
  | 'official_win_rate_lf'
  | 'official_win_rate_gl'
  | 'official_win_rate_cl'

/**
 * カスタムグラフ 1 個分の設定。localStorage に CustomChart[] として保存する想定。
 *
 * モデルは「形 (shape)」と「Y 軸の構成 (yComposition)」を分離してある：
 *   - shape: 視覚的プリミティブ。棒・線・散布図・ヒートマップ
 *   - yComposition: Y 軸データの組み立て方。単一メトリクス / 勝/負/分 積み上げ+勝率 / 攻撃 vs デス
 *
 * v1.0.0 で実装する組み合わせは `shape='bar'` の 3 構成のみ。
 * 線・散布図・ヒートマップは UI には出すが v1.1+ で実装予定。
 */
export type ChartShape =
  | 'bar'              // 棒
  | 'line'             // 線
  | 'scatter'          // 散布図(後続 PR)
  | 'heatmap'          // ヒートマップ(後続 PR)
  | 'calendar_heatmap' // カレンダーヒートマップ

export type YComposition =
  | 'single_metric'    // 単一メトリクス(Y 軸にメトリクスを 1 つ選ぶ)
  | 'stacked_winrate'  // 勝/負/分 積み上げ + 勝率線
  | 'attack_defense'   // 平均K (灰色 A 積み) + 平均D セット

/**
 * カスタムグラフの設定。タイトルは持たず、表示時に `autoChartTitle(chart)` で
 * 「{X 軸}別 {Y 軸}」を常に算出する(軸を変えると即座にタイトルも追随する)。
 */
export interface CustomChart {
  id:           string
  shape:        ChartShape
  yComposition: YComposition
  groupBy:      GroupByKey
  /** yComposition='single_metric' のときのみ必要。それ以外は無視される。
   *  shape='line' では複数系列({@link metrics})を使うため無視される(#436)。 */
  metric?:      MetricKey
  /** shape='line' の複数系列メトリクス(#436)。上限なし。
   *  折れ線以外の shape では無視される。読み込み時の後方互換は {@link chartMetrics} を使うこと
   *  (旧形式の単一 `metric` しか持たない保存済みグラフも 1 要素の配列として解釈する)。 */
  metrics?:     MetricKey[]
  /** shape='heatmap' のときの Y 軸。groupBy が X 軸となる。 */
  groupBy2?:    GroupByKey
  /** ブキ軸（ヒートマップ）／ブキの X 軸（棒グラフ）で表示する件数。
   *  ヒートマップ未指定時 20、棒グラフ未指定時 14。 */
  topN?:        number
  /** shape='heatmap' で X 軸を「数値メトリクス bin」にする場合のメトリクス。
   *  指定があれば groupBy を無視して battle 単位の数値ヒストグラム軸を使う (#134)。 */
  xNumericMetric?: BattleNumericMetric
  xBinWidth?:      number
  /** shape='heatmap' で Y 軸を「数値メトリクス bin」にする場合のメトリクス。 */
  yNumericMetric?: BattleNumericMetric
  yBinWidth?:      number
  /** shape='scatter' で 1 ドット = 何の単位か。'battle' 以外は db_grouped_stats の groupBy と同じキー。 */
  dotUnit?:     ScatterDotUnit
  /** scatter の X 軸メトリクス。ドット単位がバトルなら BattleMetricKey、カテゴリなら MetricKey。 */
  xMetric?:     string
  /** scatter の Y 軸メトリクス。 */
  yMetric?:     string
  /** scatter のサイズメトリクス。指定なければ一定サイズ。 */
  sizeMetric?:  string
  /** scatter の色メトリクス。バトル単位のときは 'win_lose' も指定可。 */
  colorMetric?: string
  /**
   * scatter の X 軸をログスケールにするか (#381)。**未設定 = false**(既存グラフはリニアのまま)。
   *
   * バトル数・勝数はロングテールで少数派が原点付近に潰れ、キルレは比率なので
   * リニアだと「0.5 倍」と「2 倍」が非対称に見える。ログにすると等距離で読める。
   *
   * 🔴 ログ軸では **0 以下・非有限(∞ / NaN)の点が描けないので除外**される
   * ([ScatterChart] の `drawable`)。勝率のような比率メトリクスでは意味がないので
   * 設定 UI 側で無効化する。
   */
  xLogScale?:   boolean
  /** scatter の Y 軸をログスケールにするか (#381)。詳細は [xLogScale]。 */
  yLogScale?:   boolean
  /**
   * scatter の点の見た目 (#627)。**未設定 = 'dot'**(既存グラフは丸のまま)。
   *
   * `'image'` は点をブキ画像にする。**ブキ軸のときだけ**選べる
   * (ステージ別の点にブキ画像が付いたら嘘になる)。
   *
   * 🔴 画像モードではサイズ・色メトリクスが効かない。画像が塗りを埋めるので
   * 色は読めず、サイズは一定にする約束だから。設定は**消さずに無視**する
   * (丸に戻したときそのまま復帰する)。凡例も出さない。
   */
  scatterPointStyle?: ScatterPointStyle
  /** 画像モードの一定サイズ (#627)。未設定は 'medium'。 */
  scatterImageSize?:  ScatterImageSize
}

/** scatter の点の見た目 (#627)。 */
export type ScatterPointStyle = 'dot' | 'image'

/** 画像モードの一定サイズ (#627)。密集すると画像同士が重なるので選べるようにしている。 */
export type ScatterImageSize = 'small' | 'medium' | 'large'

/** 画像モードの一辺(px)。ドットと違い面積ではなく実寸で指定する。 */
export const SCATTER_IMAGE_PX: Record<ScatterImageSize, number> = {
  small:  20,
  medium: 30,
  large:  44,
}

export const SCATTER_IMAGE_SIZE_LABELS: Record<ScatterImageSize, string> = {
  small:  '小',
  medium: '中',
  large:  '大',
}

/** 点をブキ画像で描けるドット単位か (#627)。
 *
 * ブキ単位だけ。ステージ別・カテゴリ別の点にブキ画像が付いたら嘘になる。
 * バトル単位は 1 点 = 1 バトルでジッタも乗るため、画像だと潰れるので外す。
 *
 * (散布図のドット単位に味方ブキ・相手ブキは無い。棒グラフ等の `groupBy` にはある。) */
export function canScatterUseImages(dotUnit: ScatterDotUnit | undefined): boolean {
  return dotUnit === 'weapon'
}

/** 設定 UI と描画で同じ判定を使う (#627)。片方だけ変えると凡例が嘘になる。 */
export function isScatterImageMode(chart: CustomChart): boolean {
  return chart.shape === 'scatter'
    && chart.scatterPointStyle === 'image'
    && canScatterUseImages(chart.dotUnit)
}

/** shape='line' の系列メトリクス一覧を取り出す(#436)。
 *  `metrics` があれば優先し、無ければ旧形式の単一 `metric` を 1 要素の配列として解釈する。
 *  こうすることで既存の保存済みグラフ(`metric` のみ)は無変更で動く。 */
export function chartMetrics(chart: CustomChart): MetricKey[] {
  if (chart.metrics && chart.metrics.length) return chart.metrics
  return chart.metric ? [chart.metric] : []
}

/** 数値メトリクス bin 軸(ヒートマップで battle 単位の値を離散化)で使えるカラム (#134)。
 *  battle テーブルに直接ある INTEGER 列のみ(ratio や avg_ は集計後なので含めない)。 */
export type BattleNumericMetric =
  | 'kill'
  | 'death'
  | 'assist'
  | 'kill_or_assist'
  | 'special'
  | 'inked'
  | 'duration'

export const BATTLE_NUMERIC_METRIC_LABELS: Record<BattleNumericMetric, string> = {
  kill:            'キル数',
  death:           'デス数',
  assist:          'アシスト数',
  kill_or_assist:  '貢献キル',  // DB カラム名は kill_or_assist のまま(#465)
  special:         'スペシャル',
  inked:           '塗り',
  duration:        'バトル時間',
}

/** メトリクスごとの推奨 bin 幅(既定値)。 */
export const BATTLE_NUMERIC_DEFAULT_BIN: Record<BattleNumericMetric, number> = {
  kill:           1,
  death:          1,
  assist:         1,
  kill_or_assist: 1,
  special:        1,
  inked:          100,
  duration:       30,
}

/** 1 バトル単位の散布図で使えるメトリクス。
 *  並びは キル → アシスト → 貢献キル → デス → キルレ → 貢献キルレ(#465)。 */
export type BattleMetricKey =
  | 'kill'
  | 'assist'
  | 'contrib_kill'  // kill + assist
  | 'death'
  | 'kd'            // kill / death (D=0 は null)
  | 'contrib_kd'    // (kill + assist) / death (D=0 は null)
  | 'inked'
  | 'special'

export const BATTLE_METRIC_LABELS: Record<BattleMetricKey, string> = {
  kill:          'キル数',
  assist:        'アシスト数',
  contrib_kill:  '貢献キル',
  death:         'デス数',
  kd:            'キルレ',
  contrib_kd:    '貢献キルレ',
  inked:         '塗り',
  special:       'スペシャル',
}

/** scatter の 1 ドット単位。'battle' 以外は db_grouped_stats の groupBy と同じキー。 */
export type ScatterDotUnit =
  | 'battle'
  | 'weapon'
  | 'stage'
  | 'weapon_category'
  | 'sub_weapon'
  | 'special_weapon'

/** ChartConfigModal のドット単位選択肢(表示順)。 */
export const SCATTER_DOT_UNITS: ScatterDotUnit[] = [
  'battle', 'weapon', 'stage', 'weapon_category', 'sub_weapon', 'special_weapon',
]

/** カテゴリ集計単位の散布図で使えるメトリクス(ブキ / ステージ / サブ / スペシャル / ブキカテゴリ共通)。
 *  負数は DB 列ではなく total − wins − draws。 */
export type ScatterAggMetricKey = MetricKey | 'losses'

export const SCATTER_AGG_METRIC_KEYS: ScatterAggMetricKey[] = [
  'total', 'wins', 'losses', 'win_rate',
  'avg_kill', 'avg_assist', 'avg_contrib_kill', 'avg_death', 'avg_kd', 'avg_contrib_kd',
  'avg_inked', 'avg_special',
]

/** 散布図でバトル数・勝数・負数の軸に共通のチップ行を使うキー。 */
export const SCATTER_WIN_COUNT_METRICS = new Set<string>(['total', 'wins', 'losses'])

export function scatterAggMetricLabel(key: string): string {
  if (key === 'losses') return '負数'
  return METRIC_LABELS[key as MetricKey] ?? key
}

export function scatterAggMetric(row: GroupedStatsRow, key: string): number | null {
  if (key === 'losses') return row.total > 0 ? row.total - row.wins - row.draws : null
  return getMetric(row, key as MetricKey)
}

/** 色スケール用。負数はバトル数と同じ count 扱い。 */
export function scatterAggColorMetric(key: string): MetricKey {
  return key === 'losses' ? 'total' : key as MetricKey
}

/** ドット単位ごとの「X 軸 / Y 軸 / サイズ」で選べるメトリクスキー一覧。 */
export function scatterMetricOptions(dotUnit: ScatterDotUnit): { key: string; label: string }[] {
  if (dotUnit === 'battle') {
    return (Object.keys(BATTLE_METRIC_LABELS) as BattleMetricKey[]).map(k => ({ key: k, label: BATTLE_METRIC_LABELS[k] }))
  }
  return SCATTER_AGG_METRIC_KEYS.map(k => ({ key: k, label: scatterAggMetricLabel(k) }))
}

/** 公式アプリ由来。ブキ軸のみ。フィルター（期間・ロビー・ルール）には追従しない。 */
export const OFFICIAL_WEAPON_METRICS: MetricKey[] = [
  'official_weapon_level', 'official_win_count', 'official_paint',
  'official_weapon_power', 'official_weapon_power_max', 'official_last_used_at',
]

/** 公式アプリのルール別通算勝率。ステージ軸のみ。 */
export const OFFICIAL_STAGE_METRICS: MetricKey[] = [
  'official_win_rate_tw', 'official_win_rate_ar', 'official_win_rate_lf',
  'official_win_rate_gl', 'official_win_rate_cl',
]

export const OFFICIAL_METRICS: MetricKey[] = [
  ...OFFICIAL_WEAPON_METRICS,
  ...OFFICIAL_STAGE_METRICS,
]

export function officialMetricsForGroup(group: string): MetricKey[] {
  if (group === 'weapon') return OFFICIAL_WEAPON_METRICS
  if (group === 'stage') return OFFICIAL_STAGE_METRICS
  return []
}

export function isOfficialRateMetric(metric: string): boolean {
  return metric === 'win_rate' || metric.startsWith('official_win_rate_')
}

/** ヒートマップ用の 2D 集計行(db_grouped_stats_2d の返り値)。 */
export interface GroupedStatsRow2D {
  key_x:        string
  key_y:        string
  name_x:       string
  name_y:       string
  total:        number
  wins:         number
  draws:        number
  win_rate:     number
  avg_kill:     number | null
  avg_death:    number | null
  avg_assist:   number | null
  avg_special:  number | null
  avg_inked:    number | null
}

/** GroupedStatsRow2D から指定メトリクスの値を取り出す。
 *  `avg_kd` / `avg_contrib_*` / `sum_contrib_kill` は計算合成(#465)。 */
export function getMetric2D(row: GroupedStatsRow2D, metric: MetricKey): number | null {
  switch (metric) {
    case 'total':        return row.total
    case 'wins':         return row.wins
    case 'win_rate':     return row.win_rate
    case 'avg_kill':     return row.avg_kill
    case 'avg_assist':   return row.avg_assist
    case 'avg_contrib_kill':
      if (row.avg_kill === null || row.avg_assist === null) return null
      return row.avg_kill + row.avg_assist
    case 'avg_death':    return row.avg_death
    case 'avg_kd':
      if (row.avg_kill === null || row.avg_death === null) return null
      if (row.avg_death === 0) return null
      return row.avg_kill / row.avg_death
    case 'avg_contrib_kd':
      if (row.avg_kill === null || row.avg_assist === null || row.avg_death === null) return null
      if (row.avg_death === 0) return null
      return (row.avg_kill + row.avg_assist) / row.avg_death
    case 'avg_special':  return row.avg_special
    case 'avg_inked':    return row.avg_inked
    // 合計系メトリクスは 2D クロス集計では返さない(GroupedStatsRow2D に列がない)。
    case 'sum_kill':
    case 'sum_death':
    case 'sum_assist':
    case 'sum_contrib_kill':
    case 'sum_inked':    return null
    case 'official_weapon_level':
    case 'official_win_count':
    case 'official_paint':
    case 'official_weapon_power':
    case 'official_weapon_power_max':
    case 'official_last_used_at':
    case 'official_win_rate_tw':
    case 'official_win_rate_ar':
    case 'official_win_rate_lf':
    case 'official_win_rate_gl':
    case 'official_win_rate_cl':
      return null
  }
}

/** UI ラベル。 */
export const CHART_SHAPE_LABELS: Record<ChartShape, string> = {
  bar:              '棒グラフ',
  line:             '線グラフ',
  scatter:          '散布図',
  heatmap:          'ヒートマップ',
  calendar_heatmap: 'カレンダー',
}

export const Y_COMPOSITION_LABELS: Record<YComposition, string> = {
  single_metric:   '単一メトリクス',
  stacked_winrate: 'バトル数 & 勝率',
  attack_defense:  'キル vs デス',
}

/** 実装済みの shape。それ以外は UI で disabled。
 *  v1.0.0: bar / line / calendar_heatmap / heatmap / scatter。 */
export const IMPLEMENTED_SHAPES: ChartShape[] = ['bar', 'line', 'calendar_heatmap', 'heatmap', 'scatter']

/**
 * メトリクスを「色スケールのグループ」に分類する。
 * - count: バトル数・勝数。相対 max-based。
 * - rate:  勝率。固定 0–100% (45–55% をくすみ黄緑中央とした divergent)。
 * - average: K/D/A・スペシャル・塗り。相対 min-max。
 */
export type MetricGroup = 'count' | 'rate' | 'average'
export function metricGroup(metric: MetricKey): MetricGroup {
  if (metric === 'total' || metric === 'wins')                  return 'count'
  if (metric === 'sum_kill' || metric === 'sum_death' ||
      metric === 'sum_assist' || metric === 'sum_contrib_kill' ||
      metric === 'sum_inked')                                   return 'count'
  if (metric === 'win_rate' || metric.startsWith('official_win_rate_')) return 'rate'
  if (OFFICIAL_METRICS.includes(metric)) return 'count'
  return 'average'
}

/**
 * メトリクスを「折れ線グラフの軸グループ」に分類する(#436)。
 *
 * ヒートマップ・カレンダーの色スケール分類({@link metricGroup})とは別系統。
 * こちらは「同じ Y 軸に同居できるか」を値域・単位で決める 4 分類：
 * - per_battle: 平均キル/デス/アシスト/SP・キルレ。0~15 程度の回数系。
 * - win_rate:   勝率。0~100% 固定域。
 * - count:      バトル数・勝数・キル/デス/アシスト合計。期間依存の整数。
 * - paint:      平均塗り・塗りP合計。数百~千 P。
 *
 * キルレ (avg_kd) ・貢献キルレ (avg_contrib_kd) は厳密には無次元比だが、
 * 値域が per_battle と同オーダーなので同居させる。貢献キルも同様。
 */
export type AxisGroup = 'per_battle' | 'win_rate' | 'count' | 'paint'
export const AXIS_GROUP_LABELS: Record<AxisGroup, string> = {
  per_battle: '回/バトル',
  win_rate:   '勝率',
  count:      'カウント',
  paint:      '塗り',
}
export function axisGroupOf(metric: MetricKey): AxisGroup {
  if (metric === 'win_rate' || metric.startsWith('official_win_rate_')) return 'win_rate'
  if (metric === 'avg_inked' || metric === 'sum_inked' || metric === 'official_paint') return 'paint'
  if (metric === 'total' || metric === 'wins' ||
      metric === 'sum_kill' || metric === 'sum_death' ||
      metric === 'sum_assist' || metric === 'sum_contrib_kill' ||
      metric === 'official_win_count' || metric === 'official_weapon_level' ||
      metric === 'official_weapon_power' || metric === 'official_weapon_power_max' ||
      metric === 'official_last_used_at') return 'count'
  return 'per_battle'  // avg_kill / avg_assist / avg_contrib_kill / avg_death / avg_kd / avg_contrib_kd / avg_special
}

/** v1.0.0 で実装済みの yComposition(全 shape 共通で扱う最大集合)。 */
export const IMPLEMENTED_Y_COMPOSITIONS: YComposition[] = ['single_metric', 'stacked_winrate', 'attack_defense']

/**
 * 軸の選択から自動生成するグラフタイトル。「{X 軸ラベル}別 {Y 軸ラベル}」形式。
 *
 * - single_metric → メトリクス名(「平均キル」「勝率」など)
 * - stacked_winrate → 「バトル数 & 勝率」(既存の固定 4 グラフと表記を揃える)
 * - attack_defense → 「攻撃 vs デス」
 *
 * ユーザーが ChartConfigModal でタイトル入力を空にしたとき、これを使って自動採用する。
 */
export function autoChartTitle(spec: {
  shape?:           ChartShape
  groupBy:          GroupByKey
  groupBy2?:        GroupByKey
  yComposition:     YComposition
  metric?:          MetricKey
  /** shape='line' の複数系列(#436)。指定があれば metric より優先する。 */
  metrics?:         MetricKey[]
  dotUnit?:         ScatterDotUnit
  xMetric?:         string
  yMetric?:         string
  xNumericMetric?:  BattleNumericMetric
  yNumericMetric?:  BattleNumericMetric
  xBinWidth?:       number
  yBinWidth?:       number
}): string {
  const metricLabel = spec.metric ? METRIC_LABELS[spec.metric] : 'メトリクス'

  if (spec.shape === 'calendar_heatmap') {
    return `${metricLabel} カレンダー`
  }
  if (spec.shape === 'heatmap') {
    // 数値メトリクス bin 軸(#134)はラベルを置換。bin 幅を併記する。
    const x = spec.xNumericMetric
      ? `${BATTLE_NUMERIC_METRIC_LABELS[spec.xNumericMetric]} (bin ${spec.xBinWidth ?? BATTLE_NUMERIC_DEFAULT_BIN[spec.xNumericMetric]})`
      : GROUP_BY_LABELS[spec.groupBy]
    const y = spec.yNumericMetric
      ? `${BATTLE_NUMERIC_METRIC_LABELS[spec.yNumericMetric]} (bin ${spec.yBinWidth ?? BATTLE_NUMERIC_DEFAULT_BIN[spec.yNumericMetric]})`
      : spec.groupBy2 ? GROUP_BY_LABELS[spec.groupBy2] : '?'
    return `${x} × ${y}: ${metricLabel}`
  }
  if (spec.shape === 'scatter') {
    const unit = spec.dotUnit === 'battle'
      ? 'バトル'
      : spec.dotUnit
        ? GROUP_BY_LABELS[spec.dotUnit]
        : GROUP_BY_LABELS.weapon
    const labelOf = (k?: string): string => {
      if (!k) return '?'
      if (k in BATTLE_METRIC_LABELS) return BATTLE_METRIC_LABELS[k as BattleMetricKey]
      if (k in METRIC_LABELS) return METRIC_LABELS[k as MetricKey]
      return k
    }
    return `${unit}別 ${labelOf(spec.yMetric)} × ${labelOf(spec.xMetric)}`
  }
  if (spec.shape === 'line') {
    const bucket = GROUP_BY_LABELS[spec.groupBy]
    const list = spec.metrics && spec.metrics.length ? spec.metrics : (spec.metric ? [spec.metric] : [])
    const label = list.length ? list.map(m => METRIC_LABELS[m]).join('・') : metricLabel
    return `${label} の推移 (${bucket})`
  }

  // bar (デフォルト)
  const xLabel = GROUP_BY_LABELS[spec.groupBy]
  const yLabel =
    spec.yComposition === 'single_metric'   ? metricLabel
    : spec.yComposition === 'stacked_winrate' ? 'バトル数 & 勝率'
    :                                            'キル vs デス'
  return `${xLabel}別 ${yLabel}`
}

/** db_grouped_stats の返却 1 行分。
 *  `avg_*` は detail_fetched=1 のバトルだけで集計しているため、未取得しかない場合は null。
 *
 *  `knockout_win` / `knockout_lose` は battle.is_knockout (1/0/NULL) ベースで集計した
 *  自チーム KO 勝ち数 / 被 KO 負け数。時間切れ (NULL) は両方とも 0 になる。 */
export interface GroupedStatsRow {
  key:           string
  name:          string
  total:         number
  wins:          number
  draws:         number
  win_rate:      number
  knockout_win:  number
  knockout_lose: number
  avg_kill:      number | null
  avg_death:     number | null
  avg_assist:    number | null
  avg_special:   number | null
  avg_inked:     number | null
  sum_kill:      number | null
  sum_death:     number | null
  sum_assist:    number | null
  sum_inked:     number | null
  /** 公式アプリ。ブキ軸以外は null。 */
  official_weapon_level?:     number | null
  official_win_count?:        number | null
  official_paint?:            number | null
  official_weapon_power?:     number | null
  official_weapon_power_max?: number | null
  official_last_used_at?:     number | null
  /** 公式アプリ。ステージ軸以外は null。 */
  official_win_rate_tw?: number | null
  official_win_rate_ar?: number | null
  official_win_rate_lf?: number | null
  official_win_rate_gl?: number | null
  official_win_rate_cl?: number | null
}

/** UI 表示用のラベル。 */
export const GROUP_BY_LABELS: Record<GroupByKey, string> = {
  weapon:          'ブキ',
  stage:           'ステージ',
  rule:            'ルール',
  mode:            'ロビー',
  sub_weapon:      'サブ',
  special_weapon:  'スペシャル',
  weapon_category: 'ブキカテゴリ',
  result:          '結果',
  ally_weapon:     '味方ブキ',
  enemy_weapon:    '相手ブキ',
  day:             '日',
  three_day:       '3 日',
  week:            '週',
  month:           '月',
}

/** ブキ名・味方ブキ・相手ブキ。件数の上位 N を切る対象。 */
export function isWeaponGroupBy(g: string | undefined): boolean {
  return g === 'weapon' || g === 'ally_weapon' || g === 'enemy_weapon'
}

/** scatter のドット単位ラベル(GROUP_BY_LABELS と battle のみ例外)。 */
export function scatterDotUnitLabel(dotUnit: ScatterDotUnit): string {
  return dotUnit === 'battle' ? 'バトル' : GROUP_BY_LABELS[dotUnit]
}

export const METRIC_LABELS: Record<MetricKey, string> = {
  total:             'バトル数',
  wins:              '勝数',
  win_rate:          '勝率',
  avg_kill:          '平均キル',
  avg_assist:        '平均アシスト',
  avg_contrib_kill:  '平均貢献キル',
  avg_death:         '平均デス',
  avg_kd:            'キルレ',
  avg_contrib_kd:    '貢献キルレ',
  avg_special:       '平均SP',
  avg_inked:         '平均塗り',
  sum_kill:          'キル数(合計)',
  sum_assist:        'アシスト数(合計)',
  sum_contrib_kill:  '貢献キル(合計)',
  sum_death:         'デス数(合計)',
  sum_inked:         '塗りP(合計)',
  official_weapon_level:      '熟練度',
  official_win_count:         '通算勝利',
  official_paint:             '通算塗りP',
  official_weapon_power:      'ブキチャレパワー',
  official_weapon_power_max:  '最大ブキチャレパワー',
  official_last_used_at:      '最終使用日',
  official_win_rate_tw:       '公式勝率 ナワバリ',
  official_win_rate_ar:       '公式勝率 エリア',
  official_win_rate_lf:       '公式勝率 ヤグラ',
  official_win_rate_gl:       '公式勝率 ホコ',
  official_win_rate_cl:       '公式勝率 アサリ',
}

/** 折れ線・ヒートマップ・カレンダーなど、公式値を出さないセレクト用。 */
export const LOCAL_METRIC_KEYS: MetricKey[] =
  (Object.keys(METRIC_LABELS) as MetricKey[]).filter(k => !OFFICIAL_METRICS.includes(k))

/**
 * 合計系メトリクス。2D クロス集計(GroupedStatsRow2D)には列が無く、
 * getMetric2D が必ず null を返すため、ヒートマップでは選択させない(#351)。
 * カレンダー・折れ線は GroupedStatsRow に列があるので従来どおり使える。
 */
export const SUM_METRICS: MetricKey[] = [
  'sum_kill', 'sum_assist', 'sum_contrib_kill', 'sum_death', 'sum_inked',
]

/** ヒートマップ(2D クロス集計)で選べるメトリクス。合計系を除いたもの(#351)。 */
export const HEATMAP_METRICS = LOCAL_METRIC_KEYS.filter(m => !SUM_METRICS.includes(m))

/** GroupedStatsRow から指定メトリクスの数値を取り出す。NULL は null を返す。
 *  `avg_kd` / `avg_contrib_*` / `sum_contrib_kill` はクライアント側で算出(#465)。 */
export function getMetric(row: GroupedStatsRow, metric: MetricKey): number | null {
  switch (metric) {
    case 'total':        return row.total
    case 'wins':         return row.wins
    case 'win_rate':     return row.win_rate
    case 'avg_kill':     return row.avg_kill
    case 'avg_assist':   return row.avg_assist
    case 'avg_contrib_kill':
      if (row.avg_kill === null || row.avg_assist === null) return null
      return row.avg_kill + row.avg_assist
    case 'avg_death':    return row.avg_death
    case 'avg_kd':
      if (row.avg_kill === null || row.avg_death === null) return null
      if (row.avg_death === 0) return null
      return row.avg_kill / row.avg_death
    case 'avg_contrib_kd':
      if (row.avg_kill === null || row.avg_assist === null || row.avg_death === null) return null
      if (row.avg_death === 0) return null
      return (row.avg_kill + row.avg_assist) / row.avg_death
    case 'avg_special':  return row.avg_special
    case 'avg_inked':    return row.avg_inked
    case 'sum_kill':     return row.sum_kill
    case 'sum_assist':   return row.sum_assist
    case 'sum_contrib_kill':
      if (row.sum_kill === null || row.sum_assist === null) return null
      return row.sum_kill + row.sum_assist
    case 'sum_death':    return row.sum_death
    case 'sum_inked':    return row.sum_inked
    case 'official_weapon_level':      return row.official_weapon_level ?? null
    case 'official_win_count':         return row.official_win_count ?? null
    case 'official_paint':             return row.official_paint ?? null
    case 'official_weapon_power':      return row.official_weapon_power ?? null
    case 'official_weapon_power_max':  return row.official_weapon_power_max ?? null
    case 'official_last_used_at':      return row.official_last_used_at ?? null
    case 'official_win_rate_tw':       return row.official_win_rate_tw ?? null
    case 'official_win_rate_ar':       return row.official_win_rate_ar ?? null
    case 'official_win_rate_lf':       return row.official_win_rate_lf ?? null
    case 'official_win_rate_gl':       return row.official_win_rate_gl ?? null
    case 'official_win_rate_cl':       return row.official_win_rate_cl ?? null
  }
}

/** メトリクス値の表示文字列。勝率は %、それ以外は小数 2 桁。 */
export function formatMetric(value: number | null, metric: MetricKey): string {
  if (value === null) return '-'
  if (metric === 'win_rate' || metric.startsWith('official_win_rate_')) return `${(value * 100).toFixed(1)}%`
  if (metric === 'official_last_used_at') return fmtOfficialDate(value)
  if (metric === 'total' || metric === 'wins' ||
      metric === 'sum_kill' || metric === 'sum_death' ||
      metric === 'sum_assist' || metric === 'sum_contrib_kill' || metric === 'sum_inked' ||
      metric === 'official_weapon_level' || metric === 'official_win_count' ||
      metric === 'official_paint' || metric === 'official_weapon_power' ||
      metric === 'official_weapon_power_max') return Math.round(value).toLocaleString()
  return value.toFixed(2)
}
