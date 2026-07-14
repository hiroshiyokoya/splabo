// 図鑑の一覧ビュー（#297）で使う、クリックで並び替えできるテーブルヘッダセル。
// 武器図鑑・ステージ図鑑で共用する。
//
// 並び順は各図鑑の compareRows が返す「自然な向き」（例: バトル数は多い順、
// 平均D は少ない順、名前は五十音順）を基準にし、同じ列をもう一度クリックすると
// `reversed` で反転する。

interface Props<K extends string> {
  label: string
  /** 省略した列は並び替え不可（K/D など派生値）。 */
  sortKey?: K
  activeKey: K
  /** アクティブ列の実際の並び方向。矢印（▲昇順 / ▼降順）はこれに従う。 */
  ascending: boolean
  onSort: (key: K) => void
  align?: 'left' | 'right'
}

export function SortHeader<K extends string>({
  label,
  sortKey,
  activeKey,
  ascending,
  onSort,
  align = 'right',
}: Props<K>) {
  if (!sortKey) {
    return <th className={`book-th book-th--${align}`}>{label}</th>
  }

  const active = sortKey === activeKey
  return (
    <th
      className={`book-th book-th--${align} book-th--sortable${active ? ' book-th--active' : ''}`}
      aria-sort={active ? (ascending ? 'ascending' : 'descending') : 'none'}
      tabIndex={0}
      onClick={() => onSort(sortKey)}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSort(sortKey) }
      }}
    >
      {label}
      <span className="book-th__arrow" aria-hidden="true">
        {active ? (ascending ? '▲' : '▼') : ''}
      </span>
    </th>
  )
}
