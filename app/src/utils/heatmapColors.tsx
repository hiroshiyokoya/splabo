import type { MetricKey } from '../types'

/**
 * 勝率（発散スケール）の色マッピング（#351）。
 *
 * 同じ判定が HeatmapChart / CalendarHeatmapChart / CustomChartCard（散布図の点色）に
 * 重複していたため、ここへ集約する。勝率のスケールはアプリ全体で 1 つに保つ。
 *
 * 配色の考え方:
 *  - 発散スケールなので「2 色相（ピンク=負け越し / 青=勝ち越し）+ 中立の中央」。
 *  - 「薄い＝中立 / 濃い＝極端」の濃淡モデル。中央は無彩色なので、明るくても
 *    「色としては何も言っていない」＝中立として読める。
 *  - 中央に色相（黄・緑など）を置くと「無」ではなく独立したカテゴリに読めてしまい、
 *    発散スケールが 3 カテゴリの虹に見えるため使わない。
 *  - 実際の色は CSS 変数側（--cell-r1..r11）が持つ。白黒方向へ振る濃淡なので
 *    背景に依存せず、ダーク・ライトとも同じ向きで読める。
 */

/**
 * 勝率 0..1 を 11 段階のセル色へ（#351）。
 * 中央の 45-55%（±5%）を「引き分け帯」として中立に置き、その外側を各 9% 刻みで 5 段ずつ。
 * 勝率は 2 色相を使うぶん段を細かく取れるので、他のメトリクス（7 段）より多い。
 */
export function rateCellColor(value: number): string {
  if (value < 0.09) return 'var(--cell-r1)'  // 〜9%   ピンク・極
  if (value < 0.18) return 'var(--cell-r2)'  // 9-18%
  if (value < 0.27) return 'var(--cell-r3)'  // 18-27%
  if (value < 0.36) return 'var(--cell-r4)'  // 27-36%
  if (value < 0.45) return 'var(--cell-r5)'  // 36-45%
  if (value <= 0.55) return 'var(--cell-r6)' // 45-55% 中立
  if (value <= 0.64) return 'var(--cell-r7)' // 55-64%
  if (value <= 0.73) return 'var(--cell-r8)' // 64-73%
  if (value <= 0.82) return 'var(--cell-r9)' // 73-82%
  if (value <= 0.91) return 'var(--cell-r10)'// 82-91%
  return 'var(--cell-r11)'                   // 91%〜  青・極
}

/** 勝率凡例のカラーバー（rateCellColor と同じ 11 段・同じ並び）。 */
export const RATE_LEGEND_COLORS = [
  'var(--cell-r1)', 'var(--cell-r2)', 'var(--cell-r3)', 'var(--cell-r4)', 'var(--cell-r5)',
  'var(--cell-r6)',
  'var(--cell-r7)', 'var(--cell-r8)', 'var(--cell-r9)', 'var(--cell-r10)', 'var(--cell-r11)',
]

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
    case 'avg_kd':
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
 * 「値が無い」セルを示す SVG ハッチ（斜線）パターン。
 *
 * 欠損・サンプル不足は「値」ではないため、色スケール上の色を占有させない。
 * 色ではなく塗りの質（ハッチ / べた塗り）で区別することで、中立グレーの中央と紛れなくなる。
 * 線色は --cell-sparse-line（テーマ追従）。
 *
 * 2 種類とも同じ斜線で、地の濃さで描き分ける:
 *  - データなし（そもそもバトルが無い）      … ほぼ透明の地に控えめな線
 *  - サンプル不足（データはあるが信頼できない）… 中立色の地に背景色の線
 *
 * 「データはあるが足りない」方が「そもそも無い」より地がはっきりしている、という順序づけ。
 * サンプル不足の地は divergent の中立色（最も淡い段）なので、色スケール上のどの実データ
 * よりも濃くならない＝欠損が実データより悪目立ちしない（#383）。
 *
 * `id` は useId() などで要素ごとに一意にすること（同一ページに複数チャートが載るため）。
 */
const HATCH_PITCH = 6

function HatchPattern({ id, bg, line, opacity }: {
  id: string; bg: string; line: string; opacity: number
}) {
  const p = HATCH_PITCH
  return (
    <pattern id={id} width={p} height={p} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width={p} height={p} fill={bg} />
      <line x1={0} y1={0} x2={0} y2={p} stroke={line} strokeWidth={1.5} opacity={opacity} />
    </pattern>
  )
}

/** サンプル不足（データはあるが N が足りない）。中立色の地に背景色の線。
 *  線が背景色になったため、opacity で薄めると地との差が消える。ここは 1 で描く（#383）。 */
export function SparseHatchPattern({ id }: { id: string }) {
  return <HatchPattern id={id} bg="var(--cell-sparse-bg)" line="var(--cell-sparse-line)" opacity={1} />
}

/** データなし（バトルが無い）。薄い地に薄い線で控えめに。 */
export function EmptyHatchPattern({ id }: { id: string }) {
  return <HatchPattern id={id} bg="var(--cell-empty)" line="var(--cell-empty-line)" opacity={0.55} />
}

/** ハッチセルの fill 値。対応する Pattern に渡した id と同じものを渡す。 */
export const hatchFill = (id: string) => `url(#${id})`
