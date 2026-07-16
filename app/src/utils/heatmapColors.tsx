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
 * 「サンプル不足」を示す SVG ハッチ（斜線）パターン。
 *
 * 欠損・サンプル不足は「値」ではないため、色スケール上の色を占有させない。
 * 色ではなく塗りの質（無塗り / ハッチ / べた塗り）で区別することで、
 * 中立グレーの中央と紛れなくなる。線色は --cell-sparse-line（テーマ追従）。
 *
 * `id` は useId() などで要素ごとに一意にすること（同一ページに複数チャートが載るため）。
 */
export function SparseHatchPattern({ id }: { id: string }) {
  return (
    <pattern id={id} width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width={6} height={6} fill="var(--cell-empty)" />
      <line x1={0} y1={0} x2={0} y2={6} stroke="var(--cell-sparse-line)" strokeWidth={1.5} opacity={0.55} />
    </pattern>
  )
}

/** サンプル不足セルの fill 値。`SparseHatchPattern` に渡した id と同じものを渡す。 */
export const sparseFill = (id: string) => `url(#${id})`
