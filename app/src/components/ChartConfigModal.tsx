import { useEffect, useRef, useState } from 'react'
import type { CustomChart, ChartShape, YComposition, GroupByKey, MetricKey, BattleNumericMetric, ScatterDotUnit } from '../types'
import {
  GROUP_BY_LABELS, METRIC_LABELS, HEATMAP_METRICS, SUM_METRICS, CHART_SHAPE_LABELS, Y_COMPOSITION_LABELS,
  IMPLEMENTED_SHAPES, TIME_BUCKET_GROUP_BYS, isTimeBucketGroupBy, scatterMetricOptions, SCATTER_DOT_UNITS,
  scatterDotUnitLabel,
  BATTLE_NUMERIC_METRIC_LABELS, BATTLE_NUMERIC_DEFAULT_BIN, axisGroupOf, AXIS_GROUP_LABELS, chartMetrics,
} from '../types'
import { SCATTER_CATEGORY_COLOR_KEYS } from '../utils/scatterCategoryColors'

/**
 * 比率メトリクスか (#381)。**ログスケールを無効化する判定**に使う。
 *
 * 0-1 に収まる値をログにしても読みやすくならないので、チェック自体を押せなくする。
 * `ScatterChart` の `xIsRate` / `yIsRate` と同じ条件。
 */
const isRateMetric = (metric: string) => metric === 'win_rate'

/** ログスケールのチェックボックスに添える説明 (#381)。 */
function logScaleHint(metric: string): string {
  if (isRateMetric(metric)) return '勝率は 0-100% に収まるのでログスケールは使えません。'
  return 'ロングテールや比率(キルレ)を読みやすくします。0 以下・∞ の点は除外されます。'
}

/** 各 yComposition のヒント説明。 */
const Y_COMPOSITION_DESCRIPTIONS: Record<YComposition, string> = {
  single_metric:   'Y 軸に好きな 1 メトリクス(勝率・バトル数・キルレ など)を取る。',
  stacked_winrate: '勝/負/分 を積み上げた棒に、勝率を線で重ねる。既存 4 グラフと同じ形。',
  attack_defense:  'カテゴリごとに「平均キル(灰色アシスト積み)」「平均デス」を 2 本セットで横並びに表示。',
}

interface Props {
  /** 編集対象。null なら新規作成モード。 */
  initial: CustomChart | null
  onSave:  (chart: CustomChart) => void
  onClose: () => void
}

/**
 * カスタムグラフの追加・編集モーダル(v2 モデル)。
 *
 * v2 では「グラフの形 (shape)」と「Y 軸の構成 (yComposition)」を独立に選ぶ：
 *   - shape: 棒 / 線 / 散布図 / ヒートマップ(v1.0.0 は bar のみ実装)
 *   - yComposition: 単一メトリクス / 勝負分積み上げ+勝率 / 攻撃 vs デス
 *
 * UI 上、未実装の shape も選択肢に出すが disabled にして「(未実装)」ラベルを付ける。
 */
