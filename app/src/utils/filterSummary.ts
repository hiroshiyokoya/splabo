/**
 * 絞り込み条件を 1 行のテキストにまとめる(#500 / #506)。
 *
 * パネルを画像として保存すると、画面上部の FilterBar は写らない。
 * 条件が分からない画像は共有しても意味が無いので、画像側に焼き込む文字列をここで作る。
 * 画像内で 1~2 行に収める必要があるため、多値は先頭数件＋「他 N 件」に丸める。
 *
 * 期間は相対プリセット名(今シーズン 等)ではなく絶対日付にする(#506)。
 * UI の FilterBar 表示は触らない。
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { invoke } from '@tauri-apps/api/core'
import type { Filters, Period } from '../types'
import { filtersToRange, resultLabel } from '../types'
import { stageInfoDisplayName, localizedName } from '../i18n/displayName'
import i18n from '../i18n'

/**
 * FilterBar と表示を揃えるための選択肢定義。
 * 表示ラベルは常に呼び出し側で `t('filter.xxx_${key}')` を引く(#689)ので、
 * ここには locale キーの元になる `id`/`key` だけを持つ。
 */
export const PERIOD_OPTIONS: { id: Period }[] = [
  { id: 'all' },
  // 🔴 'current_season' と 'season' はボタンではなくシーズンのプルダウンで選ぶ（#585）。
  // ここに並べるとボタンとプルダウンで同じものが 2 つ出るため入れない。
  { id: '1y' },
  { id: '180d' },
  { id: '30d' },
  { id: '7d' },
  { id: 'custom' },
]

/** モード(ロビー)。キーは lobby.key に一致させる。 */
export const LOBBY_OPTIONS = [
  { key: 'regular' },
  { key: 'bankara_open' },
  { key: 'bankara_challenge' },
  { key: 'xmatch' },
  { key: 'splatfest_open' },
  { key: 'splatfest_challenge' },
  { key: 'event' },
]

export const RULE_OPTIONS = [
  { key: 'turf_war' },
  { key: 'area' },
  { key: 'yagura' },
  { key: 'hoko' },
  { key: 'asari' },
]

/** 画像内で 1 項目に並べる値の上限。これを超えたら「他 N 件」に畳む。 */
const MAX_VALUES = 3

/**
 * 1 項目の中で複数選択した値の並び。
 *
 * 区切りは `, `。項目の区切り(` / `)と同じ記号にすると「ロビーの 2 つ目の値」と
 * 「次の項目」の区別が付かない(#556)。
 */
const VALUE_SEP = ', '

export function joinValues(values: string[]): string {
  if (values.length <= MAX_VALUES) return values.join(VALUE_SEP)
  return `${values.slice(0, MAX_VALUES).join(VALUE_SEP)}${VALUE_SEP}${i18n.t('chart.moreItems', { count: values.length - MAX_VALUES })}`
}

