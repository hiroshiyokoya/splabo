/**
 * シーズンを名指しで選ぶプルダウン（#585）。
 *
 * 「今シーズン」しか選べなかったので、過去のシーズンを見るには日付を手で入れるしかなかった。
 *
 * 🔴 **シーズンの計算はここに持たない。** 名前と日付範囲は Rust の `season.rs` が出す
 * （`list_seasons`）。ここは受け取った一覧を並べて、選ばれたものを返すだけ。
 * 同じ計算をフロントにも書くと、片方だけ直したときに画面と AI 分析でシーズンがずれる。
 */
import type { Season } from '../types'

interface Props {
  /** 選べるシーズン（**新しい順**）。データがある期間に重なるものだけが来る。 */
  seasons: Season[]
  /** 選択中のシーズン名。null なら「今シーズン」。 */
  value: string | null
  /** シーズンを選んだ。null は未選択に戻す。 */
  onSelect: (season: Season | null) => void
  /**
   * 未選択のときの表示。
   *
   * 呼び出し元で意味が違う。バトル・武器・ステージでは「今シーズン」ボタンの置き換えなので
   * `今シーズン`、環境分析は期間プルダウンに「今シーズン」が既にあるので `指定なし`。
   */
  emptyLabel?: string
  /** 無効化（読み込み中など）。 */
  disabled?: boolean
}

export function SeasonSelect({ seasons, value, onSelect, emptyLabel = '今シーズン', disabled }: Props) {
  // データが無ければ選択肢も無いので出さない（空のプルダウンを置かない）。
  if (seasons.length === 0) return null

  return (
    <select
      // 🔴 選択中かどうかはクラスで持つ。React は select の value を属性に落とさないので、
      // CSS の [value=''] では判定できない。
      className={`season-select${value ? ' active' : ''}`}
      value={value ?? ''}
      disabled={disabled}
      onChange={e => {
        const name = e.target.value
        onSelect(name ? seasons.find(s => s.name === name) ?? null : null)
      }}
      title="シーズンを選ぶ"
    >
      <option value="">{emptyLabel}</option>
      {seasons.map((s, i) => (
        <option key={s.name} value={s.name}>
          {/* 先頭が最新。今シーズンとの対応が分かるように印を付ける。 */}
          {s.name}{i === 0 ? '（今）' : ''}
        </option>
      ))}
    </select>
  )
}
