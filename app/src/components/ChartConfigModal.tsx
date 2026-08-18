import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CustomChart, ChartShape, YComposition, GroupByKey, MetricKey, BattleNumericMetric, ScatterDotUnit, ScatterPointStyle, ScatterImageSize } from '../types'
import {
  GROUP_BY_LABELS, METRIC_LABELS, HEATMAP_METRICS, SUM_METRICS, CHART_SHAPE_LABELS, Y_COMPOSITION_LABELS,
  IMPLEMENTED_SHAPES, TIME_BUCKET_GROUP_BYS, isTimeBucketGroupBy, scatterMetricOptions, SCATTER_DOT_UNITS,
  scatterDotUnitLabel, canScatterUseImages, SCATTER_IMAGE_SIZE_LABELS,
  BATTLE_NUMERIC_METRIC_LABELS, BATTLE_NUMERIC_DEFAULT_BIN, axisGroupOf, AXIS_GROUP_LABELS, chartMetrics,
  LOCAL_METRIC_KEYS, officialMetricsForGroup, isOfficialRateMetric, OFFICIAL_METRICS,
  isWeaponGroupBy,
} from '../types'
import { SCATTER_CATEGORY_COLOR_KEYS } from '../utils/scatterCategoryColors'
import { CHART_BAR_TOP_N } from '../utils/chartSort'

/**
 * 比率メトリクスか (#381)。**ログスケールを無効化する判定**に使う。
 *
 * 0-1 に収まる値をログにしても読みやすくならないので、チェック自体を押せなくする。
 * `ScatterChart` の `xIsRate` / `yIsRate` と同じ条件。
 */