/** `ラベル: 値` の並び。値が無い項目は落とす。 */
export function joinConditions(parts: [string, string | null][]): string {
  const kept = parts.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`)
  // 区切りは半角スペース + 半角スラッシュ(全角スペースや全角/は使わない)
  return kept.length ? kept.join(' / ') : i18n.t('env.noFilters')
}

/** ローカル日付の `YYYY-MM-DD`(保存キャプションの「今日」)。 */
export function localIsoDate(now = new Date()): string {
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-')
}

/**
 * クエリに効いている since/until を保存用の絶対日付にする(#506)。
 *
 * - 両方 null … `全期間`
 * - until だけ無い … 終端を「今日」(ダッシュボードの相対プリセット)
 * - since だけ無い … `~until`(稀)
 */
export function formatAbsolutePeriodRange(
  since: string | null,
  until: string | null,
  now = new Date(),
): string {
  if (!since && !until) return i18n.t('filter.allPeriod')
  const end = until || localIsoDate(now)
  if (!since) return `~${end}`
  return `${since}~${end}`
}

/** 保存キャプション用の期間文言。UI プリセット名は使わない。 */
function periodText(f: Filters, now = new Date()): string {
  if (f.period === 'all') return i18n.t('filter.allPeriod')
  // シーズンだけは名前を出す(#585)。「今シーズン」のような相対名と違い、
  // シーズン名は後から見ても一意に決まるので日付に開く必要がない。
  if (f.period === 'season' && f.seasonName) {
    return `${f.seasonName} (${f.customFrom ?? '-'}~${f.customTo ?? '-'})`
  }
  if (f.period === 'custom') {
    return `${f.customFrom ?? '-'}~${f.customTo ?? '-'}`
  }
  const { since, until } = filtersToRange(f)
  return formatAbsolutePeriodRange(since, until, now)
}

/**
 * 保存画像のキャプションを組む(#553 / #554)。
 *
 * 順序は **先頭要素 → 絞り込み条件 → 該当バトル数**。件数は末尾。
 * 条件が長いときは CSS 側で折り返す(打ち切らない)ので、件数を前へ寄せる必要はない。
 *
 * `source` は環境分析の `出典: stat.ink` のような画面固有の先頭要素。
 * `count` が null のとき(データ未取得など)は件数を出さない。
 */
export function buildExportCaption(
  conditions: string,
  count: number | null,
  source?: string,
): string {
  return [
    source ?? '',
    conditions,
    count != null ? i18n.t('env.matchedBattles', { count: count.toLocaleString() }) : '',
  ].filter(Boolean).join(' / ')
}

/** ダッシュボードなど FilterBar 配下の画面の条件。`buildExportCaption` に渡す。
 *  `weaponEnByName` があれば `f.weapon`(日本語名の配列)を表示言語に合わせて訳す。 */
export function describeFilters(
  f: Filters,
  stageNames?: Map<string, string>,
  weaponEnByName?: Map<string, string | null | undefined>,
): string {
  return joinConditions([
    [i18n.t('filter.lobby'),  f.mode.length ? joinValues(f.mode.map(k => i18n.t(`filter.lobby_${k}`, { defaultValue: k }))) : null],
    [i18n.t('filter.period'), periodText(f)],
    [i18n.t('filter.rule'),   f.rule.length ? joinValues(f.rule.map(k => i18n.t(`filter.rule_${k}`, { defaultValue: k }))) : null],
    [i18n.t('filter.weapon'), f.weapon.length ? joinValues(f.weapon.map(name => localizedName(name, weaponEnByName?.get(name), name))) : null],
    [i18n.t('filter.stage'),  f.stage.length ? joinValues(f.stage.map(id => stageNames?.get(id) ?? id)) : null],
    [i18n.t('filter.result'), f.result ? resultLabel(f.result) : null],
  ])
}

interface StageInfo { id: string; name: string; name_ja?: string | null; name_en?: string | null }

// ステージ名は取得済みバトルから引くだけで変化が遅いので、モジュール内で使い回す。
let stageListCache: StageInfo[] | null = null

/** ステージ ID → 表示名。条件テキストで ID がそのまま出るのを防ぐ。 */
export function useStageNames(): Map<string, string> {
  const { i18n } = useTranslation()
  const [names, setNames] = useState<Map<string, string>>(() => {
    if (!stageListCache) return new Map()
    return new Map(stageListCache.map(s => [s.id, stageInfoDisplayName(s)]))
  })
  useEffect(() => {
    if (stageListCache) {
      setNames(new Map(stageListCache.map(s => [s.id, stageInfoDisplayName(s)])))
      return
    }
    let alive = true
    invoke<StageInfo[]>('db_stages_used')
      .then(list => {
        stageListCache = list
        const mapped = new Map(list.map(s => [s.id, stageInfoDisplayName(s)]))
        if (alive) setNames(mapped)
      })
      .catch(() => { /* 名前が引けなければ ID のまま出す */ })
    return () => { alive = false }
  }, [i18n.language])
  return names
}
