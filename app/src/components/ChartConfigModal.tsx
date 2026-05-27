import { useEffect, useState } from 'react'
import type { CustomChart, ChartShape, YComposition, GroupByKey, MetricKey, BattleNumericMetric } from '../types'
import {
  GROUP_BY_LABELS, METRIC_LABELS, CHART_SHAPE_LABELS, Y_COMPOSITION_LABELS,
  IMPLEMENTED_SHAPES, TIME_BUCKET_GROUP_BYS, isTimeBucketGroupBy, scatterMetricOptions,
  BATTLE_NUMERIC_METRIC_LABELS, BATTLE_NUMERIC_DEFAULT_BIN,
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
  // ヒートマップの数値メトリクス bin 軸 (#134)。null/undefined ならカテゴリ軸。
  const [xNumericMetric, setXNumericMetric] = useState<BattleNumericMetric | null>(initial?.xNumericMetric ?? null)
  const [yNumericMetric, setYNumericMetric] = useState<BattleNumericMetric | null>(initial?.yNumericMetric ?? null)
  const [xBinWidth,      setXBinWidth]      = useState<number>(initial?.xBinWidth ?? 1)
  const [yBinWidth,      setYBinWidth]      = useState<number>(initial?.yBinWidth ?? 1)
  // scatter 用 (キーはドット単位ごとに別系統なので string で持つ)
  const [dotUnit,      setDotUnit]      = useState<'battle' | 'weapon' | 'stage'>(initial?.dotUnit ?? 'weapon')
  const [xMetric,      setXMetric]      = useState<string>(initial?.xMetric ?? 'avg_kill')
  const [yMetric,      setYMetric]      = useState<string>(initial?.yMetric ?? 'win_rate')
  const [sizeMetric,   setSizeMetric]   = useState<string>(initial?.sizeMetric ?? 'total')
  const [colorMetric,  setColorMetric]  = useState<string>(initial?.colorMetric ?? '')

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
      // groupBy はデータプリフェッチに使う。battle は db_list_battles で別取得するので
      // 任意の値で OK だが、weapon/stage と整合させておく。
      if (dotUnit !== 'battle') setGroupBy(dotUnit)
      if (yComposition !== 'single_metric') setYComposition('single_metric')
    } else {
      if (isTimeBucketGroupBy(groupBy)) setGroupBy('weapon')
    }
    // ヒートマップ以外では数値メトリクス bin 軸はクリア（#134）。
    if (shape !== 'heatmap') {
      if (xNumericMetric) setXNumericMetric(null)
      if (yNumericMetric) setYNumericMetric(null)
    }
  }, [shape])  // eslint-disable-line react-hooks/exhaustive-deps

  // scatter のドット単位を変えたら groupBy も同期させる（カテゴリ単位のプリフェッチキー連動）。
  // dotUnit='battle' の場合は別経路で battle データを取るので groupBy は触らない。
  useEffect(() => {
    if (shape === 'scatter' && dotUnit !== 'battle') setGroupBy(dotUnit)
  }, [dotUnit, shape])

  // dotUnit を切り替えたとき X / Y / size / color の選択肢系統が変わるのでデフォルトに戻す
  useEffect(() => {
    if (shape !== 'scatter') return
    if (dotUnit === 'battle') {
      setXMetric('kill')
      setYMetric('death')
      setSizeMetric('')
      setColorMetric('win_lose')
    } else {
      setXMetric('avg_kill')
      setYMetric('win_rate')
      setSizeMetric('total')
      setColorMetric('')
    }
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
      sizeMetric:   shape === 'scatter' && sizeMetric  ? sizeMetric  : undefined,
      colorMetric:  shape === 'scatter' && colorMetric ? colorMetric : undefined,
      // 数値メトリクス bin 軸（#134、ヒートマップ専用）
      xNumericMetric: shape === 'heatmap' && xNumericMetric ? xNumericMetric : undefined,
      xBinWidth:      shape === 'heatmap' && xNumericMetric ? xBinWidth : undefined,
      yNumericMetric: shape === 'heatmap' && yNumericMetric ? yNumericMetric : undefined,
      yBinWidth:      shape === 'heatmap' && yNumericMetric ? yBinWidth : undefined,
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

          {/* scatter は X 軸 (集計キー) と Y 軸の構成・メトリクスを使わないので、shape ごとに分岐 */}
          {shape !== 'scatter' && (
            <div className="form-field">
              <label className="form-label">X 軸（集計キー）</label>
              <select
                className="form-input"
                value={xNumericMetric ? `numeric:${xNumericMetric}` : groupBy}
                onChange={e => {
                  const v = e.target.value
                  if (v.startsWith('numeric:')) {
                    const m = v.slice(8) as BattleNumericMetric
                    setXNumericMetric(m)
                    setXBinWidth(BATTLE_NUMERIC_DEFAULT_BIN[m])
                  } else {
                    setXNumericMetric(null)
                    setGroupBy(v as GroupByKey)
                  }
                }}
                disabled={shape === 'calendar_heatmap'}
              >
                <optgroup label="カテゴリ">
                  {(Object.keys(GROUP_BY_LABELS) as GroupByKey[])
                    .filter(g =>
                      shape === 'line' ? isTimeBucketGroupBy(g) :
                      shape === 'calendar_heatmap' ? g === 'day' :
                      !isTimeBucketGroupBy(g)
                    )
                    .map(g => (
                      <option key={g} value={g}>{GROUP_BY_LABELS[g]}</option>
                    ))}
                </optgroup>
                {/* ヒートマップでのみ「数値ヒストグラム」軸が選べる (#134) */}
                {shape === 'heatmap' && (
                  <optgroup label="数値ヒストグラム (bin)">
                    {(Object.keys(BATTLE_NUMERIC_METRIC_LABELS) as BattleNumericMetric[]).map(m => (
                      <option key={m} value={`numeric:${m}`}>{BATTLE_NUMERIC_METRIC_LABELS[m]}</option>
                    ))}
                  </optgroup>
                )}
              </select>
              {shape === 'line' && (
                <p className="form-hint">線グラフは時系列のみ。粒度は {TIME_BUCKET_GROUP_BYS.map(k => GROUP_BY_LABELS[k]).join(' / ')} から選びます。</p>
              )}
              {shape === 'calendar_heatmap' && (
                <p className="form-hint">カレンダーは「日」固定（GitHub 風コントリビューショングラフ）。</p>
              )}
              {shape === 'heatmap' && xNumericMetric && (
                <div className="form-field" style={{ marginTop: 8 }}>
                  <label className="form-label">X 軸の bin 幅</label>
                  <input
                    type="number"
                    className="form-input"
                    min={1}
                    step={1}
                    value={xBinWidth}
                    onChange={e => setXBinWidth(Math.max(1, Math.floor(Number(e.target.value)) || 1))}
                  />
                  <p className="form-hint">{BATTLE_NUMERIC_METRIC_LABELS[xNumericMetric]} を {xBinWidth} 刻みで bin 集計します。</p>
                </div>
              )}
            </div>
          )}

          {shape === 'heatmap' && (
            <div className="form-field">
              <label className="form-label">Y 軸（集計キー 2）</label>
              <select
                className="form-input"
                value={yNumericMetric ? `numeric:${yNumericMetric}` : groupBy2}
                onChange={e => {
                  const v = e.target.value
                  if (v.startsWith('numeric:')) {
                    const m = v.slice(8) as BattleNumericMetric
                    setYNumericMetric(m)
                    setYBinWidth(BATTLE_NUMERIC_DEFAULT_BIN[m])
                  } else {
                    setYNumericMetric(null)
                    setGroupBy2(v as GroupByKey)
                  }
                }}
              >
                <optgroup label="カテゴリ">
                  {(Object.keys(GROUP_BY_LABELS) as GroupByKey[])
                    .filter(g => !isTimeBucketGroupBy(g) && g !== groupBy)
                    .map(g => (
                      <option key={g} value={g}>{GROUP_BY_LABELS[g]}</option>
                    ))}
                </optgroup>
                <optgroup label="数値ヒストグラム (bin)">
                  {(Object.keys(BATTLE_NUMERIC_METRIC_LABELS) as BattleNumericMetric[])
                    .filter(m => m !== xNumericMetric)  // 同じ数値メトリクスは X と被らせない
                    .map(m => (
                      <option key={m} value={`numeric:${m}`}>{BATTLE_NUMERIC_METRIC_LABELS[m]}</option>
                    ))}
                </optgroup>
              </select>
              {yNumericMetric ? (
                <div className="form-field" style={{ marginTop: 8 }}>
                  <label className="form-label">Y 軸の bin 幅</label>
                  <input
                    type="number"
                    className="form-input"
                    min={1}
                    step={1}
                    value={yBinWidth}
                    onChange={e => setYBinWidth(Math.max(1, Math.floor(Number(e.target.value)) || 1))}
                  />
                  <p className="form-hint">{BATTLE_NUMERIC_METRIC_LABELS[yNumericMetric]} を {yBinWidth} 刻みで bin 集計します。</p>
                </div>
              ) : (
                <p className="form-hint">X 軸と異なる軸を選んでください。</p>
              )}
            </div>
          )}

          {shape === 'heatmap' && (
            groupBy === 'weapon' || groupBy2 === 'weapon' ||
            groupBy === 'ally_weapon' || groupBy2 === 'ally_weapon' ||
            groupBy === 'enemy_weapon' || groupBy2 === 'enemy_weapon'
          ) && (
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

          {/* 棒グラフ: Y 軸を「メトリクス + 複合構成」統合の 1 セレクトで選ぶ。
              line/heatmap/calendar は yComposition が常に single_metric なので、
              メトリクスだけのシンプルな select を出す（下のブロック）。 */}
          {shape === 'bar' && (() => {
            // 統合 select の現在値：single_metric のときは metric、それ以外は yComposition
            const barYAxisValue = yComposition === 'single_metric' ? metric : yComposition
            const isComposite = yComposition !== 'single_metric'
            return (
              <div className="form-field">
                <label className="form-label">Y 軸</label>
                <select
                  className="form-input"
                  value={barYAxisValue}
                  onChange={e => {
                    const v = e.target.value
                    if (v === 'stacked_winrate' || v === 'attack_defense') {
                      setYComposition(v as YComposition)
                    } else {
                      setYComposition('single_metric')
                      setMetric(v as MetricKey)
                    }
                  }}
                >
                  <optgroup label="複合">
                    <option value="stacked_winrate">{Y_COMPOSITION_LABELS.stacked_winrate}</option>
                    <option value="attack_defense">{Y_COMPOSITION_LABELS.attack_defense}</option>
                  </optgroup>
                  <optgroup label="単一メトリクス">
                    {(Object.keys(METRIC_LABELS) as MetricKey[]).map(m => (
                      <option key={m} value={m}>{METRIC_LABELS[m]}</option>
                    ))}
                  </optgroup>
                </select>
                <p className="form-hint">
                  {isComposite ? Y_COMPOSITION_DESCRIPTIONS[yComposition] : '単一メトリクスの棒グラフ。'}
                </p>
              </div>
            )
          })()}

          {/* line / heatmap / calendar_heatmap 用のメトリクス選択。
              これらは yComposition が常に single_metric に固定されている。 */}
          {shape !== 'scatter' && shape !== 'bar' && yComposition === 'single_metric' && (
            <div className="form-field">
              <label className="form-label">メトリクス</label>
              <select className="form-input" value={metric} onChange={e => setMetric(e.target.value as MetricKey)}>
                {(Object.keys(METRIC_LABELS) as MetricKey[]).map(m => (
                  <option key={m} value={m}>{METRIC_LABELS[m]}</option>
                ))}
              </select>
            </div>
          )}

          {shape === 'scatter' && (
            <>
              <div className="form-field">
                <label className="form-label">ドット単位</label>
                <select className="form-input" value={dotUnit} onChange={e => setDotUnit(e.target.value as 'battle' | 'weapon' | 'stage')}>
                  <option value="battle">バトル</option>
                  <option value="weapon">武器</option>
                  <option value="stage">ステージ</option>
                </select>
                <p className="form-hint">1 ドット = 1 {dotUnit === 'battle' ? 'バトル' : dotUnit === 'weapon' ? '武器' : 'ステージ'}。</p>
              </div>
              <div className="form-field">
                <label className="form-label">X 軸</label>
                <select className="form-input" value={xMetric} onChange={e => setXMetric(e.target.value)}>
                  {scatterMetricOptions(dotUnit).map(o => (
                    <option key={o.key} value={o.key}>{o.label}</option>
                  ))}
                </select>
              </div>
              <div className="form-field">
                <label className="form-label">Y 軸</label>
                <select className="form-input" value={yMetric} onChange={e => setYMetric(e.target.value)}>
                  {scatterMetricOptions(dotUnit).map(o => (
                    <option key={o.key} value={o.key}>{o.label}</option>
                  ))}
                </select>
              </div>
              <div className="form-field">
                <label className="form-label">サイズ（任意）</label>
                <select className="form-input" value={sizeMetric} onChange={e => setSizeMetric(e.target.value)}>
                  <option value="">（一定サイズ）</option>
                  {scatterMetricOptions(dotUnit).map(o => (
                    <option key={o.key} value={o.key}>{o.label}</option>
                  ))}
                </select>
                <p className="form-hint">値が大きいほど大きく見える（sqrt スケール）。</p>
              </div>
              <div className="form-field">
                <label className="form-label">色（任意）</label>
                <select className="form-input" value={colorMetric} onChange={e => setColorMetric(e.target.value)}>
                  <option value="">（単色 = アクセント）</option>
                  {dotUnit === 'battle' && <option value="win_lose">勝敗</option>}
                  {scatterMetricOptions(dotUnit).map(o => (
                    <option key={o.key} value={o.key}>{o.label}</option>
                  ))}
                </select>
                <p className="form-hint">
                  {dotUnit === 'battle'
                    ? '勝敗を選ぶと勝/負/分で 3 色に塗り分け。'
                    : '勝率は divergent (赤↔青)、それ以外は accent の濃淡。'}
                </p>
              </div>
            </>
          )}

          {/* bar の「Y 軸の構成 + メトリクス」は上の統合 Y 軸 select に集約済み。 */}

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
