import type { MetricKey } from '../types'

/**
 * 勝率の 3 色（文字・バー・ヒートマップで共用）。
 *
 * 端は旧スケールの端から 3 番目（珊瑚〜ティール）。中央は長い弧の黄緑。
 * 3 色とも端の彩度は元の 72%。中央へ明るさを上げ、彩度を落とす。45% 未満 / 45–55% / 55% 以上。
 */
export const WIN_RATE_LO  = '#f6927d'  // くすみ珊瑚。負け越し
export const WIN_RATE_MID = '#c2c4a2'  // くすみ黄緑。引き分け帯（明るめ・低彩度）
export const WIN_RATE_HI  = '#59c5bf'  // くすみティール。勝ち越し

export function winRateColor(rate: number): string {
  if (rate >= 0.55) return WIN_RATE_HI
  if (rate >= 0.45) return WIN_RATE_MID
  return WIN_RATE_LO
}

/**
 * 勝率（発散スケール）の色マッピング（#351）。
 *
 * 同じ判定が HeatmapChart / CalendarHeatmapChart / CustomChartCard（散布図の点色）に
 * 重複していたため、ここへ集約する。勝率のスケールはアプリ全体で 1 つに保つ。
 *
 * 配色の考え方:
 *  - 色相の幅を短くし（H≈33°〜190°）、彩度は元の 72% で揃える。
 *    中央へ向かって L を 0.76→0.81、彩度を 72%→約 30% と振る。
 *    中央の両隣は色相で約 28° 離し、そこから端までは均等。
 *  - 11 段。r1 / r6 / r11 が文字色と同じ。データなし線は --cell-hatch。
 *    サンプル不足は指標色の上に斜線（#697）。
 *  - 実際の色は CSS 変数（--cell-r1..r11）。
 */

/**
 * 勝率 0..1 を 11 段階のセル色へ（#351）。
 * 中央の 45-55%（±5%）をくすみ黄緑の引き分け帯に置き、その外側を各 9% 刻みで 5 段ずつ。
 */
export function rateCellColor(value: number): string {
  if (value < 0.09) return 'var(--cell-r1)'  // 〜9%   くすみ珊瑚
  if (value < 0.18) return 'var(--cell-r2)'  // 9-18%
  if (value < 0.27) return 'var(--cell-r3)'  // 18-27%
  if (value < 0.36) return 'var(--cell-r4)'  // 27-36%
  if (value < 0.45) return 'var(--cell-r5)'  // 36-45%
  if (value <= 0.55) return 'var(--cell-r6)' // 45-55% くすみ黄緑
  if (value <= 0.64) return 'var(--cell-r7)' // 55-64%
  if (value <= 0.73) return 'var(--cell-r8)' // 64-73%
  if (value <= 0.82) return 'var(--cell-r9)' // 73-82%
  if (value <= 0.91) return 'var(--cell-r10)'// 82-91%
  return 'var(--cell-r11)'                   // 91%〜  くすみティール
}

/** 勝率凡例のカラーバー（rateCellColor と同じ 11 段・同じ並び）。 */
export const RATE_LEGEND_COLORS = [
  'var(--cell-r1)', 'var(--cell-r2)', 'var(--cell-r3)', 'var(--cell-r4)', 'var(--cell-r5)',
  'var(--cell-r6)',
  'var(--cell-r7)', 'var(--cell-r8)', 'var(--cell-r9)', 'var(--cell-r10)', 'var(--cell-r11)',
]

/**
 * 今見えている値の範囲 [min, max] を 11 段に割り振る（環境分析の勝率用）。
 * ダッシュボードの絶対 0–100% スケール（{@link rateCellColor}）とは別。
 * min==max のときは中央のくすみ黄緑。
 */
export function rateCellColorInRange(value: number, min: number, max: number): string {
  if (!(max > min)) return 'var(--cell-r6)'
  const t = Math.max(0, Math.min(1, (value - min) / (max - min)))
  return RATE_LEGEND_COLORS[Math.round(t * 10)]
}

