import { useEffect, useState } from 'react'
import type { CustomChart, ChartShape, YComposition, GroupByKey, MetricKey } from '../types'
import {
  GROUP_BY_LABELS, METRIC_LABELS, CHART_SHAPE_LABELS, Y_COMPOSITION_LABELS,
  IMPLEMENTED_SHAPES, TIME_BUCKET_GROUP_BYS, isTimeBucketGroupBy, autoChartTitle,
} from '../types'

/** 各 yComposition のヒント説明。 */
const Y_COMPOSITION_DESCRIPTIONS: Record<YComposition, string> = {
  single_metric:   'Y 軸に好きな 1 メトリクス（勝率・バトル数・平均K/D など）を取る。',
  stacked_winrate: '勝/負/分 を積み上げた棒に、勝率を線で重ねる。既存 4 グラフと同じ形。',
  attack_defense:  'カテゴリごとに「平均キル（灰色アシスト積み）」「平均デス」を 2 本セットで横並びに表示。',
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
  // タイトルは保存しない方針（軸から常に autoChartTitle で算出して表示する）。
  const [shape,        setShape]        = useState<ChartShape>(initial?.shape        ?? 'bar')
  const [yComposition, setYComposition] = useState<YComposition>(initial?.yComposition ?? 'single_metric')
  const [groupBy,      setGroupBy]      = useState<GroupByKey>(initial?.groupBy      ?? 'weapon')
  const [metric,       setMetric]       = useState<MetricKey>(initial?.metric       ?? 'win_rate')

  // shape='line' は時系列バケットのみ。shape を line に切り替えたとき groupBy が
  // 時系列でなければ自動で 'day' に補正する。逆に line 以外へ戻したとき時系列
  // groupBy のままだと bar 等で意味不明になるので 'weapon' に補正する。
  useEffect(() => {
    if (shape === 'line') {
      if (!isTimeBucketGroupBy(groupBy)) setGroupBy('day')
      if (yComposition !== 'single_metric') setYComposition('single_metric')
    } else {
      if (isTimeBucketGroupBy(groupBy)) setGroupBy('weapon')
    }
  }, [shape])  // eslint-disable-line react-hooks/exhaustive-deps

  // 現在の軸から算出するタイトル（モーダル上部にプレビュー表示）
  const previewTitle = autoChartTitle({ groupBy, yComposition, metric })

  // ESC で閉じる
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  function handleSave() {
    const chart: CustomChart = {
      id:           initial?.id ?? '',  // 保存側で空ならカスタム ID 生成
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
            <label className="form-label">タイトル <span className="form-label-note">（軸から自動）</span></label>
            <div className="form-preview-title">{previewTitle}</div>
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
              {(Object.keys(GROUP_BY_LABELS) as GroupByKey[])
                .filter(g => shape === 'line' ? isTimeBucketGroupBy(g) : !isTimeBucketGroupBy(g))
                .map(g => (
                  <option key={g} value={g}>{GROUP_BY_LABELS[g]}</option>
                ))}
            </select>
            {shape === 'line' && (
              <p className="form-hint">線グラフは時系列のみ。粒度は {TIME_BUCKET_GROUP_BYS.map(k => GROUP_BY_LABELS[k]).join(' / ')} から選びます。</p>
            )}
          </div>

          <div className="form-field">
            <label className="form-label">Y 軸の構成</label>
            <select
              className="form-input"
              value={yComposition}
              onChange={e => setYComposition(e.target.value as YComposition)}
              disabled={shape === 'line'}
            >
              {(Object.keys(Y_COMPOSITION_LABELS) as YComposition[]).map(y => (
                <option key={y} value={y}>{Y_COMPOSITION_LABELS[y]}</option>
              ))}
            </select>
            <p className="form-hint">{Y_COMPOSITION_DESCRIPTIONS[yComposition]}</p>
            {shape === 'line' && (
              <p className="form-hint form-hint--warn">線グラフは現在「単一メトリクス」のみ対応です（多系列・2 軸は後続 PR）。</p>
            )}
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