export function ChartConfigModal({ initial, onSave, onClose }: Props) {
  // タイトルは保存しない方針(軸から常に autoChartTitle で算出して表示する)。
  const [shape,        setShape]        = useState<ChartShape>(initial?.shape        ?? 'bar')
  const [yComposition, setYComposition] = useState<YComposition>(initial?.yComposition ?? 'single_metric')
  const [groupBy,      setGroupBy]      = useState<GroupByKey>(initial?.groupBy      ?? 'weapon')
  const [groupBy2,     setGroupBy2]     = useState<GroupByKey>(initial?.groupBy2     ?? 'stage')
  const [metric,       setMetric]       = useState<MetricKey>(initial?.metric       ?? 'win_rate')
  // shape='line' 専用: 複数系列メトリクス(#436)。選択順を保持する(軸の左右割当は選択順で決まる)。
  const [lineMetrics,  setLineMetrics]  = useState<MetricKey[]>(
    initial?.shape === 'line' ? chartMetrics(initial) : ['win_rate']
  )
  const [topN,         setTopN]         = useState<number>(initial?.topN ?? 20)
  // ヒートマップの数値メトリクス bin 軸 (#134)。null/undefined ならカテゴリ軸。
  const [xNumericMetric, setXNumericMetric] = useState<BattleNumericMetric | null>(initial?.xNumericMetric ?? null)
  const [yNumericMetric, setYNumericMetric] = useState<BattleNumericMetric | null>(initial?.yNumericMetric ?? null)
  const [xBinWidth,      setXBinWidth]      = useState<number>(initial?.xBinWidth ?? 1)
  const [yBinWidth,      setYBinWidth]      = useState<number>(initial?.yBinWidth ?? 1)
  // scatter 用 (キーはドット単位ごとに別系統なので string で持つ)
  const [dotUnit,      setDotUnit]      = useState<ScatterDotUnit>(initial?.dotUnit ?? 'weapon')
  const [xMetric,      setXMetric]      = useState<string>(initial?.xMetric ?? 'avg_kill')
  const [yMetric,      setYMetric]      = useState<string>(initial?.yMetric ?? 'win_rate')
  // サイズは「(一定サイズ)」が '' で、保存時に undefined へ落ちる(handleSave 参照)。
  // そのため `initial?.sizeMetric ?? 'total'` にすると、一定サイズで保存したグラフを
  // 編集で開いたとき「バトル数」に化けてしまう。編集時は保存値をそのまま(undefined は
  // 一定サイズ = '')復元し、新規作成のときだけ既定値 'total' を使う。
  const [sizeMetric,   setSizeMetric]   = useState<string>(initial ? (initial.sizeMetric ?? '') : 'total')
  const [colorMetric,  setColorMetric]  = useState<string>(initial?.colorMetric ?? '')
  // ログスケール (#381)。未設定は false(既存グラフはリニアのまま)。
  const [xLogScale,    setXLogScale]    = useState<boolean>(initial?.xLogScale ?? false)
  const [yLogScale,    setYLogScale]    = useState<boolean>(initial?.yLogScale ?? false)

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
      // 合計系はヒートマップでは全セル空になるので、選ばれていたら勝率へ退避(#351)。
      // 既存の保存済みグラフを開いた場合の救済も兼ねる。
      if (SUM_METRICS.includes(metric)) setMetric('win_rate')
    } else if (shape === 'scatter') {
      // groupBy はデータプリフェッチに使う。battle は db_list_battles で別取得するので
      // 任意の値で OK だが、weapon/stage と整合させておく。
      if (dotUnit !== 'battle') setGroupBy(dotUnit)
      if (yComposition !== 'single_metric') setYComposition('single_metric')
    } else {
      if (isTimeBucketGroupBy(groupBy)) setGroupBy('weapon')
    }
    // ヒートマップ以外では数値メトリクス bin 軸はクリア(#134)。
    if (shape !== 'heatmap') {
      if (xNumericMetric) setXNumericMetric(null)
      if (yNumericMetric) setYNumericMetric(null)
    }
  }, [shape])  // eslint-disable-line react-hooks/exhaustive-deps

  // scatter のドット単位を変えたら groupBy も同期させる(カテゴリ単位のプリフェッチキー連動)。
  // dotUnit='battle' の場合は別経路で battle データを取るので groupBy は触らない。
  useEffect(() => {
    if (shape === 'scatter' && dotUnit !== 'battle') setGroupBy(dotUnit)
  }, [dotUnit, shape])

  // dotUnit を切り替えたとき X / Y / size / color の選択肢系統が変わるのでデフォルトに戻す。
  // ただし **編集モードで開いたときの初回マウントでは保存値を保持** したい(#143)。
  //
  // 以前は「ref で 1 回目をスキップ」していたが、StrictMode は effect を
  // setup → cleanup → setup と 2 回走らせるため、2 回目でスキップが外れて
  // 保存値が既定値に上書きされていた(編集を開くと設定が違って見えるバグ)。
  // 「実際に dotUnit が変わったときだけ反応する」形にして、何回走っても安全にする。
  const prevDotUnitRef = useRef(dotUnit)
  useEffect(() => {
    if (prevDotUnitRef.current === dotUnit) return  // 初回マウント・再実行では発火しない
    prevDotUnitRef.current = dotUnit
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

  // 折れ線の軸グループ(#436): 同時に使えるのは 2 グループまで。
  // 3 グループ目に属する未選択メトリクスは選べない(チェックボックスを disabled にする)。
  const lineUsedGroups = new Set(lineMetrics.map(axisGroupOf))
  function toggleLineMetric(m: MetricKey) {
    setLineMetrics(prev => {
      if (prev.includes(m)) return prev.filter(x => x !== m)
      const group = axisGroupOf(m)
      const usedGroups = new Set(prev.map(axisGroupOf))
      if (!usedGroups.has(group) && usedGroups.size >= 2) return prev  // 3 グループ目は追加しない
      return [...prev, m]
    })
  }

  function handleSave() {
    const chart: CustomChart = {
      id:           initial?.id ?? '',  // 保存側で空ならカスタム ID 生成
      shape,
      yComposition,
      groupBy,
      // line は metrics(複数系列・#436)、それ以外は単一 metric。
      metric:       shape !== 'line' && yComposition === 'single_metric' ? metric : undefined,
      metrics:      shape === 'line' ? lineMetrics : undefined,
      groupBy2:     shape === 'heatmap' ? groupBy2 : undefined,
      topN:         shape === 'heatmap' ? topN : undefined,
      dotUnit:      shape === 'scatter' ? dotUnit : undefined,
      xMetric:      shape === 'scatter' ? xMetric : undefined,
      yMetric:      shape === 'scatter' ? yMetric : undefined,
      sizeMetric:   shape === 'scatter' && sizeMetric  ? sizeMetric  : undefined,
      colorMetric:  shape === 'scatter' && colorMetric ? colorMetric : undefined,
      // 比率メトリクスにログは効かないので、選び直された場合は保存しない (#381)。
      xLogScale:    shape === 'scatter' && xLogScale && !isRateMetric(xMetric) ? true : undefined,
      yLogScale:    shape === 'scatter' && yLogScale && !isRateMetric(yMetric) ? true : undefined,
      // 数値メトリクス bin 軸(#134、ヒートマップ専用)
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
            <label className="form-label">形(グラフの種類)</label>
            <select className="form-input" value={shape} onChange={e => setShape(e.target.value as ChartShape)}>
              {(Object.keys(CHART_SHAPE_LABELS) as ChartShape[]).map(s => {
                const implemented = IMPLEMENTED_SHAPES.includes(s)
                return (
                  <option key={s} value={s} disabled={!implemented}>
                    {CHART_SHAPE_LABELS[s]}{implemented ? '' : '(未実装)'}
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
              <label className="form-label">X 軸(集計キー)</label>
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
                <p className="form-hint">カレンダーは「日」固定(GitHub 風コントリビューショングラフ)。</p>
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
              <label className="form-label">Y 軸(集計キー 2)</label>
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
              <label className="form-label">ブキ軸の上位 N</label>
              <input
                type="number"
                className="form-input"
                min={5}
                max={200}
                value={topN}
                onChange={e => setTopN(Math.max(1, Math.min(200, Number(e.target.value) || 20)))}
              />
              <p className="form-hint">バトル数の多いブキを上位 N 種に絞ります(デフォルト 20)。</p>
            </div>
          )}

          {/* 棒グラフ: Y 軸を「メトリクス + 複合構成」統合の 1 セレクトで選ぶ。
              line/heatmap/calendar は yComposition が常に single_metric なので、
              メトリクスだけのシンプルな select を出す(下のブロック)。 */}
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

          {/* heatmap / calendar_heatmap 用のメトリクス選択(単一)。
              これらは yComposition が常に single_metric に固定されている。line は下の複数選択 UI を使う。 */}
          {shape !== 'scatter' && shape !== 'bar' && shape !== 'line' && yComposition === 'single_metric' && (
            <div className="form-field">
              <label className="form-label">メトリクス</label>
              {/* ヒートマップは合計系を出さない。2D クロス集計に列が無く、
                  選んでも全セルが空になるため(#351)。 */}
              <select className="form-input" value={metric} onChange={e => setMetric(e.target.value as MetricKey)}>
                {(shape === 'heatmap' ? HEATMAP_METRICS : (Object.keys(METRIC_LABELS) as MetricKey[])).map(m => (
                  <option key={m} value={m}>{METRIC_LABELS[m]}</option>
                ))}
              </select>
            </div>
          )}

          {/* line 用のメトリクス選択。複数系列対応(#436)：チェックボックス群、上限なし。
              同時に使える軸グループ(回/バトル・勝率・カウント・塗り)は 2 つまで。
              軸の左右は自動割当(最初に選んだ系列のグループ = 左軸、2 つ目のグループ = 右軸)。 */}
          {shape === 'line' && (
            <div className="form-field">
              <label className="form-label">メトリクス(複数選択可)</label>
              <div className="metric-checkbox-group">
                {(Object.keys(METRIC_LABELS) as MetricKey[]).map(m => {
                  const group = axisGroupOf(m)
                  const checked = lineMetrics.includes(m)
                  const disabled = !checked && !lineUsedGroups.has(group) && lineUsedGroups.size >= 2
                  return (
                    <label key={m} className="checkbox-label" style={disabled ? { opacity: 0.45 } : undefined}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={disabled}
                        onChange={() => toggleLineMetric(m)}
                      />
                      {METRIC_LABELS[m]}
                    </label>
                  )
                })}
              </div>
              {lineUsedGroups.size >= 2 && (
                <p className="form-hint">
                  軸は 2 種類までです({[...lineUsedGroups].map(g => AXIS_GROUP_LABELS[g]).join('・')} を使用中)。
                </p>
              )}
              {lineMetrics.length === 0 && (
                <p className="form-hint form-hint--warn">少なくとも 1 つ選んでください。</p>
              )}
            </div>
          )}

          {shape === 'scatter' && (
            <>
              <div className="form-field">
                <label className="form-label">ドット単位</label>
                <select className="form-input" value={dotUnit} onChange={e => setDotUnit(e.target.value as ScatterDotUnit)}>
                  {SCATTER_DOT_UNITS.map(u => (
                    <option key={u} value={u}>{scatterDotUnitLabel(u)}</option>
                  ))}
                </select>
                <p className="form-hint">1 ドット = 1 {scatterDotUnitLabel(dotUnit)}。</p>
              </div>
              <div className="form-field">
                <label className="form-label">X 軸</label>
                <select className="form-input" value={xMetric} onChange={e => setXMetric(e.target.value)}>
                  {scatterMetricOptions(dotUnit).map(o => (
                    <option key={o.key} value={o.key}>{o.label}</option>
                  ))}
                </select>
                <label className="checkbox-label" style={{ marginTop: 6 }}>
                  <input
                    type="checkbox"
                    checked={xLogScale && !isRateMetric(xMetric)}
                    disabled={isRateMetric(xMetric)}
                    onChange={e => setXLogScale(e.target.checked)}
                  />
                  ログスケール
                </label>
                <p className="form-hint">{logScaleHint(xMetric)}</p>
              </div>
              <div className="form-field">
                <label className="form-label">Y 軸</label>
                <select className="form-input" value={yMetric} onChange={e => setYMetric(e.target.value)}>
                  {scatterMetricOptions(dotUnit).map(o => (
                    <option key={o.key} value={o.key}>{o.label}</option>
                  ))}
                </select>
                <label className="checkbox-label" style={{ marginTop: 6 }}>
                  <input
                    type="checkbox"
                    checked={yLogScale && !isRateMetric(yMetric)}
                    disabled={isRateMetric(yMetric)}
                    onChange={e => setYLogScale(e.target.checked)}
                  />
                  ログスケール
                </label>
                <p className="form-hint">{logScaleHint(yMetric)}</p>
              </div>
              <div className="form-field">
                <label className="form-label">サイズ(任意)</label>
                <select className="form-input" value={sizeMetric} onChange={e => setSizeMetric(e.target.value)}>
                  <option value="">(一定サイズ)</option>
                  {scatterMetricOptions(dotUnit).map(o => (
                    <option key={o.key} value={o.key}>{o.label}</option>
                  ))}
                </select>
                <p className="form-hint">値が大きいほど大きく見える(sqrt スケール)。</p>
              </div>
              <div className="form-field">
                <label className="form-label">色・形(任意)</label>
                <select className="form-input" value={colorMetric} onChange={e => setColorMetric(e.target.value)}>
                  <option value="">(単色 = アクセント)</option>
                  {dotUnit === 'battle' && <option value="win_lose">勝敗</option>}
                  {scatterMetricOptions(dotUnit).map(o => (
                    <option key={o.key} value={o.key}>{o.label}</option>
                  ))}
                  {(dotUnit === 'weapon' || dotUnit === 'battle') && SCATTER_CATEGORY_COLOR_KEYS.map(k => (
                    <option key={k} value={k}>{GROUP_BY_LABELS[k]}</option>
                  ))}
                </select>
                <p className="form-hint">
                  {dotUnit === 'battle'
                    ? '勝敗、またはブキカテゴリ・サブ・スペシャルを色×形で区別できます。'
                    : dotUnit === 'weapon'
                      ? '数値指標のほか、ブキカテゴリ・サブ・スペシャルを色×形で区別できます。'
                      : '勝率は divergent (赤↔青)、それ以外は accent の濃淡。'}
                </p>
              </div>
            </>
          )}

          {/* bar の「Y 軸の構成 + メトリクス」は上の統合 Y 軸 select に集約済み。 */}

          <div className="modal-actions">
            <button className="btn-secondary" onClick={onClose}>キャンセル</button>
            <button
              className="btn-primary"
              onClick={handleSave}
              disabled={!shapeIsImplemented || (shape === 'line' && lineMetrics.length === 0)}
            >
              {initial ? '更新' : '追加'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