/**
 * 勝数・平均系（シーケンシャル）のベース色をメトリクスごとに決める（#351）。
 *
 * 棒グラフの勝敗色を流用し、意味で色を割り当てる:
 *  - 緑（--win 系）  … 多いほど良い（勝数・キル・キルレ）
 *  - 赤（--lose 系） … 多いほど悪い（デス）
 *  - 橙            … 良し悪しの無い量（バトル数・アシスト・SP・塗り・時間）
 *
 * 実際の色は CSS 変数（--seq-good / --seq-bad / --seq-neutral）が持つ。
 * 段は白（淡く）・黒（濃く）との混色で作るので背景に依存せず、テーマ別の差し替えは不要。
 */
function seqBase(metric: MetricKey): string {
  switch (metric) {
    case 'wins':
    case 'avg_kill':
    case 'avg_assist':
    case 'avg_contrib_kill':
    case 'avg_kd':
    case 'avg_contrib_kd':
    case 'sum_contrib_kill':
    case 'official_win_count':
    case 'official_weapon_level':
      return 'var(--seq-good)'
    case 'avg_death':
      return 'var(--seq-bad)'
    default:
      return 'var(--seq-neutral)'
  }
}

/**
 * 7 段の作り方。ベース色を白と混ぜて淡く（tint）、黒と混ぜて濃く（shade）する。
 * 「薄い＝少ない / 濃い＝多い」の濃淡モデル。白黒と混ぜるので背景に依存せず、
 * ダークでもライトでも同じ向き（淡→濃）で正しく読める。
 * 背景と混ぜる方式は、ダークで「低い値ほど暗い」という逆転になるため使わない。
 */
const SEQ_STEPS: { mix: 'white' | 'black'; pct: number }[] = [
  { mix: 'white', pct: 16 },  // 最小 = 最も淡い
  { mix: 'white', pct: 36 },
  { mix: 'white', pct: 62 },
  { mix: 'white', pct: 100 }, // ベース色そのまま
  { mix: 'black', pct: 82 },
  { mix: 'black', pct: 62 },
  { mix: 'black', pct: 52 },  // 最大 = 最も濃い
]

const seqStep = (base: string, i: number) => {
  const { mix, pct } = SEQ_STEPS[i]
  return pct === 100 ? base : `color-mix(in srgb, ${base} ${pct}%, ${mix})`
}

/**
 * 勝数・平均系のセル色。正規化済みの 0..1 を 7 段階へ（#351）。
 * 大きさは同一色相の「濃さ」で表す（色相はメトリクスの意味を表す）。
 */
export function sequentialCellColor(t: number, metric: MetricKey): string {
  const base = seqBase(metric)
  const i = t <= 1 / 7 ? 0 : t <= 2 / 7 ? 1 : t <= 3 / 7 ? 2 : t <= 4 / 7 ? 3
          : t <= 5 / 7 ? 4 : t <= 6 / 7 ? 5 : 6
  return seqStep(base, i)
}

/** 勝数・平均系凡例のカラーバー（sequentialCellColor と同じ 7 段・同じ並び）。 */
export function seqLegendColors(metric: MetricKey): string[] {
  const base = seqBase(metric)
  return SEQ_STEPS.map((_, i) => seqStep(base, i))
}

/**
 * 勝数・平均系のスケール範囲を整数へ丸める（#351）。
 * 凡例が「3.2 – 7.8」ではなく「3 – 8」になるよう、下限は floor・上限は ceil を取る。
 * セル色も同じ範囲で正規化するため、凡例のラベルと色が食い違わない。
 */
export function integerRange(min: number, max: number): { min: number; max: number } {
  return { min: Math.floor(min), max: Math.ceil(max) }
}

/**
 * 行・列の見出し（軸ラベル）を「その軸に射影した値」で色付けするときの共通ルール（#405 / #409）。
 *
 * ヒートマップの実装は 2 つある（環境分析の `charts/Heatmap.tsx` と
 * ダッシュボードの `charts/HeatmapChart.tsx`）。両者で見た目の考え方を揃えるため、
 * 射影値の算出（サンプル数で加重平均）と「弱い射影値は色を付けない」閾値をここに置く。
 */

