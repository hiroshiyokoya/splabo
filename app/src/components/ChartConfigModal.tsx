import { useEffect, useState } from 'react'
import type { CustomChart, ChartShape, YComposition, GroupByKey, MetricKey } from '../types'
import {
  GROUP_BY_LABELS, METRIC_LABELS, CHART_SHAPE_LABELS, Y_COMPOSITION_LABELS,
  IMPLEMENTED_SHAPES,
} from '../types'

/** 各 yComposition のヒント説明。 */
const Y_COMPOSITION_DESCRIPTIONS: Record<YComposition, string> = {
  single_metric:   'Y 軸に好きな 1 メトリクス（勝率・バトル数・平均K/D など）を取る。',
  stacked_winrate: '勝/負/分 を積み上げた棒に、勝率を線で重ねる。既存 4 グラフと同じ形。',
  attack_defense:  'カテゴリごとに「平均K（灰色 A 積み）」「平均D」を 2 本セットで横並びに表示。',
}

interface Props {
  /** 編集対象。null なら新規作成モード。 */
  initial: CustomChart | null
  onSave:  (chart: CustomChart) => void
  onClose: () => void
}

/**
 * カスタムグラフの追加・編集モーダル（v2 モデル）。
 *
 * v2 では「グラフの形 (shape)」と「Y 軸の構成 (yComposition)」を独立に選ぶ：
 *   - shape: 棒 / 線 / 散布図 / ヒートマップ（v1.0.0 は bar のみ実装）
 *   - yComposition: 単一メトリクス / 勝負分積み上げ+勝率 / 攻撃 vs デス
 *
 * UI 上、未実装の shape も選択肢に出すが disabled にして「（未実装）」ラベルを付ける。
 */
export function ChartConfigModal({ initial, onSave, onClose }: Props) {
  const [title,        setTitle]        = useState(initial?.title        ?? '新しいグラフ')
  const [shape,        setShape]        = useState<ChartShape>(initial?.shape        ?? 'bar')
  const [yComposition, setYComposition] = useState<YComposition>(initial?.yComposition ?? 'single_metric')
  const [groupBy,      setGroupBy]      = useState<GroupByKey>(initial?.groupBy      ?? 'weapon')
  const [metric,       setMetric]       = useState<MetricKey>(initial?.metric       ?? 'win_rate')

  // ESC で閉じる
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  function handleSave() {
    const trimmedTitle = title.trim() || 'グラフ'
    const chart: CustomChart = {
      id:           initial?.id ?? '',  // 保存側で空ならカスタム ID 生成
      title:        trimmedTitle,
      shape,
      yComposition,
      groupBy,
      metric:       yComposition === 'single_metric' ? metric : undefined,
    }
    onSave(chart)
  }

  const shapeIsImplemented = IMPLEMENTED_SHAPES.includes(shape)

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
            <label className="form-label">形（グラフの種類）</label>
            <select className="form-input" value={shape} onChange={e => setShape(e.target.value as ChartShape)}>
              {(Object.keys(CHART_SHAPE_LABELS) as ChartShape[]).map(s => {
                const implemented = IMPLEMENTED_SHAPES.includes(s)
                return (
                  <option key={s} value={s} disabled={!implemented}>
                    {CHART_SHAPE_LABELS[s]}{implemented ? '' : '（未実装）'}
                  </option>
                )
              })}
            </select>
            {!shapeIsImplemented && (
              <p className="form-hint form-hint--warn">
                この形は v1.0.0 では未実装です。v1.1+ で対応予定。
              </p>
            )}
          </div>

          <div className="form-field">
            <label className="form-label">X 軸（集計キー）</label>
            <select className="form-input" value={groupBy} onChange={e => setGroupBy(e.target.value as GroupByKey)}>
              {(Object.keys(GROUP_BY_LABELS) as GroupByKey[]).map(g => (
                <option key={g} value={g}>{GROUP_BY_LABELS[g]}</option>
              ))}
            </select>
          </div>

          <div className="form-field">
            <label className="form-label">Y 軸の構成</label>
            <select className="form-input" value={yComposition} onChange={e => setYComposition(e.target.value as YComposition)}>
              {(Object.keys(Y_COMPOSITION_LABELS) as YComposition[]).map(y => (
                <option key={y} value={y}>{Y_COMPOSITION_LABELS[y]}</option>
              ))}
            </select>
            <p className="form-hint">{Y_COMPOSITION_DESCRIPTIONS[yComposition]}</p>
          </div>

          {yComposition === 'single_metric' && (
            <div className="form-field">
              <label className="form-label">メトリクス</label>
              <select className="form-input" value={metric} onChange={e => setMetric(e.target.value as MetricKey)}>
                {(Object.keys(METRIC_LABELS) as MetricKey[]).map(m => (
                  <option key={m} value={m}>{METRIC_LABELS[m]}</option>
                ))}
              </select>
            </div>
          )}

          <div className="modal-actions">
            <button className="btn-secondary" onClick={onClose}>キャンセル</button>
            <button className="btn-primary" onClick={handleSave} disabled={!shapeIsImplemented}>
              {initial ? '更新' : '追加'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
