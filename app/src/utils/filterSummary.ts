/**
 * 絞り込み条件を 1 行のテキストにまとめる（#500）。
 *
 * パネルを画像として保存すると、画面上部の FilterBar は写らない。
 * 条件が分からない画像は共有しても意味が無いので、画像側に焼き込む文字列をここで作る。
 * 画像内で 1〜2 行に収める必要があるため、多値は先頭数件＋「他 N 件」に丸める。
 */
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { Filters, Period } from '../types'
import { resultLabel } from '../types'

/** FilterBar と表示を揃えるための選択肢定義。UI とキャプションで文言をぶらさない。 */
export const PERIOD_OPTIONS: { id: Period; label: string }[] = [
  { id: 'all',            label: '全期間' },
  { id: 'current_season', label: '今シーズン' },
  { id: '1y',             label: '1年' },
  { id: '180d',           label: '180日' },
  { id: '30d',            label: '30日' },
  { id: '7d',             label: '7日' },
  { id: 'custom',         label: 'カスタム' },
]

/** モード（ロビー）。キーは lobby.key に一致させる。 */
export const LOBBY_OPTIONS = [
  { key: 'regular',             label: 'レギュラー' },
  { key: 'bankara_open',        label: 'バンカラ(オープン)' },
  { key: 'bankara_challenge',   label: 'バンカラ(チャレンジ)' },
  { key: 'xmatch',              label: 'Xマッチ' },
  { key: 'splatfest_open',      label: 'フェス(オープン)' },
  { key: 'splatfest_challenge', label: 'フェス(チャレンジ)' },
  { key: 'event',               label: 'イベント' },
]

export const RULE_OPTIONS = [
  { key: 'turf_war', label: 'ナワバリ' },
  { key: 'area',     label: 'ガチエリア' },
  { key: 'yagura',   label: 'ガチヤグラ' },
  { key: 'hoko',     label: 'ガチホコ' },
  { key: 'asari',    label: 'ガチアサリ' },
]

const LOBBY_LABEL = new Map(LOBBY_OPTIONS.map(o => [o.key, o.label]))
const RULE_LABEL  = new Map(RULE_OPTIONS.map(o => [o.key, o.label]))
const PERIOD_LABEL = new Map(PERIOD_OPTIONS.map(o => [o.id, o.label]))

/** 画像内で 1 項目に並べる値の上限。これを超えたら「他 N 件」に畳む。 */
const MAX_VALUES = 3

export function joinValues(values: string[]): string {
  if (values.length <= MAX_VALUES) return values.join('・')
  return `${values.slice(0, MAX_VALUES).join('・')} 他${values.length - MAX_VALUES}件`
}

/** `ラベル: 値` の並び。値が無い項目は落とす。 */
export function joinConditions(parts: [string, string | null][]): string {
  const kept = parts.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`)
  return kept.length ? kept.join('　/　') : '絞り込みなし'
}

function periodText(f: Filters): string {
  if (f.period === 'custom') {
    const from = f.customFrom ?? '—'
    const to   = f.customTo ?? '—'
    return `${from}〜${to}`
  }
  return PERIOD_LABEL.get(f.period) ?? f.period
}

/** ダッシュボードなど FilterBar 配下の画面の条件テキスト。 */
export function describeFilters(f: Filters, stageNames?: Map<string, string>): string {
  return joinConditions([
    ['期間',     periodText(f)],
    ['ロビー',   f.mode.length ? joinValues(f.mode.map(k => LOBBY_LABEL.get(k) ?? k)) : null],
    ['ルール',   f.rule.length ? joinValues(f.rule.map(k => RULE_LABEL.get(k) ?? k)) : null],
    ['武器',     f.weapon.length ? joinValues(f.weapon) : null],
    ['ステージ', f.stage.length ? joinValues(f.stage.map(id => stageNames?.get(id) ?? id)) : null],
    ['結果',     f.result ? resultLabel(f.result) : null],
  ])
}

interface StageInfo { id: string; name: string }

// ステージ名は取得済みバトルから引くだけで変化が遅いので、モジュール内で使い回す。
let stageNameCache: Map<string, string> | null = null

/** ステージ ID → 表示名。条件テキストで ID がそのまま出るのを防ぐ。 */
export function useStageNames(): Map<string, string> {
  const [names, setNames] = useState<Map<string, string>>(() => stageNameCache ?? new Map())
  useEffect(() => {
    if (stageNameCache) return
    let alive = true
    invoke<StageInfo[]>('db_stages_used')
      .then(list => {
        stageNameCache = new Map(list.map(s => [s.id, s.name]))
        if (alive) setNames(stageNameCache)
      })
      .catch(() => { /* 名前が引けなければ ID のまま出す */ })
    return () => { alive = false }
  }, [])
  return names
}
