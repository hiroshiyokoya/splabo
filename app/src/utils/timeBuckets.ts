import type { GroupByKey, GroupedStatsRow } from '../types'

/**
 * 折れ線グラフの X 軸を「実時間軸」にするためのバケット補完（#436）。
 *
 * `db_grouped_stats` は時系列バケット（day/three_day/week/month）でも、
 * バトルが 1 件もないバケットの行を返さない。カテゴリ軸（等間隔インデックス）で
 * 描くと、プレイしていない期間が詰まって実際より短く見える。
 *
 * ここでは group_by の粒度に合わせて「存在するはずのバケット」を全て列挙し、
 * データが無いバケットは `row: null` で埋める。これにより：
 * - X 軸を timestamp の number 軸にしたとき、欠測期間ぶんの距離が正しく開く
 * - `connectNulls={false}` で欠測バケットの前後に線を引かない（孤立バケットは点だけ）
 * - バトルが 1 件でもあるバケット（期間が満ちていない端数バケットも含む）はそのまま点になる
 *   （BE が返す時点で「ゼロ件の欠測」以外は行が存在するため、追加の対応は不要）
 */

const DAY_MS = 24 * 60 * 60 * 1000

/** 時系列バケットの 1 ステップぶんの日数。month のみ可変長なので呼び出し側で個別に進める。 */
function stepDays(groupBy: GroupByKey): number {
  switch (groupBy) {
    case 'day':       return 1
    case 'three_day': return 3
    case 'week':      return 7
    default:          return 1
  }
}

/** バケットキー文字列（BE の `name`）を UTC の Date に変換する。
 *  - day / three_day: そのまま ISO 日付（'YYYY-MM-DD'）
 *  - month:           月初日（'YYYY-MM'）
 *  - week:            `strftime('%Y-W%W', ...)` 相当。月曜始まり、年始で最初の月曜より前は週 00。 */
export function parseBucketDate(key: string, groupBy: GroupByKey): Date {
  if (groupBy === 'month') {
    const m = key.match(/^(\d{4})-(\d{2})$/)
    if (!m) return new Date(NaN)
    return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1))
  }
  if (groupBy === 'week') {
    const m = key.match(/^(\d{4})-W(\d{2})$/)
    if (!m) return new Date(NaN)
    const year = Number(m[1])
    const week = Number(m[2])
    const jan1 = Date.UTC(year, 0, 1)
    const jan1Dow = new Date(jan1).getUTCDay() // 0=Sun … 6=Sat
    const daysUntilFirstMonday = (8 - jan1Dow) % 7
    if (week === 0) return new Date(jan1)
    return new Date(jan1 + daysUntilFirstMonday * DAY_MS + (week - 1) * 7 * DAY_MS)
  }
  // day / three_day: リテラルな ISO 日付
  return new Date(`${key}T00:00:00Z`)
}

/** Date → バケットキー文字列（parseBucketDate の逆変換。week の往復整合性を保つため同じ規則を使う）。 */
export function bucketKeyOf(d: Date, groupBy: GroupByKey): string {
  if (groupBy === 'month') {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
  }
  if (groupBy === 'week') {
    const year = d.getUTCFullYear()
    const jan1 = Date.UTC(year, 0, 1)
    const jan1Dow = new Date(jan1).getUTCDay()
    const daysUntilFirstMonday = (8 - jan1Dow) % 7
    const firstMondayMs = jan1 + daysUntilFirstMonday * DAY_MS
    if (d.getTime() < firstMondayMs) return `${year}-W00`
    const week = Math.floor((d.getTime() - firstMondayMs) / (7 * DAY_MS)) + 1
    return `${year}-W${String(week).padStart(2, '0')}`
  }
  return d.toISOString().slice(0, 10)
}

/** バケット 1 個ぶん先の Date を返す。month だけ暦月単位で進める（可変長日数）。 */
export function nextBucketDate(d: Date, groupBy: GroupByKey): Date {
  if (groupBy === 'month') {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))
  }
  return new Date(d.getTime() + stepDays(groupBy) * DAY_MS)
}

/** バケット期間の最終日（次バケット開始日の前日）を返す。ツールチップの期間表示に使う。 */
export function bucketEndDate(d: Date, groupBy: GroupByKey): Date {
  return new Date(nextBucketDate(d, groupBy).getTime() - DAY_MS)
}

export interface TimeSeriesSlot {
  /** バケット開始日時（UTC ms epoch）。X 軸の numeric dataKey に使う。 */
  t:   number
  /** そのバケットのデータ。存在しない（バトル 0 件）ときは null。 */
  row: GroupedStatsRow | null
}

/**
 * 時系列バケットの GroupedStatsRow[] を、欠測バケットを null 埋めした連続スロット列に変換する。
 * データが 1 件も無ければ空配列を返す。
 */
export function buildTimeSeries(data: GroupedStatsRow[], groupBy: GroupByKey): TimeSeriesSlot[] {
  if (data.length === 0) return []
  const sorted = [...data].sort((a, b) => a.name.localeCompare(b.name))
  const byKey = new Map(sorted.map(d => [d.name, d]))
  const first = parseBucketDate(sorted[0].name, groupBy)
  const last  = parseBucketDate(sorted[sorted.length - 1].name, groupBy)
  if (isNaN(first.getTime()) || isNaN(last.getTime())) return []

  const out: TimeSeriesSlot[] = []
  let cur = first
  let guard = 0
  const GUARD_MAX = 10_000  // 安全弁。通常のデータ量では到達しない。
  while (cur.getTime() <= last.getTime() && guard++ < GUARD_MAX) {
    const key = bucketKeyOf(cur, groupBy)
    out.push({ t: cur.getTime(), row: byKey.get(key) ?? null })
    cur = nextBucketDate(cur, groupBy)
  }
  return out
}

/** X 軸ティック用の短い日付表示（月/日）。 */
export function formatTickDate(t: number): string {
  const d = new Date(t)
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`
}

/** ツールチップ用のバケット期間表示。1 日ぶんのバケット（day）は単日、それ以外は期間表示。 */
export function formatBucketLabel(t: number, groupBy: GroupByKey): string {
  const start = new Date(t)
  if (groupBy === 'day') return formatTickDate(t)
  if (groupBy === 'month') return `${start.getUTCFullYear()}/${start.getUTCMonth() + 1}`
  const end = bucketEndDate(start, groupBy)
  return `${formatTickDate(start.getTime())}~${formatTickDate(end.getTime())}`
}
