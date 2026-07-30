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
  /** 名指しで選んでいるシーズン名。選んでいなければ null。 */
  value: string | null
  /** 「今シーズン」（自動追従）が選ばれているか。期間ボタン側の状態。 */
  isCurrent: boolean
  /** シーズンを選んだ。null は「今シーズン」（自動追従）。 */
  onSelect: (season: Season | null) => void
  /** 無効化（読み込み中など）。 */
  disabled?: boolean
}

/** 「今シーズン」を表す内部値。シーズン名と衝突しない文字列にする。 */
const CURRENT = '__current__'

/**
 * プルダウンに出す短い名前。`Sizzle Season 2026` → `Sizzle 2026`。
 *
 * 期間ボタンの横に置くので、最長の選択肢の幅がそのままコントロールの幅になる。
 * `Season` は全項目に付いていて区別に寄与しないので落とす。
 * キャプションや AI へ渡すのは**元の名前のまま**（表示だけを縮める）。
 */
function shortName(name: string): string {
  return name.replace(' Season ', ' ')
}

export function SeasonSelect({ seasons, value, isCurrent, onSelect, disabled }: Props) {
  // データが無ければ選択肢も無いので出さない（空のプルダウンを置かない）。
  if (seasons.length === 0) return null

  // 期間ボタンで別の期間（30日 等）を選んでいる間は、どのシーズンも効いていない。
  // ここで「今シーズン」と表示すると、期間が二重に効いているように見える。
  const selected = value ?? (isCurrent ? CURRENT : '')

  return (
    <select
      // 🔴 選択中かどうかはクラスで持つ。React は select の value を属性に落とさないので、
      // CSS の [value=''] では判定できない。
      className={`season-select${selected ? ' active' : ''}`}
      value={selected}
      disabled={disabled}
      onChange={e => {
        const v = e.target.value
        onSelect(v === CURRENT ? null : seasons.find(s => s.name === v) ?? null)
      }}
      title="シーズンで絞り込む"
    >
      {/* 何も効いていないときだけ出る見出し。選び直せる項目ではない。 */}
      {!selected && <option value="" disabled>シーズン</option>}
      {/* 「今シーズン」は自動追従。一覧の最新と同じ期間を指すので、最新には印を付けない
          （同じものが 2 つ並んでいるように見える）。 */}
      <option value={CURRENT}>今シーズン</option>
      {seasons.map(s => (
        <option key={s.name} value={s.name}>{shortName(s.name)}</option>
      ))}
    </select>
  )
}