const isRateMetric = (metric: string) => isOfficialRateMetric(metric)

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
  const { t } = useTranslation()

  function logScaleHint(metric: string): string {
    return isRateMetric(metric) ? t('chartConfig.logHintRate') : t('chartConfig.logHint')
  }

  function scatterMetricSelectOptions(dotUnit: ScatterDotUnit) {
    const official = officialMetricsForGroup(dotUnit)
    return (
      <>
        {scatterMetricOptions(dotUnit).map(o => (
          <option key={o.key} value={o.key}>{o.label}</option>
        ))}
        {official.length > 0 && (
          <optgroup label={t('chartConfig.officialGroup')}>
            {official.map(m => (
              <option key={m} value={m}>{METRIC_LABELS[m]}</option>
            ))}
          </optgroup>
        )}
      </>
    )
  }

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
  const [topN,         setTopN]         = useState<number>(
    initial?.topN ?? (initial?.shape === 'heatmap' ? 20 : CHART_BAR_TOP_N)
  )
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
  // 点の見た目 (#627)。未設定は 'dot'(既存グラフは丸のまま)。
  const [pointStyle,   setPointStyle]   = useState<ScatterPointStyle>(initial?.scatterPointStyle ?? 'dot')
  const [imageSize,    setImageSize]    = useState<ScatterImageSize>(initial?.scatterImageSize ?? 'medium')
  // 画像モードのときサイズ・色は効かない。設定は**消さずに無視**するので、丸に戻せば復帰する。
  const imageMode = pointStyle === 'image' && canScatterUseImages(dotUnit)

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

  // 公式メトリクスはブキ軸 / ステージ軸だけで意味がある。軸を変えたら退避する。
  useEffect(() => {
    if (!OFFICIAL_METRICS.includes(metric)) return
    if (!officialMetricsForGroup(groupBy).includes(metric)) setMetric('win_rate')
  }, [groupBy, metric])

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

  const showWeaponTopN =
    (shape === 'heatmap' && (isWeaponGroupBy(groupBy) || isWeaponGroupBy(groupBy2))) ||
    (shape === 'bar' && isWeaponGroupBy(groupBy))

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
      topN:         showWeaponTopN ? topN : undefined,
      dotUnit:      shape === 'scatter' ? dotUnit : undefined,
      xMetric:      shape === 'scatter' ? xMetric : undefined,
      yMetric:      shape === 'scatter' ? yMetric : undefined,
      sizeMetric:   shape === 'scatter' && sizeMetric  ? sizeMetric  : undefined,
      colorMetric:  shape === 'scatter' && colorMetric ? colorMetric : undefined,
      // 比率メトリクスにログは効かないので、選び直された場合は保存しない (#381)。
      xLogScale:    shape === 'scatter' && xLogScale && !isRateMetric(xMetric) ? true : undefined,
      yLogScale:    shape === 'scatter' && yLogScale && !isRateMetric(yMetric) ? true : undefined,
      // 点の見た目 (#627)。ブキ軸以外では保存しない(ドット単位を変えて戻したとき
      // 意図しない画像モードが復活しないように)。
      scatterPointStyle: imageMode ? 'image' : undefined,
      scatterImageSize:  imageMode ? imageSize : undefined,
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
          <span className="modal-title-text">{initial ? t('chartConfig.editTitle') : t('chartConfig.addTitle')}</span>
          <button className="modal-close" onClick={onClose} aria-label={t('common.close')}>✕</button>
        </div>

        <div className="modal-body chart-config-body">
          <div className="form-field">
            <label className="form-label">{t('chartConfig.shape')}</label>
            <select className="form-input" value={shape} onChange={e => setShape(e.target.value as ChartShape)}>
              {(Object.keys(CHART_SHAPE_LABELS) as ChartShape[]).map(s => {
                const implemented = IMPLEMENTED_SHAPES.includes(s)
                return (
                  <option key={s} value={s} disabled={!implemented}>
                    {CHART_SHAPE_LABELS[s]}{implemented ? '' : t('chart.unimplemented')}
                  </option>
                )
              })}
            </select>
            {!shapeIsImplemented && (
              <p className="form-hint form-hint--warn">
                {t('chartConfig.unimplementedHint')}
              </p>
            )}
          </div>

          {/* scatter は X 軸 (集計キー) と Y 軸の構成・メトリクスを使わないので、shape ごとに分岐。
              calendar_heatmap は日別で固定（上の useEffect が groupBy を 'day' に寄せる）。
              選択肢が 1 つしかない select を灰色で出しても選べないだけなので、項目ごと出さない。 */}
          {shape !== 'scatter' && shape !== 'calendar_heatmap' && (
            <div className="form-field">
              <label className="form-label">{t('chartConfig.xAxisKey')}</label>
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
              >
                <optgroup label={t('chartConfig.category')}>
                  {(Object.keys(GROUP_BY_LABELS) as GroupByKey[])
                    .filter(g => shape === 'line' ? isTimeBucketGroupBy(g) : !isTimeBucketGroupBy(g))
                    .map(g => (
                      <option key={g} value={g}>{GROUP_BY_LABELS[g]}</option>
                    ))}
                </optgroup>
                {/* ヒートマップでのみ「数値ヒストグラム」軸が選べる (#134) */}
                {shape === 'heatmap' && (
                  <optgroup label={t('chartConfig.numericBin')}>
                    {(Object.keys(BATTLE_NUMERIC_METRIC_LABELS) as BattleNumericMetric[]).map(m => (
                      <option key={m} value={`numeric:${m}`}>{BATTLE_NUMERIC_METRIC_LABELS[m]}</option>
                    ))}
                  </optgroup>
                )}
              </select>
              {shape === 'line' && (
                <p className="form-hint">{t('chartConfig.lineTimeHint', { buckets: TIME_BUCKET_GROUP_BYS.map(k => GROUP_BY_LABELS[k]).join(' / ') })}</p>
              )}
              {shape === 'heatmap' && xNumericMetric && (
                <div className="form-field" style={{ marginTop: 8 }}>
                  <label className="form-label">{t('chartConfig.xBinWidth')}</label>
                  <input
                    type="number"
                    className="form-input"
                    min={1}
                    step={1}
                    value={xBinWidth}
                    onChange={e => setXBinWidth(Math.max(1, Math.floor(Number(e.target.value)) || 1))}
                  />
                  <p className="form-hint">{t('chartConfig.binHint', { metric: BATTLE_NUMERIC_METRIC_LABELS[xNumericMetric], width: xBinWidth })}</p>
                </div>
              )}
            </div>
          )}

          {shape === 'heatmap' && (
            <div className="form-field">
              <label className="form-label">{t('chartConfig.yAxisKey')}</label>
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
                <optgroup label={t('chartConfig.category')}>
                  {(Object.keys(GROUP_BY_LABELS) as GroupByKey[])
                    .filter(g => !isTimeBucketGroupBy(g) && g !== groupBy)
                    .map(g => (
                      <option key={g} value={g}>{GROUP_BY_LABELS[g]}</option>
                    ))}
                </optgroup>
                <optgroup label={t('chartConfig.numericBin')}>
                  {(Object.keys(BATTLE_NUMERIC_METRIC_LABELS) as BattleNumericMetric[])
                    .filter(m => m !== xNumericMetric)  // 同じ数値メトリクスは X と被らせない
                    .map(m => (
                      <option key={m} value={`numeric:${m}`}>{BATTLE_NUMERIC_METRIC_LABELS[m]}</option>
                    ))}
                </optgroup>
              </select>
              {yNumericMetric ? (
                <div className="form-field" style={{ marginTop: 8 }}>
                  <label className="form-label">{t('chartConfig.yBinWidth')}</label>
                  <input
                    type="number"
                    className="form-input"
                    min={1}
                    step={1}
                    value={yBinWidth}
                    onChange={e => setYBinWidth(Math.max(1, Math.floor(Number(e.target.value)) || 1))}
                  />
                  <p className="form-hint">{t('chartConfig.binHint', { metric: BATTLE_NUMERIC_METRIC_LABELS[yNumericMetric], width: yBinWidth })}</p>
                </div>
              ) : (
                <p className="form-hint">{t('chartConfig.yDiffHint')}</p>
              )}
            </div>
          )}

          {showWeaponTopN && (
            <div className="form-field">
              <label className="form-label">{t('chartConfig.weaponCount')}</label>
              <input
                type="number"
                className="form-input"
                min={5}
                max={200}
                value={topN}
                onChange={e => setTopN(Math.max(1, Math.min(200, Number(e.target.value) || (shape === 'heatmap' ? 20 : CHART_BAR_TOP_N))))}
              />
              <p className="form-hint">
                {shape === 'heatmap'
                  ? t('chartConfig.topNHeatmap')
                  : t('chartConfig.topNBar', { n: CHART_BAR_TOP_N })}
              </p>
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
                <label className="form-label">{t('chartConfig.yAxis')}</label>
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
                  <optgroup label={t('chartConfig.composite')}>
                    <option value="stacked_winrate">{Y_COMPOSITION_LABELS.stacked_winrate}</option>
                    <option value="attack_defense">{Y_COMPOSITION_LABELS.attack_defense}</option>
                  </optgroup>
                  <optgroup label={t('chartConfig.singleMetric')}>
                    {LOCAL_METRIC_KEYS.map(m => (
                      <option key={m} value={m}>{METRIC_LABELS[m]}</option>
                    ))}
                  </optgroup>
                  {officialMetricsForGroup(groupBy).length > 0 && (
                    <optgroup label={t('chartConfig.officialGroup')}>
                      {officialMetricsForGroup(groupBy).map(m => (
                        <option key={m} value={m}>{METRIC_LABELS[m]}</option>
                      ))}
                    </optgroup>
                  )}
                </select>
                <p className="form-hint">
                  {isComposite
                    ? (yComposition === 'stacked_winrate'
                      ? t('chartConfig.yCompStacked')
                      : yComposition === 'attack_defense'
                        ? t('chartConfig.yCompAttack')
                        : t('chartConfig.yCompSingle'))
                    : OFFICIAL_METRICS.includes(metric)
                      ? t('chartConfig.officialHint')
                      : t('chartConfig.singleBarHint')}
                </p>
              </div>
            )
          })()}

          {/* heatmap / calendar_heatmap 用のメトリクス選択(単一)。
              これらは yComposition が常に single_metric に固定されている。line は下の複数選択 UI を使う。 */}
          {shape !== 'scatter' && shape !== 'bar' && shape !== 'line' && yComposition === 'single_metric' && (
            <div className="form-field">
              <label className="form-label">{t('chartConfig.metric')}</label>
              {/* ヒートマップは合計系を出さない。2D クロス集計に列が無く、
                  選んでも全セルが空になるため(#351)。 */}
              <select className="form-input" value={metric} onChange={e => setMetric(e.target.value as MetricKey)}>
                {(shape === 'heatmap' ? HEATMAP_METRICS : LOCAL_METRIC_KEYS).map(m => (
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
              <label className="form-label">{t('chartConfig.metricsMulti')}</label>
              <div className="metric-checkbox-group">
                {(LOCAL_METRIC_KEYS).map(m => {
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
                  {t('chartConfig.axisLimitHint', { groups: [...lineUsedGroups].map(g => AXIS_GROUP_LABELS[g]).join('・') })}
                </p>
              )}
              {lineMetrics.length === 0 && (
                <p className="form-hint form-hint--warn">{t('chartConfig.pickOne')}</p>
              )}
            </div>
          )}

          {shape === 'scatter' && (
            <>
              <div className="form-field">
                <label className="form-label">{t('chartConfig.dotUnit')}</label>
                <select className="form-input" value={dotUnit} onChange={e => setDotUnit(e.target.value as ScatterDotUnit)}>
                  {SCATTER_DOT_UNITS.map(u => (
                    <option key={u} value={u}>{scatterDotUnitLabel(u)}</option>
                  ))}
                </select>
                <p className="form-hint">{t('chartConfig.dotUnitHint', { unit: scatterDotUnitLabel(dotUnit) })}</p>
              </div>
              {canScatterUseImages(dotUnit) && (
                <div className="form-field">
                  <label className="form-label">{t('chartConfig.pointStyle')}</label>
                  <select
                    className="form-input"
                    value={pointStyle}
                    onChange={e => setPointStyle(e.target.value as ScatterPointStyle)}
                  >
                    <option value="dot">{t('chartConfig.pointDot')}</option>
                    <option value="image">{t('chartConfig.pointImage')}</option>
                  </select>
                  {pointStyle === 'image' && (
                    <>
                      <label className="form-label" style={{ marginTop: 8 }}>{t('chartConfig.imageSize')}</label>
                      <select
                        className="form-input"
                        value={imageSize}
                        onChange={e => setImageSize(e.target.value as ScatterImageSize)}
                      >
                        {(['small', 'medium', 'large'] as ScatterImageSize[]).map(s => (
                          <option key={s} value={s}>{SCATTER_IMAGE_SIZE_LABELS[s]}</option>
                        ))}
                      </select>
                    </>
                  )}
                  <p className="form-hint">
                    {pointStyle === 'image'
                      ? t('chartConfig.imageHint')
                      : t('chartConfig.imageAvailableHint')}
                  </p>
                </div>
              )}
              <div className="form-field">
                <label className="form-label">{t('chartConfig.xAxis')}</label>
                <select className="form-input" value={xMetric} onChange={e => setXMetric(e.target.value)}>
                  {scatterMetricSelectOptions(dotUnit)}
                </select>
                {!isRateMetric(xMetric) && (
                  <label className="checkbox-label" style={{ marginTop: 6 }}>
                    <input
                      type="checkbox"
                      checked={xLogScale}
                      onChange={e => setXLogScale(e.target.checked)}
                    />
                    {t('chartConfig.logScale')}
                  </label>
                )}
                <p className="form-hint">{logScaleHint(xMetric)}</p>
              </div>
              <div className="form-field">
                <label className="form-label">{t('chartConfig.yAxis')}</label>
                <select className="form-input" value={yMetric} onChange={e => setYMetric(e.target.value)}>
                  {scatterMetricSelectOptions(dotUnit)}
                </select>
                {!isRateMetric(yMetric) && (
                  <label className="checkbox-label" style={{ marginTop: 6 }}>
                    <input
                      type="checkbox"
                      checked={yLogScale}
                      onChange={e => setYLogScale(e.target.checked)}
                    />
                    {t('chartConfig.logScale')}
                  </label>
                )}
                <p className="form-hint">{logScaleHint(yMetric)}</p>
              </div>
              {/* 🔴 画像モードでは**出さない**。使えない項目を灰色で並べても選べないだけで、
                  理由は「点の見た目」のヒントに書いてある。 */}
              {!imageMode && (
              <div className="form-field">
                <label className="form-label">{t('chartConfig.sizeOptional')}</label>
                <select className="form-input" value={sizeMetric} onChange={e => setSizeMetric(e.target.value)}>
                  <option value="">{t('chartConfig.fixedSize')}</option>
                  {scatterMetricSelectOptions(dotUnit)}
                </select>
                <p className="form-hint">{t('chartConfig.sizeHint')}</p>
              </div>
              )}
              {!imageMode && (
              <div className="form-field">
                <label className="form-label">{t('chartConfig.colorOptional')}</label>
                <select className="form-input" value={colorMetric} onChange={e => setColorMetric(e.target.value)}>
                  <option value="">{t('chartConfig.solidColor')}</option>
                  {dotUnit === 'battle' && <option value="win_lose">{t('chart.winLose')}</option>}
                  {scatterMetricSelectOptions(dotUnit)}
                  {(dotUnit === 'weapon' || dotUnit === 'battle') && SCATTER_CATEGORY_COLOR_KEYS.map(k => (
                    <option key={k} value={k}>{GROUP_BY_LABELS[k]}</option>
                  ))}
                </select>
                <p className="form-hint">
                  {dotUnit === 'battle'
                    ? t('chartConfig.colorHintBattle')
                    : dotUnit === 'weapon'
                      ? t('chartConfig.colorHintWeapon')
                      : t('chartConfig.colorHintOther')}
                </p>
              </div>
              )}
            </>
          )}

          {/* bar の「Y 軸の構成 + メトリクス」は上の統合 Y 軸 select に集約済み。 */}

          <div className="modal-actions">
            <button className="btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
            <button
              className="btn-primary"
              onClick={handleSave}
              disabled={!shapeIsImplemented || (shape === 'line' && lineMetrics.length === 0)}
            >
              {initial ? t('common.update') : t('common.add')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
