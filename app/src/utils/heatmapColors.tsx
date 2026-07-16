/**
 * 勝率（発散スケール）の色マッピング（#351）。
 *
 * 同じ判定が HeatmapChart / CalendarHeatmapChart / CustomChartCard（散布図の点色）に
 * 重複していたため、ここへ集約する。勝率のスケールはアプリ全体で 1 つに保つ。
 *
 * 配色の考え方:
 *  - 発散スケールなので「2 色相（赤=負け越し / 青=勝ち越し）+ 中立の中央」。
 *    中央（50% 付近）は「情報が無い」ので、最も視覚的に静かでなければならない。
 *  - 中央に色相（黄・緑など）を置くと「無」ではなく独立したカテゴリに読めてしまい、
 *    発散スケールが 3 カテゴリの虹に見えるため使わない。
 *  - 実際の色は CSS 変数側（--cell-r1..r7）が持ち、テーマごとに明暗を反転させる。
 *    ダークは中央を背景へ沈める V 字、ライトは中央を明るくする Λ 字。
 */

/** 勝率 0..1 を 7 段階のセル色へ。50% を中心に、±5% を「引き分け帯」として中立に置く。 */
export function rateCellColor(value: number): string {
  const t = (value - 0.5) * 2 // 0..1 → -1..+1
  if (t < -0.6) return 'var(--cell-r1)' // 〜20%   赤・極
  if (t < -0.3) return 'var(--cell-r2)' // 20-35%
  if (t < -0.1) return 'var(--cell-r3)' // 35-45%
  if (t <= 0.1) return 'var(--cell-r4)' // 45-55%  中立
  if (t <= 0.3) return 'var(--cell-r5)' // 55-65%
  if (t <= 0.6) return 'var(--cell-r6)' // 65-80%
  return 'var(--cell-r7)' //               80%〜   青・極
}

/** 勝率凡例のカラーバー（rateCellColor と同じ 7 段・同じ並び）。 */
export const RATE_LEGEND_COLORS = [
  'var(--cell-r1)',
  'var(--cell-r2)',
  'var(--cell-r3)',
  'var(--cell-r4)',
  'var(--cell-r5)',
  'var(--cell-r6)',
  'var(--cell-r7)',
]

/**
 * 勝数・平均系（シーケンシャル）のセル色。正規化済みの 0..1 を 7 段階へ（#351）。
 *
 * 大きさは明度で表す。実際の色は --cell-c1..c7 が持ち、背景と accent の混色なので
 * ダークでは暗→明、ライトでは淡→濃と、テーマに応じて自動で正しい向きになる。
 */
export function sequentialCellColor(t: number): string {
  if (t <= 1 / 7) return 'var(--cell-c1)'
  if (t <= 2 / 7) return 'var(--cell-c2)'
  if (t <= 3 / 7) return 'var(--cell-c3)'
  if (t <= 4 / 7) return 'var(--cell-c4)'
  if (t <= 5 / 7) return 'var(--cell-c5)'
  if (t <= 6 / 7) return 'var(--cell-c6)'
  return 'var(--cell-c7)'
}

/** 勝数・平均系凡例のカラーバー（sequentialCellColor と同じ 7 段・同じ並び）。 */
export const SEQ_LEGEND_COLORS = [
  'var(--cell-c1)',
  'var(--cell-c2)',
  'var(--cell-c3)',
  'var(--cell-c4)',
  'var(--cell-c5)',
  'var(--cell-c6)',
  'var(--cell-c7)',
]

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
 * 2 種類とも同じ斜線で、「地と線の明暗を反転」させて描き分ける:
 *  - データなし（そもそもバトルが無い）      … 薄い地に薄い線（控えめ）
 *  - サンプル不足（データはあるが信頼できない）… グレー地に濃い線（反転・存在感がある）
 *
 * 「データはあるが足りない」方が「そもそも無い」より存在感がある、という順序づけ。
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

/** サンプル不足（データはあるが N が足りない）。グレー地に濃い線＝データなしの反転。 */
export function SparseHatchPattern({ id }: { id: string }) {
  return <HatchPattern id={id} bg="var(--cell-sparse-bg)" line="var(--cell-sparse-line)" opacity={0.75} />
}

/** データなし（バトルが無い）。薄い地に薄い線で控えめに。 */
export function EmptyHatchPattern({ id }: { id: string }) {
  return <HatchPattern id={id} bg="var(--cell-empty)" line="var(--cell-empty-line)" opacity={0.55} />
}

/** ハッチセルの fill 値。対応する Pattern に渡した id と同じものを渡す。 */
export const hatchFill = (id: string) => `url(#${id})`