/**
 * 射影値（率・平均系）: キーごとに value を weight（サンプル数）で加重平均する。
 *
 * **契約（#411）: そのキーの「全データ」を渡すこと。** 呼び出し側でセル単位の足切り
 * （サンプル不足セルの除外・バックエンドの HAVING）を掛けたデータを渡してはならない。
 *
 * 加重平均は Σ(値ᵢ×nᵢ)/Σnᵢ = Σ(生の合計)/Σ(母数) なので、全データを渡しさえすれば
 * **交差する軸に依存しない**（ガチエリアの勝率は ブキ×ルール でも ステージ×ルール でも
 * 同じ値になる）。足切り後のデータを渡すと、残るセルが交差軸ごとに変わるため
 * 同じキーの値が食い違う — これが #411 のバグだった。
 *
 * 「標本が少なすぎるキーには色を付けない」足切りは、セル単位ではなく **軸の合計標本数**
 * （`AXIS_MIN_TOTAL_SAMPLES`）で行うこと。
 *
 * 値が無い行・weight が 0 の行は寄与させない。1 件も寄与しなかったキーは
 * 結果に現れない（＝呼び出し側では「射影値なし」＝既定色）。
 *
 * カウント系（バトル数のような件数そのもの）には使わない。件数を件数で加重平均すると
 * Σ(n²)/Σn という size-biased な値になり意味を成さない。合計（`sumBy`）を使う。
 */
export function weightedProjection<T>(
  rows:     readonly T[],
  keyOf:    (row: T) => string,
  valueOf:  (row: T) => number | null | undefined,
  weightOf: (row: T) => number,
): Map<string, number> {
  const wSum = new Map<string, number>()  // Σ value*weight
  const nSum = new Map<string, number>()  // Σ weight
  for (const row of rows) {
    const v = valueOf(row)
    if (v == null) continue
    const w = weightOf(row)
    if (!(w > 0)) continue
    const k = keyOf(row)
    wSum.set(k, (wSum.get(k) ?? 0) + v * w)
    nSum.set(k, (nSum.get(k) ?? 0) + w)
  }
  const out = new Map<string, number>()
  for (const [k, w] of nSum) out.set(k, wSum.get(k)! / w)
  return out
}

/**
 * キーごとの単純合計（#411）。用途は 2 つ:
 *  - カウント系（バトル数など件数そのもの）の射影値。合計が正しい集計。
 *  - 軸の合計標本数（`AXIS_MIN_TOTAL_SAMPLES` の足切り判定）。
 */
export function sumBy<T>(
  rows:    readonly T[],
  keyOf:   (row: T) => string,
  valueOf: (row: T) => number | null | undefined,
): Map<string, number> {
  const out = new Map<string, number>()
  for (const row of rows) {
    const v = valueOf(row)
    if (v == null) continue
    const k = keyOf(row)
    out.set(k, (out.get(k) ?? 0) + v)
  }
  return out
}

/**
 * 軸ラベルに色を付けるのに必要な、その軸の合計標本数（#411）。
 *
 * セル 1 つの値は当てにならないので `minSampleSize` で足切りするが、軸はセルを束ねた
 * ものなので標本数が桁違いに大きい。同じ足切りを射影へ適用すると「どのセルが残るか」
 * ＝交差する軸に値が依存してしまうため、足切りは **軸の合計** で行う。
 *
 * 30 は「勝率のような比率で標準誤差が 1 段（勝率スケールの 9%）に収まる」目安
 * （n=30・p=0.5 で SE ≒ 9pt）。環境分析のセル足切り（HAVING n >= 30）とも揃う。
 */
export const AXIS_MIN_TOTAL_SAMPLES = 30

/**
 * 軸ラベルに色を付ける下限の強度（0=中立/最小 〜 1=極）。
 * これ未満は既定の文字色のままにして、意味のある差だけを色で示す。
 * 淡い色を文字色に使わないための可読性のガードでもある。
 */
