/** 複数選択ドロップダウン（#189 で導入 → #190 で共有化）。
 *  `<details>` でメニュー開閉を担い、各項目はチェックボックスでトグルする。
 *  選択ゼロ件で `allLabel`、1 件で項目名、2 件以上で「N 件選択」をサマリ表示。
 *  メニュー外クリックで閉じる（#475）。FilterBar の武器/ステージピッカーと同じ作法。
 *  `group` 付きオプションがあるときはカテゴリ見出しで一括選択できる（#523）。 */

import { useEffect, useRef } from 'react'

export interface MultiSelectOption {
  key: string
  label: string
  short?: string
  /** グループ見出し（武器カテゴリ等）。同じ値が連続するよう並べて渡す。 */
  group?: string
}

type GroupBlock = { name: string | undefined; items: MultiSelectOption[] }

function groupOptions(options: MultiSelectOption[]): GroupBlock[] {
  const blocks: GroupBlock[] = []
  for (const o of options) {
    const name = o.group || undefined
    const last = blocks[blocks.length - 1]
    if (last && (last.name || undefined) === name) {
      last.items.push(o)
    } else {
      blocks.push({ name, items: [o] })
    }
  }
  return blocks
}

export function MultiSelect({ label, allLabel, options, selected, onChange, loading = false }: {
  label:    string
  allLabel: string
  options:  MultiSelectOption[]
  selected: string[]
  onChange: (next: string[]) => void
  /**
   * 選択肢を取りに行っている最中か（#602）。
   *
   * 空のときに一律「選択肢がありません」と出していたので、**まだ来ていない**のと
   * **本当に無い**のが見分けられなかった。環境分析の武器は取得に時間がかかるため、
   * データはあるのに「ありません」と表示されていた。
   */
  loading?: boolean
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null)

  useEffect(() => {
    function handler(e: MouseEvent) {
      const el = detailsRef.current
      if (!el?.open) return
      if (el.contains(e.target as Node)) return
      el.open = false
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const toggle = (k: string) =>
    onChange(selected.includes(k) ? selected.filter(x => x !== k) : [...selected, k])

  const toggleGroup = (keys: string[]) => {
    const allSelected = keys.every(k => selected.includes(k))
    onChange(
      allSelected
        ? selected.filter(k => !keys.includes(k))
        : [...new Set([...selected, ...keys])],
    )
  }

  const summary =
    selected.length === 0 ? allLabel :
    selected.length === 1 ? (options.find(o => o.key === selected[0])?.short
                             ?? options.find(o => o.key === selected[0])?.label
                             ?? selected[0]) :
    `${selected.length} 件選択`

  const hasGroups = options.some(o => o.group)
  const blocks = hasGroups ? groupOptions(options) : null

  return (
    <label className="env-multiselect-label">{label}
      <details ref={detailsRef} className="env-multiselect">
        <summary>{summary}</summary>
        <div className="env-multiselect-menu">
          {options.length === 0 ? (
            <span className="env-multiselect-empty">
              {loading ? '読み込み中...' : '選択肢がありません'}
            </span>
          ) : (
            <>
              {selected.length > 0 && (
                <button type="button" className="env-multiselect-clear"
                        onClick={() => onChange([])}>選択をクリア</button>
              )}
              {blocks ? blocks.map((block, i) => {
                const keys = block.items.map(o => o.key)
                const selCount = keys.filter(k => selected.includes(k)).length
                const allSel = selCount === keys.length && keys.length > 0
                return (
                  <div key={block.name ?? `ungrouped-${i}`} className="env-multiselect-group">
                    {block.name && (
                      <button
                        type="button"
                        className="env-multiselect-group-header"
                        onClick={() => toggleGroup(keys)}
                      >
                        <span className="env-multiselect-check">
                          {allSel ? '✓' : selCount > 0 ? '−' : ' '}
                        </span>
                        {block.name}
                        <span className="env-multiselect-group-count">
                          {selCount > 0 ? `${selCount}/` : ''}{keys.length}
                        </span>
                      </button>
                    )}
                    {block.items.map(o => (
                      <label
                        key={o.key}
                        className={`env-multiselect-item${block.name ? ' env-multiselect-item--indent' : ''}`}
                      >
                        <input type="checkbox" checked={selected.includes(o.key)}
                               onChange={() => toggle(o.key)} />
                        {o.label}
                      </label>
                    ))}
                  </div>
                )
              }) : (
                options.map(o => (
                  <label key={o.key} className="env-multiselect-item">
                    <input type="checkbox" checked={selected.includes(o.key)}
                           onChange={() => toggle(o.key)} />
                    {o.label}
                  </label>
                ))
              )}
            </>
          )}
        </div>
      </details>
    </label>
  )
}
