/** 複数選択ドロップダウン（#189 で導入 → #190 で共有化）。
 *  `<details>` でメニュー開閉を担い、各項目はチェックボックスでトグルする。
 *  選択ゼロ件で `allLabel`、1 件で項目名、2 件以上で「N 件選択」をサマリ表示。 */

export interface MultiSelectOption { key: string; label: string; short?: string }

export function MultiSelect({ label, allLabel, options, selected, onChange }: {
  label:    string
  allLabel: string
  options:  MultiSelectOption[]
  selected: string[]
  onChange: (next: string[]) => void
}) {
  const toggle = (k: string) =>
    onChange(selected.includes(k) ? selected.filter(x => x !== k) : [...selected, k])

  const summary =
    selected.length === 0 ? allLabel :
    selected.length === 1 ? (options.find(o => o.key === selected[0])?.short
                             ?? options.find(o => o.key === selected[0])?.label
                             ?? selected[0]) :
    `${selected.length} 件選択`

  return (
    <label className="env-multiselect-label">{label}
      <details className="env-multiselect">
        <summary>{summary}</summary>
        <div className="env-multiselect-menu">
          {options.length === 0 ? (
            <span className="env-multiselect-empty">選択肢がありません</span>
          ) : (
            <>
              {selected.length > 0 && (
                <button type="button" className="env-multiselect-clear"
                        onClick={() => onChange([])}>選択をクリア</button>
              )}
              {options.map(o => (
                <label key={o.key} className="env-multiselect-item">
                  <input type="checkbox" checked={selected.includes(o.key)}
                         onChange={() => toggle(o.key)} />
                  {o.label}
                </label>
              ))}
            </>
          )}
        </div>
      </details>
    </label>
  )
}