export const AXIS_LABEL_MIN_INTENSITY = 0.12

/**
 * 軸ラベルに乗せる色。セルの中間段（くすみ黄緑など）は使わず、スケールの端だけを使う。
 *  - 勝率: 50% 未満は珊瑚（r1）、以上はティール（r11）
 *  - 件数・平均: そのメトリクスの最も濃い段
 * 実際の文字色は {@link axisLabelColor} で既定色と混ぜる。
 */
export function axisLabelEndColor(
  value: number,
  kind: 'rate' | 'sequential',
  sequentialMetric?: MetricKey,
): string {
  if (kind === 'rate') return value >= 0.5 ? 'var(--cell-r11)' : 'var(--cell-r1)'
  return sequentialCellColor(1, sequentialMetric ?? 'total')
}

/**
 * 軸ラベルの文字色（#409・`HeatmapChart` 用）。
 *
 * スケールの端の色を受け取り、「文字」として読める強さへ寄せて返す。
 * セル色は面（背景）として設計されているので、中間の淡い段はそのままでは文字に使えない。
 * 既定の文字色（--text）と混ぜることで、ライト・ダーク双方で contrast を確保する。
 * 強度が高いほど端の色の比率を上げ、弱いほど既定色寄りに落とす（＝閾値未満は既定色そのもの）。
 */
export function axisLabelColor(cellColor: string, intensity: number): string | undefined {
  const c = Math.max(0, Math.min(1, intensity))
  if (c < AXIS_LABEL_MIN_INTENSITY) return undefined
  // 弱 42%（ほぼ既定色）→ 強 78%（スケール色寄り）。
  // 弱い＝スケール上の淡い段なので、既定色の比率を高めに取らないと文字として読めない
  // （solarized-light で最も淡い段でも contrast 2.6 前後を確保する。Heatmap.tsx の
  //  明度 58%→48% 帯と同程度）。
  const pct = Math.round(42 + c * 36)
  return `color-mix(in srgb, ${cellColor} ${pct}%, var(--text))`
}

/**
 * 「値が無い / 足りない」セルを示す SVG ハッチ（斜線）パターン。
 *
 *  - データなし（そもそもバトルが無い）… ほぼ透明の地にハッチ灰の線（線だけ・控えめ）
 *  - サンプル不足（データはあるが N が足りない）… 指標色の上に背景色の斜線（#697）
 *
 * サンプル不足の斜線は透明の地なので、下に敷いたセル色が見える。
 * 線色は --cell-sparse-line（テーマ追従）。
 *
 * `id` は useId() などで要素ごとに一意にすること（同一ページに複数チャートが載るため）。
 */
const HATCH_PITCH = 6
/** 斜線太さ（サンプル不足・データなし共通）。 */
const HATCH_LINE = 1.5

function HatchPattern({ id, bg, line, opacity }: {
  id: string; bg: string; line: string; opacity: number
}) {
  const p = HATCH_PITCH
  return (
    <pattern id={id} width={p} height={p} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width={p} height={p} fill={bg} />
      <line x1={0} y1={0} x2={0} y2={p} stroke={line} strokeWidth={HATCH_LINE} opacity={opacity} />
    </pattern>
  )
}

/** サンプル不足の斜線。地は透明（下の指標色を見せる・#697）。線は背景色で 1（#383）。 */
export function SparseHatchPattern({ id }: { id: string }) {
  return <HatchPattern id={id} bg="transparent" line="var(--cell-sparse-line)" opacity={1} />
}

/** データなし（バトルが無い）。薄い地に薄い線で控えめに。 */
export function EmptyHatchPattern({ id }: { id: string }) {
  return <HatchPattern id={id} bg="var(--cell-empty)" line="var(--cell-empty-line)" opacity={0.55} />
}

/** ハッチセルの fill 値。対応する Pattern に渡した id と同じものを渡す。 */
export const hatchFill = (id: string) => `url(#${id})`
