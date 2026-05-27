import { useEffect, useState } from 'react'
import type { CustomChart, ChartShape, YComposition, GroupByKey, MetricKey } from '../types'
import {
  GROUP_BY_LABELS, METRIC_LABELS, CHART_SHAPE_LABELS, Y_COMPOSITION_LABELS,
  IMPLEMENTED_SHAPES, TIME_BUCKET_GROUP_BYS, isTimeBucketGroupBy,
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
  const [groupBy2,     setGroupBy2]     = useState<GroupByKey>(initial?.groupBy2     ?? 'stage')
  const [metric,       setMetric]       = useState<MetricKey>(initial?.metric       ?? 'win_rate')
  const [topN,         setTopN]         = useState<number>(initial?.topN ?? 20)
  // scatter 用
  const [dotUnit,      setDotUnit]      = useState<'weapon' | 'stage'>(initial?.dotUnit ?? 'weapon')
  const [xMetric,      setXMetric]      = useState<MetricKey>(initial?.xMetric ?? 'avg_kill')
  const [yMetric,      setYMetric]      = useState<MetricKey>(initial?.yMetric ?? 'win_rate')
  const [sizeMetric,   setSizeMetric]   = useState<MetricKey | ''>(initial?.sizeMetric ?? 'total')
  const [colorMetric,  setColorMetric]  = useState<MetricKey | ''>(initial?.colorMetric ?? '')

  // shape ごとに groupBy / yComposition を適切に補正する：
  //   - line: 時系列バケット (day/three_day/week/month) + single_metric
  //   - calendar_heatmap: day 固定 + single_metric
  //   - heatmap: カテゴリ系 X/Y + single_metric。X==Y 衝突を避ける
  //   - その他 (bar など): 時系列でないカテゴリ系へ戻す
  useEffect(() => {
    if (shape === 'line') {
      if (!isTimeBucketGroupBy(groupBy)) setGroupBy('day')
      if (yComposition !== 'single_metric') setYComposition('single_metric')
    } else if (shape === 'calendar_heatmap') {
      if (groupBy !== 'day') setGroupBy('day')
      if (yComposition !== 'single_metric') setYComposition('single_metric')
    } else if (shape === 'heatmap') {
      if (isTimeBucketGroupBy(groupBy)) setGroupBy('weapon')
      if (isTimeBucketGroupBy(groupBy2)) setGroupBy2('stage')
      if (yComposition !== 'single_metric') setYComposition('single_metric')
    } else if (shape === 'scatter') {
      // ドット単位 (weapon/stage) = groupBy として扱う
      setGroupBy(dotUnit)
      if (yComposition !== 'single_metric') setYComposition('single_metric')
    } else {
      if (isTimeBucketGroupBy(groupBy)) setGroupBy('weapon')
    }
  }, [shape])  // eslint-disable-line react-hooks/exhaustive-deps

  // scatter のドット単位を変えたら groupBy も同期させる（プリフェッチのキー連動のため）
  useEffect(() => {
    if (shape === 'scatter') setGroupBy(dotUnit)
  }, [dotUnit, shape])

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
      groupBy2:     shape === 'heatmap' ? groupBy2 : undefined,
      topN:         shape === 'heatmap' ? topN : undefined,
      dotUnit:      shape === 'scatter' ? dotUnit : undefined,
      xMetric:      shape === 'scatter' ? xMetric : undefined,
      yMetric:      shape === 'scatter' ? yMetric : undefined,
      sizeMetric:   shape === 'scatter' && sizeMetric  ? (sizeMetric  as MetricKey) : undefined,
      colorMetric:  shape === 'scatter' && colorMetric ? (colorMetric as MetricKey) : undefined,
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
            <select
              className="form-input"
              value={groupBy}
              onChange={e => setGroupBy(e.target.value as GroupByKey)}
              disabled={shape === 'calendar_heatmap'}
            >
              {(Object.keys(GROUP_BY_LABELS) as GroupByKey[])
                .filter(g =>
                  shape === 'line' ? isTimeBucketGroupBy(g) :
                  shape === 'calendar_heatmap' ? g === 'day' :
                  !isTimeBucketGroupBy(g)
                )
                .map(g => (
                  <option key={g} value={g}>{GROUP_BY_LABELS[g]}</option>
                ))}
            </select>
            {shape === 'line' && (
              <p className="form-hint">線グラフは時系列のみ。粒度は {TIME_BUCKET_GROUP_BYS.map(k => GROUP_BY_LABELS[k]).join(' / ')} から選びます。</p>
            )}
            {shape === 'calendar_heatmap' && (
              <p className="form-hint">カレンダーは「日」固定（GitHub 風コントリビューショングラフ）。</p>
            )}
          </div>

          {shape === 'heatmap' && (
            <div className="form-field">
              <label className="form-label">Y 軸（集計キー 2）</label>
              <select
                className="form-input"
                value={groupBy2}
                onChange={e => setGroupBy2(e.target.value as GroupByKey)}
              >
                {(Object.keys(GROUP_BY_LABELS) as GroupByKey[])
                  .filter(g => !isTimeBucketGroupBy(g) && g !== groupBy)
                  .map(g => (
                    <option key={g} value={g}>{GROUP_BY_LABELS[g]}</option>
                  ))}
              </select>
              <p className="form-hint">X 軸と異なるカテゴリを選んでください。</p>
            </div>
          )}

          {shape === 'heatmap' && (groupBy === 'weapon' || groupBy2 === 'weapon') && (
            <div className="form-field">
              <label className="form-label">武器軸の上位 N</label>
              <input
                type="number"
                className="form-input"
                min={5}
                max={200}
                value={topN}
                onChange={e => setTopN(Math.max(1, Math.min(200, Number(e.target.value) || 20)))}
              />
              <p className="form-hint">バトル数の多い武器を上位 N 種に絞ります（デフォルト 20）。</p>
            </div>
          )}

          {shape === 'scatter' && (
            <>
              <div className="form-field">
                <label className="form-label">ドット単位</label>
                <select className="form-input" value={dotUnit} onChange={e => setDotUnit(e.target.value as 'weapon' | 'stage')}>
                  <option value="weapon">武器</option>
                  <option value="stage">ステージ</option>
                </select>
                <p className="form-hint">1 ドット = 1 {dotUnit === 'weapon' ? '武器' : 'ステージ'}（バトル単位は後続 PR）。</p>
              </div>
              <div className="form-field">
                <label className="form-label">X 軸メトリクス</label>
                <select className="form-input" value={xMetric} onChange={e => setXMetric(e.target.value as MetricKey)}>
                  {(Object.keys(METRIC_LABELS) as MetricKey[]).map(m => (
                    <option key={m} value={m}>{METRIC_LABELS[m]}</option>
                  ))}
                </select>
              </div>
              <div className="form-field">
                <label className="form-label">Y 軸メトリクス</label>
                <select className="form-input" value={yMetric} onChange={e => setYMetric(e.target.value as MetricKey)}>
                  {(Object.keys(METRIC_LABELS) as MetricKey[]).map(m => (
                    <option key={m} value={m}>{METRIC_LABELS[m]}</option>
                  ))}
                </select>
              </div>
              <div className="form-field">
                <label className="form-label">サイズメトリクス（任意）</label>
                <select className="form-input" value={sizeMetric} onChange={e => setSizeMetric((e.target.value || '') as MetricKey | '')}>
                  <option value="">（一定サイズ）</option>
                  {(Object.keys(METRIC_LABELS) as MetricKey[]).map(m => (
                    <option key={m} value={m}>{METRIC_LABELS[m]}</option>
                  ))}
                </select>
                <p className="form-hint">バトル数を選ぶとサンプル多いカテゴリほど大きく見える（sqrt スケール）。</p>
              </div>
              <div className="form-field">
                <label className="form-label">色メトリクス（任意）</label>
                <select className="form-input" value={colorMetric} onChange={e => setColorMetric((e.target.value || '') as MetricKey | '')}>
                  <option value="">（単色 = アクセント）</option>
                  {(Object.keys(METRIC_LABELS) as MetricKey[]).map(m => (
                    <option key={m} value={m}>{METRIC_LABELS[m]}</option>
                  ))}
                </select>
                <p className="form-hint">勝率は divergent (赤↔青)、それ以外は accent の濃淡。</p>
              </div>
            </>
          )}

          <div className="form-field">
            <label className="form-label">Y 軸の構成</label>
            <select
              className="form-input"
              value={yComposition}
              onChange={e => setYComposition(e.target.value as YComposition)}
              disabled={shape === 'line' || shape === 'calendar_heatmap' || shape === 'heatmap'}
            >
              {(Object.keys(Y_COMPOSITION_LABELS) as YComposition[]).map(y => (
                <option key={y} value={y}>{Y_COMPOSITION_LABELS[y]}</option>
              ))}
            </select>
            <p className="form-hint">{Y_COMPOSITION_DESCRIPTIONS[yComposition]}</p>
            {shape === 'line' && (
              <p className="form-hint form-hint--warn">線グラフは現在「単一メトリクス」のみ対応です（多系列・2 軸は後続 PR）。</p>
            )}
            {shape === 'calendar_heatmap' && (
              <p className="form-hint form-hint--warn">カレンダーは「単一メトリクス」専用。メトリクスごとに色スケールが自動切替されます。</p>
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
