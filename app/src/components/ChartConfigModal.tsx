import { useEffect, useState } from 'react'
import type { CustomChart, CustomChartType, GroupByKey, MetricKey } from '../types'
import { GROUP_BY_LABELS, METRIC_LABELS } from '../types'

const CHART_TYPE_LABELS: Record<CustomChartType, string> = {
  stacked_winrate: '積み上げ棒＋勝率線',
  simple_bar:      'シンプル棒（1 メトリクス）',
  attack_defense:  '攻撃 vs デス セット',
}

/** 各チャートタイプで「タイトル以外に追加で設定が必要な項目」を一覧化したヒント文。 */
const CHART_TYPE_DESCRIPTIONS: Record<CustomChartType, string> = {
  stacked_winrate: '勝/負/分の積み上げ + 勝率線。集計キーだけ選択。',
  simple_bar:      '単一メトリクスの棒。Y 軸メトリクスを選択。',
  attack_defense:  '平均キル（灰色アシスト積み上げ）と平均デスを 2 本セットで表示。',
}

interface Props {
  /** 編集対象。null なら新規作成モード。 */
  initial: CustomChart | null
  onSave:  (chart: CustomChart) => void
  onClose: () => void
}

/**
 * カスタムグラフの追加・編集モーダル。
 *
 * - 「+ グラフを追加」ボタンから呼ぶときは initial=null（新規）
 * - カードの ⚙ ボタンから呼ぶときは initial に既存値を渡す（編集）
 * - グラフタイプによって表示するフォーム項目が変わる：
 *   - `stacked_winrate` / `attack_defense`: X 軸（groupBy）だけ
 *   - `simple_bar`: X 軸（groupBy）+ Y 軸メトリクス
 */
export function ChartConfigModal({ initial, onSave, onClose }: Props) {
  // editing state
  const [title,   setTitle]   = useState(initial?.title   ?? '新しいグラフ')
  const [type,    setType]    = useState<CustomChartType>(initial?.type    ?? 'simple_bar')
  const [groupBy, setGroupBy] = useState<GroupByKey>(initial?.groupBy ?? 'weapon')
  const [metric,  setMetric]  = useState<MetricKey>(initial?.metric  ?? 'win_rate')

  // ESC で閉じる
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  function handleSave() {
    const trimmedTitle = title.trim() || 'グラフ'
    const chart: CustomChart = {
      id:      initial?.id ?? '',  // 保存側で空ならカスタム ID 生成
      title:   trimmedTitle,
      type,
      groupBy,
      metric:  type === 'simple_bar' ? metric : undefined,
    }
    onSave(chart)
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel chart-config-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title-text">{initial ? 'グラフを編集' : 'グラフを追加'}</span>
          <button className="modal-close" onClick={onClose} aria-label="閉じる">✕</button>
        </div>

        <div className="modal-body chart-config-body">
          <div className="form-field">
            <label className="form-label">タイトル</label>
            <input
              type="text"
              className="form-input"
              value={title}
              onChange={e => setTitle(e.target.value)}
              maxLength={40}
              placeholder="例: 武器カテゴリ別 平均キル"
              autoFocus
            />
          </div>

          <div className="form-field">
            <label className="form-label">グラフタイプ</label>
            <select className="form-input" value={type} onChange={e => setType(e.target.value as CustomChartType)}>
              {(Object.keys(CHART_TYPE_LABELS) as CustomChartType[]).map(t => (
                <option key={t} value={t}>{CHART_TYPE_LABELS[t]}</option>
              ))}
            </select>
            <p className="form-hint">{CHART_TYPE_DESCRIPTIONS[type]}</p>
          </div>

          <div className="form-field">
            <label className="form-label">X 軸（集計キー）</label>
            <select className="form-input" value={groupBy} onChange={e => setGroupBy(e.target.value as GroupByKey)}>
              {(Object.keys(GROUP_BY_LABELS) as GroupByKey[]).map(g => (
                <option key={g} value={g}>{GROUP_BY_LABELS[g]}</option>
              ))}
            </select>
          </div>

          {type === 'simple_bar' && (
            <div className="form-field">
              <label className="form-label">Y 軸（メトリクス）</label>
              <select className="form-input" value={metric} onChange={e => setMetric(e.target.value as MetricKey)}>
                {(Object.keys(METRIC_LABELS) as MetricKey[]).map(m => (
                  <option key={m} value={m}>{METRIC_LABELS[m]}</option>
                ))}
              </select>
            </div>
          )}

          <div className="modal-actions">
            <button className="btn-secondary" onClick={onClose}>キャンセル</button>
            <button className="btn-primary" onClick={handleSave}>{initial ? '更新' : '追加'}</button>
          </div>
        </div>
      </div>
    </div>
  )
}
