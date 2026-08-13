import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { flushSync } from 'react-dom'
import {
  ScatterChart as RScatterChart, Scatter, XAxis, YAxis, ZAxis, CartesianGrid, ReferenceLine, ResponsiveContainer, Cell,
} from 'recharts'
import { PANEL_EXPORT_HTML_PREPARE_EVENT, PANEL_EXPORT_PREPARE_EVENT } from '../../utils/panelExport'

/**
 * 散布図 (presentational)。
 *
 * 呼び出し側 (CustomChartCard) で「ドット単位ごとのデータ」を
 * 既に points: { name, x, y, size, color, tooltipRows }[] に正規化して渡す。
 * ScatterChart 自体は metric や dotUnit を知らない。
 */

export interface ScatterPoint {
  name:        string
  x:           number | null
  y:           number | null
  size:        number | null   // null = 一定サイズ
  color:       string          // 既に CSS color に解決済み
  /** カテゴリ色分け時のマーカー形(未指定は circle)。 */
  markerShape?: ScatterMarkerShape
  /** ツールチップ見出しの左に出すアイコン(#412)。`color` と同じく **呼び出し側で解決済み**の
   *  data URI を渡す。画像が無ければ省略(アイコンなしで名前だけ出す)。
   *  ここで画像を取りに行かないのは、ホバーのたびに invoke を飛ばさないため。 */
  iconUrl?:    string | null
  tooltipRows: { label: string; value: string; muted?: boolean }[]
  /** 重なり判定用キー。同じ groupKey の点はツールチップで一緒に並べて表示する。
   *  バトル単位なら整数化された (x, y) 等、カテゴリ単位なら省略 (グループ化しない)。 */
  groupKey?:   string
  /** ツールチップ内で 1 行に詰める「個別ラベル」 (例: 日付 / ブキ / 勝敗)。
   *  groupKey で複数点まとまったとき、各点の name 部分として並ぶ。 */
  rowText?:    string
}

/** 散布図カテゴリの第2軸(色と組み合わせて使う)。 */
export type ScatterMarkerShape =
  | 'circle'
  | 'square'
  | 'triangle'
  | 'diamond'
  | 'cross'
  | 'star'

export type SizeLegend  = { label: string; items: { label: string; area: number }[] }
export type ColorLegend = {
  label: string
  items: { label: string | null; color: string; shape?: ScatterMarkerShape }[]
  /** 連続値グラデーション(既定)か、カテゴリチップ列か。 */
  layout?: 'gradient' | 'chips'
  /** chips のとき「色」だけか「色・形」か。凡例タイトルに使う。 */
  encoding?: 'color' | 'color_shape'
}

/** 半径 r のマーカー SVG(チャート本体・凡例で共有)。 */
export function ScatterMarkerGlyph({
  shape = 'circle',
  color,
  size = 12,
  fillOpacity = 0.85,
  stroke = 'var(--surface)',
  strokeWidth = 0.5,
  className,
}: {
  shape?:       ScatterMarkerShape
  color:        string
  /** 外接円の直径(px)。 */
  size?:        number
  fillOpacity?: number
  stroke?:      string
  strokeWidth?: number
  className?:   string
}) {
  const r = size / 2
  const cx = r
  const cy = r
  const common = { fill: color, fillOpacity, stroke, strokeWidth }
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden
      style={{ display: 'block', flexShrink: 0 }}
    >
      {markerElement(shape, cx, cy, r * 0.92, common)}
    </svg>
  )
}

function markerElement(
  shape: ScatterMarkerShape,
  cx: number,
  cy: number,
  r: number,
  common: { fill: string; fillOpacity: number; stroke: string; strokeWidth: number },
) {
  switch (shape) {
    case 'square': {
      const s = r * 1.55
      return <rect x={cx - s / 2} y={cy - s / 2} width={s} height={s} {...common} />
    }
    case 'triangle': {
      const h = r * 1.85
      const w = r * 1.95
      return (
        <polygon
          points={`${cx},${cy - h * 0.62} ${cx - w * 0.55},${cy + h * 0.42} ${cx + w * 0.55},${cy + h * 0.42}`}
          {...common}
        />
      )
    }
    case 'diamond': {
      const s = r * 1.25
      return (
        <polygon
          points={`${cx},${cy - s} ${cx + s},${cy} ${cx},${cy + s} ${cx - s},${cy}`}
          {...common}
        />
      )
    }
    case 'cross': {
      const arm = r * 1.15
      const t = Math.max(r * 0.38, 1.2)
      return (
        <path
          d={`M ${cx - t} ${cy - arm} H ${cx + t} V ${cy - t} H ${cx + arm} V ${cy + t} H ${cx + t} V ${cy + arm} H ${cx - t} V ${cy + t} H ${cx - arm} V ${cy - t} H ${cx - t} Z`}
          {...common}
        />
      )
    }
    case 'star': {
      const pts: string[] = []
      for (let i = 0; i < 5; i++) {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5
        const a2 = a + Math.PI / 5
        pts.push(`${cx + Math.cos(a) * r * 1.25},${cy + Math.sin(a) * r * 1.25}`)
        pts.push(`${cx + Math.cos(a2) * r * 0.52},${cy + Math.sin(a2) * r * 0.52}`)
      }
      return <polygon points={pts.join(' ')} {...common} />
    }
    case 'circle':
    default:
      return <circle cx={cx} cy={cy} r={r} {...common} />
  }
}

/** Recharts のホバー/クリック payload と描画 props が同じ点か(座標で判定)。 */
function sameScatterAnchor(
  a: { cx?: number; cy?: number } | null | undefined,
  b: { cx?: number; cy?: number } | null | undefined,
): boolean {
  if (!a || !b || a.cx == null || a.cy == null || b.cx == null || b.cy == null) return false
  return Math.abs(a.cx - b.cx) < 0.5 && Math.abs(a.cy - b.cy) < 0.5
}

/** HTML 書き出し用ツールチップ(#505)。埋め込み JS が `data-scatter-tip` を読む。 */
type ScatterTipPayload =
  | {
      kind: 'single'
      name: string
      iconUrl?: string | null
      rows: { label: string; value: string; muted?: boolean }[]
    }
  | {
      kind: 'group'
      groupTitle: string
      members: string[]
      more: number
    }

const SCATTER_TIP_ROW_LIMIT = 12

function buildScatterTipPayload(
  point: ScatterPoint,
  siblingsMap: Map<string, ScatterPoint[]>,
): ScatterTipPayload {
  const sibs = point.groupKey ? siblingsMap.get(point.groupKey) : undefined
  if (sibs && sibs.length > 1) {
    return {
      kind: 'group',
      groupTitle: `${point.tooltipRows.slice(0, 2).map(r => `${r.label} ${r.value}`).join(' / ')} (${sibs.length} 件)`,
      members: sibs.slice(0, SCATTER_TIP_ROW_LIMIT).map(p => p.rowText ?? p.name),
      more: Math.max(0, sibs.length - SCATTER_TIP_ROW_LIMIT),
    }
  }
  return {
    kind: 'single',
    name: point.name,
    iconUrl: point.iconUrl ?? null,
    rows: point.tooltipRows,
  }
}

/** ホバー中の画像マーカーに描く輪。
 *
 *  隣の画像と重なると輪が邪魔になるので、**細く・透かす**。
 *  どれを見ているか分かればよく、主張は要らない。 */
const IMAGE_RING_WIDTH   = 1.4
const IMAGE_RING_OPACITY = 0.32
/** 画像の外縁と輪のあいだの隙間。 */
const IMAGE_RING_GAP     = 2

/** チャートの余白と軸の太さ。軸のサイズは既定に頼らず**明示的に渡す**
 *  （Recharts の既定値が変わったら黙ってズレるため）。 */
const CHART_MARGIN   = { top: 20, right: 18, left: 0, bottom: 28 }
const Y_AXIS_WIDTH   = 56
/** X 軸が縦に取る高さ。Recharts の既定と同じ値を明示して渡す。 */
const X_AXIS_HEIGHT  = 30


// ---------------------------------------------------------------------------
// 重なった画像をカーソル中心にずらす（魚眼レンズ・#630）
// ---------------------------------------------------------------------------
//
// 画像モードは点が大きいので密集すると重なって読めない。
// **カーソルのまわりだけを引き伸ばす**。近いものほど大きく外へ動くので、
// 団子になっていたブキがほどけて 1 つずつ見えるようになる。
//
// 🔴 散布図は**位置が値**なので、ずらした位置をそのまま読まれると嘘になる。
// ただし引き出し線は引かない。全部の点が動くので線だらけになって、かえって読めない。
// 代わりに「カーソルを外せば元に戻る」ことと、効果の範囲を絞ることで担保する。
//
// 🔴 **塊を選んで散らす方式はやめた。** 以前は連結成分をたどって円周や空きへ
// 押しのけていたが、
//   - どこまでを 1 つの塊とみなすかが恣意的で、密なグラフでは全部が繋がる
//   - 広げる/畳むの切り替わりが跳ねる（当たり判定の円が要る）
//   - 端に寄ると散らす向きが偏り、一列に並ぶ
// レンズなら**連続関数**なので、カーソルを動かすとぬるっと変わり、境目も無い。

/** 効果が及ぶ半径(px)。これより遠い点は 1px も動かない。 */
const LENS_RADIUS = 130
/**
 * 反発の強さの落ち方。大きいほど**カーソルの近くだけが反発する**。
 *
 *     強さ = (1 - カーソルからの距離 / 半径)^F
 *
 *     カーソルから  13px → 0.73    ← ほどけてほしいのはここ
 *     　　　　　　  65px → 0.13
 *     　　　　　　 117px → 0.001   ← ほぼ動かない
 *
 * 🔴 これを緩くすると、遠くの点までじわじわ動いて画面全体が揺れて見える。
 */
const LENS_FALLOFF = 3
/** カーソルを外したとき、元の位置へ戻るまでの時間。 */
const LENS_COLLAPSE_MS = 220

/** 反発の反復回数。動かすのはレンズの中の点だけなので、毎フレーム回しても軽い。 */
const LENS_ITERATIONS = 60
/** 毎回どれだけレンズの目標位置へ引き戻すか。大きいほど「重なってでも元の形」寄り。 */
const LENS_PULL = 0.10
/** 完全に同じ座標のときに散らす向き(黄金角)。乱数を使わず毎回同じ結果にする。 */
const GOLDEN_ANGLE = 2.399963

type LensState = {
  /** カーソル位置（チャート座標）。 */
  x: number
  y: number
  /** 点の名前 → 元の位置からのずらし量。レンズの外の点は入らない。 */
  offsets: Map<string, { dx: number; dy: number }>
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi <= lo ? lo : hi)

/** カーソルからの距離に応じた反発の強さ（0〜1）。縁で 0 になるので段差が出ない。 */
function lensWeight(d: number): number {
  if (d >= LENS_RADIUS) return 0
  return Math.pow(1 - d / LENS_RADIUS, LENS_FALLOFF)
}

/**
 * カーソルのまわりのアイコンに**反発力を与える**(#630)。
 *
 * 🔴 カーソルから外へ押しのける（魚眼）のではない。それだと
 *   - ぴったり重なった 2 点は、何倍に引き伸ばしても離れない（距離 0 のまま）
 *   - 重なっていない点まで動くので、画面全体が揺れて見える
 *
 * ここでやるのは「カーソルに近いアイコンほど、**互いに強く反発する**」だけ。
 * 押し合う相手はアイコン同士で、カーソルは強さを決めるだけ。そのつど元の位置へ
 * 引き戻すので、重なりが解ける分だけ離れて止まる。
 *
 * この作りだと、**もともと離れているアイコンにカーソルを当てても何も起きない**。
 * 動くのは団子になっている所だけで、それ以外は静かなまま。狙いどおり。
 *
 * 動かすのは効果範囲の中の点だけ。外の点は動かない障害物として避ける。
 */
export function buildLens(
  cursorX: number,
  cursorY: number,
  basePos: Map<string, { x: number; y: number }>,
  imagePx: number,
): LensState {
  const span = imagePx

  // 🔴 収める範囲は**点が元から居る矩形**。プロット領域を計算・実測して使うのは
  // やめた。余白・軸の幅と高さ・Recharts の既定値・グリッド線の引かれ方など、
  // 依存するものが多すぎて何度も外した（下端で軸の高さを忘れ、左右でも外した）。
  //
  // 元の位置は軸の余白のぶんだけ内側に置かれていて、その余白は
  // `scatterEdgePadding()` が「画像の半分＋輪」以上を確保している。
  // つまり**点が元から居る範囲に収めれば、静止しているときと同じだけ安全**。
  // 何にも依存しないので、もう外しようがない。
  let lo = { x: Infinity, y: Infinity }
  let hi = { x: -Infinity, y: -Infinity }
  for (const p of basePos.values()) {
    if (p.x < lo.x) lo.x = p.x
    if (p.y < lo.y) lo.y = p.y
    if (p.x > hi.x) hi.x = p.x
    if (p.y > hi.y) hi.y = p.y
  }
  if (!Number.isFinite(lo.x)) { lo = { x: cursorX, y: cursorY }; hi = { x: cursorX, y: cursorY } }

  const moving: {
    name: string
    base: { x: number; y: number }
    /** カーソルへの近さから決まる反発の強さ（0〜1）。 */
    w: number
    x: number; y: number
    idx: number
  }[] = []
  const fixed: { x: number; y: number }[] = []

  let idx = 0
  for (const [name, p] of basePos) {
    const d = Math.hypot(p.x - cursorX, p.y - cursorY)
    if (d >= LENS_RADIUS) {
      // 効果範囲の外。動かないが、すぐ外側のものは避ける相手になる。
      if (d < LENS_RADIUS + span * 2) fixed.push(p)
      continue
    }
    // 出発点は**元の位置そのもの**。カーソルから外へは押さない。
    moving.push({ name, base: p, w: lensWeight(d), x: p.x, y: p.y, idx: idx++ })
  }

  for (let iter = 0; iter < LENS_ITERATIONS; iter++) {
    // 1. 元の位置へ引き戻す。これがあるので「重なりが解ける分だけ」離れる。
    for (const m of moving) {
      m.x += (m.base.x - m.x) * LENS_PULL
      m.y += (m.base.y - m.y) * LENS_PULL
    }
    // 2. 重なっている画像同士を押しのける。**押す量はカーソルへの近さで決まる。**
    //    遠い所の重なりは動かないので、画面全体が揺れない。
    for (let i = 0; i < moving.length; i++) {
      for (let j = i + 1; j < moving.length; j++) {
        const a = moving[i], b = moving[j]
        let dx = b.x - a.x, dy = b.y - a.y
        let dist = Math.hypot(dx, dy)
        if (dist >= span) continue
        if (dist < 1e-6) {
          // ぴったり重なっている。向きが決まらないので決め打ちにする
          // （乱数だとフレームごとに配置が変わってちらつく）。
          const angle = i * GOLDEN_ANGLE
          dx = Math.cos(angle); dy = Math.sin(angle); dist = 1
        }
        const w = (a.w + b.w) / 2
        const push = ((span - dist) / 2) * w
        const ux = dx / dist, uy = dy / dist
        a.x -= ux * push; a.y -= uy * push
        b.x += ux * push; b.y += uy * push
      }
    }
    // 3. 効果範囲の外の点からは自分だけ退く。
    for (const m of moving) {
      for (const o of fixed) {
        let dx = m.x - o.x, dy = m.y - o.y
        let dist = Math.hypot(dx, dy)
        if (dist >= span) continue
        if (dist < 1e-6) { dx = 1; dy = 0; dist = 1 }
        const push = (span - dist) * m.w
        m.x += (dx / dist) * push
        m.y += (dy / dist) * push
      }
    }
    // 4. 点が元から居る範囲の中へ。はみ出すと軸に載って見切れる。
    for (const m of moving) {
      m.x = clamp(m.x, lo.x, hi.x)
      m.y = clamp(m.y, lo.y, hi.y)
    }
  }

  const offsets = new Map<string, { dx: number; dy: number }>()
  for (const m of moving) {
    offsets.set(m.name, { dx: m.x - m.base.x, dy: m.y - m.base.y })
  }
  return { x: cursorX, y: cursorY, offsets }
}

/** 移動スタイル。画像・輪で**同じものを使う**（別々に書くと輪だけ遅れて動く）。
 *
 *  🔴 追従中は遷移を付けない。カーソルに合わせて毎フレーム変わるので、遷移を
 *  付けると常に追いかけ続けて遅れる。**なめらかさは関数の連続性で出す。**
 *  戻すときだけ、ぱっと消えないよう短い遷移を掛ける。 */
function lensMoveStyle(
  off: { dx: number; dy: number } | null,
  animate: boolean,
): CSSProperties {
  return {
    transformBox: 'fill-box',
    transformOrigin: 'center',
    transform: off ? `translate(${off.dx}px, ${off.dy}px)` : 'translate(0px, 0px)',
    transition: off || !animate ? undefined : `transform ${LENS_COLLAPSE_MS}ms ease`,
  }
}

/**
 * 選択中の輪を描く層(#630)。**画像より下に置く。**
 *
 * 🔴 点ごとに描いてはいけない。SVG は書いた順に重なるので、後から描かれた点の輪が
 * **先の点の画像の上を通る**。まとめて下の層に置けば、必ず画像が上に来る。
 *
 * Recharts 3 は子要素をそのまま順に描くので、`<Scatter>` より前に置けば下に来る
 * (2.x の `Customized` は `<g>` で包むだけのラッパーで、3.x では不要)。
 */
function ScatterUnderLayer({
  lens, basePos, activeName, imagePx, animate,
}: {
  lens:       LensState | null
  basePos:    Map<string, { x: number; y: number }>
  activeName: string | null
  imagePx:    number
  animate:    boolean
}) {
  if (!activeName) return null
  const activeBase = basePos.get(activeName)
  if (!activeBase) return null
  const off = lens?.offsets.get(activeName) ?? null
  return (
    <g pointerEvents="none">
      <g style={lensMoveStyle(off, animate)}>
        <circle
          cx={activeBase.x}
          cy={activeBase.y}
          r={imagePx / 2 + IMAGE_RING_GAP}
          fill="none"
          stroke="var(--text)"
          strokeWidth={IMAGE_RING_WIDTH}
          strokeOpacity={IMAGE_RING_OPACITY}
        />
      </g>
    </g>
  )
}

/** Recharts Scatter の shape コールバック。payload.markerShape を読む。 */
function scatterPointShape(props: {
  cx?: number
  cy?: number
  size?: number
  fill?: string
  fillOpacity?: number
  stroke?: string
  strokeWidth?: number
  payload?: ScatterPoint
  /** ツールチップ対象の点。カーソルが写らない画像保存でも対応点が分かるように強調する。 */
  active?: boolean
  /** HTML 保存向け。無いときは属性を付けない。 */
  tipJson?: string
  /** 画像モードの一辺(px)。指定があり `payload.iconUrl` もあるとき、図形の代わりに画像を描く(#627)。 */
  imagePx?: number
  /** ばらけ表示のずらし量(#630)。元の位置へは引き出し線を引く。 */
  offset?: { dx: number; dy: number; order: number } | null
  /** 遷移を付けるか(#630)。動きを減らす設定のときは false。 */
  animate?: boolean
}) {
  const cx = props.cx ?? 0
  const cy = props.cy ?? 0
  const area = props.size ?? 120
  const r = Math.sqrt(Math.max(area, 0) / Math.PI)
  const shape = props.payload?.markerShape ?? 'circle'

  // 画像モード(#627)。画像が無いブキは図形へフォールバックする
  // (stat.ink 由来でローカルマスターに無いブキがある)。
  const iconUrl = props.payload?.iconUrl
  if (props.imagePx && iconUrl) {
    const s = props.imagePx
    // レンズのずらし(#630)。
    //
    // 位置は x/y ではなく **CSS の transform** で動かす。属性を書き換えると
    // レイアウトを作り直すことになり、全点が毎フレーム動くこの用途では重い。
    const off = props.offset
    const animate = props.animate !== false
    // 🔴 選択中の輪は**ここでは描かない**(#630)。点ごとに描くと、後から描かれた点の
    // 輪が先の点の画像の上を通る。まとめて下の層へ(ScatterUnderLayer)。
    return (
      <g
        data-scatter-point="true"
        data-scatter-active={props.active ? 'true' : undefined}
        data-scatter-tip={props.tipJson}
      >
        <g style={lensMoveStyle(off ?? null, animate)}>
          <image
            href={iconUrl}
            x={cx - s / 2}
            y={cy - s / 2}
            width={s}
            height={s}
            // ヒット領域を画像全体にする(透明部分でもツールチップを出す)。
            style={{ pointerEvents: 'all' }}
          />
        </g>
      </g>
    )
  }
  const baseOpacity = props.fillOpacity ?? 0.55
  const common = {
    fill: props.fill ?? props.payload?.color ?? 'var(--accent)',
    fillOpacity: props.active ? Math.min(1, baseOpacity + 0.4) : baseOpacity,
    stroke: props.active ? 'var(--text)' : (props.stroke ?? 'var(--surface)'),
    strokeWidth: props.active ? 2 : (props.strokeWidth ?? 0.5),
  }
  // data 属性はツールチップ配置時に描画済みドットの実座標を読むために使う(#497)。
  // g で包んで Recharts のヒット領域も保つ。
  // アクティブ点は黒い枠で強調する（外側のアクセント〇は付けない・#525）。
  // data-scatter-tip は HTML 単体書き出しのホバー用(#505)。
  return (
    <g
      data-scatter-point="true"
      data-scatter-active={props.active ? 'true' : undefined}
      data-scatter-tip={props.tipJson}
    >
      {markerElement(shape, cx, cy, r, common)}
    </g>
  )
}

type TooltipDirection =
  | 'right' | 'left' | 'bottom' | 'top'
  | 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left'
type TooltipPlacement = { left: number; top: number; direction: TooltipDirection }
type ObstacleRect = { left: number; top: number; right: number; bottom: number }

const TOOLTIP_GAP = 14
const TOOLTIP_EDGE_PAD = 6
/** ドットを避けるときの外縁パディング。
 *
 *  ブキ画像は点より大きいので、4px では隣の画像に乗ってしまう。ただし広く取りすぎると
 *  空きが見つからず遠くへ飛ぶので、**重ならない最小限**にとどめる。 */
const DOT_AVOID_PAD = 6
/** 画像保存時はさらに広めに見て、被りゼロを狙いやすくする。 */
const EXPORT_DOT_AVOID_PAD = 12
/** アクティブ点とツールチップの間に最低限空ける余白。 */
const ANCHOR_CLEARANCE = 10
/** 候補を作るときの向きの刻み数。細かいほど「近くの空き」を見つけやすい。 */
const TOOLTIP_ANGLE_STEPS = 16
/** 1px 遠ざかることを、何 px² の重なりと同じ価値とみなすか。
 *
 *  大きいほど点の近くに留まり、小さいほど重なりを避けて遠くへ行く。 */
const TOOLTIP_REACH_WEIGHT = 40

/** 向きベクトルを 8 方位のラベルに落とす（`data-placement` 用）。 */
function directionLabel(dx: number, dy: number): TooltipDirection {
  const h = dx > 0.383 ? 'right' : dx < -0.383 ? 'left' : ''
  const v = dy > 0.383 ? 'bottom' : dy < -0.383 ? 'top' : ''
  if (h && v) return `${v}-${h}` as TooltipDirection
  return (v || h || 'right') as TooltipDirection
}

function rectsOverlap(
  a: { left: number; top: number; right: number; bottom: number },
  b: { left: number; top: number; right: number; bottom: number },
): { overlap: boolean; area: number } {
  const overlapW = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
  const overlapH = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))
  const area = overlapW * overlapH
  return { overlap: area > 0, area }
}

/**
 * ホバー点の周囲から、ドットを最も隠さないツールチップ位置を選ぶ(#497)。
 *
 * 優先順位:
 * 0. **自分のドットを隠さない**(端補正でスライドしても被らない方向を最優先)
 * 1. 重なるドット数が少ない
 * 2. 重なり面積が小さい
 * 3. 端からはみ出さないための補正量が小さい
 * 4. 同程度ならグラフ中心から外側へ向かう
 *
 * `richCandidates`(画像保存時)では斜め・遠めの候補も足して、他ドットとの被りゼロを狙いやすくする。
 */
export function chooseScatterTooltipPlacement({
  anchorX,
  anchorY,
  tooltipWidth,
  tooltipHeight,
  chartWidth,
  chartHeight,
  obstacles,
  anchorObstacle,
  gap = TOOLTIP_GAP,
  dotAvoidPad = DOT_AVOID_PAD,
  richCandidates = false,
}: {
  anchorX: number
  anchorY: number
  tooltipWidth: number
  tooltipHeight: number
  chartWidth: number
  chartHeight: number
  obstacles: ObstacleRect[]
  /** ツールチップ対象のドット。他点より優先して絶対に隠さない。 */
  anchorObstacle?: ObstacleRect | null
  /** ドット外縁からツールチップまでの距離。ハロー込みサイズに合わせて呼び出し側が広げる。 */
  gap?: number
  /** 他ドットを避けるときの外縁パディング。 */
  dotAvoidPad?: number
  /** 斜め・遠め候補を足す(画像保存向け)。 */
  richCandidates?: boolean
}): TooltipPlacement {
  // 候補は「点のまわりをぐるりと、近いところから」作る。
  //
  // 🔴 決め打ちの数箇所から選ぶと、**近くが空いていても遠くの候補が選ばれる**ことがある。
  // 向きを細かく刻んで距離を少しずつ伸ばし、被らない中で一番近いところを採る。
  const candidates: {
    direction: TooltipDirection
    left: number
    top: number
    dx: number
    dy: number
    /** 点からの距離。近いほどよい。 */
    reach: number
  }[] = []
  const rings = richCandidates
    ? [0, 10, 22, 38, 58, 84, 120]
    : [0, 12, 28, 50, 80]
  for (const extra of rings) {
    const r = gap + extra
    for (let k = 0; k < TOOLTIP_ANGLE_STEPS; k++) {
      const a = (k / TOOLTIP_ANGLE_STEPS) * Math.PI * 2
      const dx = Math.cos(a)
      const dy = Math.sin(a)
      // その向きへ、箱の手前の辺が点から r 離れるように置く。
      const cx = anchorX + dx * (r + tooltipWidth / 2)
      const cy = anchorY + dy * (r + tooltipHeight / 2)
      candidates.push({
        direction: directionLabel(dx, dy),
        left: cx - tooltipWidth / 2,
        top:  cy - tooltipHeight / 2,
        dx, dy,
        reach: r,
      })
    }
  }
  // 🔴 **四隅への退避はしない。** 環境分析のように点が密なグラフでは、近くに
  // 「まったく重ならない場所」が存在しない。空いているのは隅だけなので、
  // 「重なりが少ない順」で選ぶと隅まで飛ぶ。点から大きく外れたチップは読めない。
  // 近くで多少重なるほうがまし、という前提で下の重み付けを使う。

  const maxLeft = Math.max(TOOLTIP_EDGE_PAD, chartWidth - tooltipWidth - TOOLTIP_EDGE_PAD)
  const maxTop = Math.max(TOOLTIP_EDGE_PAD, chartHeight - tooltipHeight - TOOLTIP_EDGE_PAD)
  const outwardX = (anchorX - chartWidth / 2) / Math.max(chartWidth / 2, 1)
  const outwardY = (anchorY - chartHeight / 2) / Math.max(chartHeight / 2, 1)

  const anchorAvoid = anchorObstacle
    ? {
        left:   anchorObstacle.left - dotAvoidPad,
        top:    anchorObstacle.top - dotAvoidPad,
        right:  anchorObstacle.right + dotAvoidPad,
        bottom: anchorObstacle.bottom + dotAvoidPad,
      }
    : null

  const scored = candidates.map(candidate => {
    const left = Math.min(Math.max(candidate.left, TOOLTIP_EDGE_PAD), maxLeft)
    const top = Math.min(Math.max(candidate.top, TOOLTIP_EDGE_PAD), maxTop)
    const tip = { left, top, right: left + tooltipWidth, bottom: top + tooltipHeight }

    // 自分の点を隠すかどうかは他ドットより重い。端へ寄せた結果の被りもここで拾う。
    const anchorHit = anchorAvoid ? rectsOverlap(tip, anchorAvoid) : { overlap: false, area: 0 }

    let overlapCount = 0
    let overlapArea = 0
    for (const dot of obstacles) {
      const expanded = {
        left:   dot.left - dotAvoidPad,
        top:    dot.top - dotAvoidPad,
        right:  dot.right + dotAvoidPad,
        bottom: dot.bottom + dotAvoidPad,
      }
      const hit = rectsOverlap(tip, expanded)
      if (hit.overlap) {
        overlapCount += 1
        overlapArea += hit.area
      }
    }

    const clampDistance = Math.abs(left - candidate.left) + Math.abs(top - candidate.top)
    const outwardAlignment = candidate.dx * outwardX + candidate.dy * outwardY
    return {
      left,
      top,
      direction: candidate.direction,
      anchorCovered: anchorHit.overlap ? 1 : 0,
      anchorOverlapArea: anchorHit.area,
      overlapCount,
      overlapArea,
      // 端に寄せた補正も「遠ざかった量」として距離に含める。
      reach: candidate.reach + clampDistance,
      outwardAlignment,
    }
  })

  // 🔴 「自分の点を隠さない」だけは絶対。ここは辞書順で先に見る。
  //
  // そのうえで、**重なりと近さを天秤にかける**。辞書順で「重なりの少なさ」を先に
  // 見ると、点が密なグラフでは近くに空きが無いので、空いている隅まで飛んでしまう。
  // 逆に近さだけで決めると、すぐ隣のブキを隠す。
  //
  // `TOOLTIP_REACH_WEIGHT` は「1px 遠ざかることを、何 px² の重なりと同じ価値とみなすか」。
  // 40 なら、ブキ 1 つ(30px 角 ≒ 900px²)を隠すのを避けるために 20px ほど動く。
  // そこまでして避ける価値が無ければ、近い場所に留まる。
  const cost = (s: typeof scored[number]) => s.overlapArea + s.reach * TOOLTIP_REACH_WEIGHT
  scored.sort((a, b) =>
    a.anchorCovered - b.anchorCovered ||
    a.anchorOverlapArea - b.anchorOverlapArea ||
    cost(a) - cost(b) ||
    b.outwardAlignment - a.outwardAlignment,
  )
  const best = scored[0]
  return { left: best.left, top: best.top, direction: best.direction }
}

/** 目盛りラベルの小数を詰める(浮動小数の誤差も除去)。 */
const fmtTick = (v: number) => String(Math.round(v * 1000) / 1000)

/**
 * 比率(0–1)軸の目盛りラベル (#473)。
 *
 * ログ軸では 0.001 / 0.002 / 0.005 のような細かい目盛りが並ぶ。小数 0 桁固定だと
 * 全部 `0%` になって軸が読めないので、1% 未満は値に応じて桁を足す。
 */
const fmtRateTick = (v: number) => {
  const pct = v * 100
  if (!isFinite(pct) || pct === 0) return '0%'
  // 0.5% → 1 桁、0.05% → 2 桁。1e-9 は log10 の丸め誤差で 1 桁増えるのを防ぐため。
  const digits = Math.abs(pct) >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(Math.abs(pct)) - 1e-9))
  return `${pct.toFixed(digits)}%`
}

/**
 * ログ軸に載せられる値か (#381)。
 *
 * `log(0)` は定義されず、キルレは `D=0` で無限大になる。**0 以下と非有限は描けない**ので
 * 除外する(現実的にはどちらも試合数が少ないケース)。
 */
export const isLogPlottable = (v: number | null): v is number =>
  v !== null && Number.isFinite(v) && v > 0

/**
 * ログ軸の domain を実データから作る (#381)。
 *
 * 🔴 Recharts の `scale="log"` は **`domain={['auto','auto']}` と併用すると壊れる**ので、
 * 残った点の min/max を明示的に渡す必要がある。
 *
 * 全点が同じ値だと min === max になり軸が潰れるため、**1 桁ぶん広げる**。
 * 値が無ければ null(呼び出し側はログを諦めてリニアに落ちる)。
 *
 * min/max をそのまま渡すと端の点が軸線上に載ってドットが半分切れるため、余白を足す(#385)。
 * ログ軸はログ空間がピクセルに線形対応するので、余白も加算ではなく**乗除**で作る。
 * span に対する割合で広げるので、データの桁数によらず見た目の余白が一定になる。
 */
/**
 * 軸の両端に取る余白（データ範囲に対する割合）。リニア軸・ログ軸で共有する。
 *
 * 🔴 **小さいほどよい。** ここを広く取ると点が中央に寄り、プロット領域の外周が
 * 空白になる。散布図は点の散らばりを見るものなので、目盛りの少し外まで見えていれば足りる。
 *
 * マーカーが軸線に載って切れるのは、**ピクセル側の余白**（`SCATTER_EDGE_PADDING`）が
 * 防いでいる。こちらは値の空間なので、切れ対策としては二重になっている。
 * 以前は 0.10 / 0.12 も取っていて、そのぶん点が寄っていた。
 */
const AXIS_PAD_RATIO = 0.02
const LOG_PAD_RATIO  = AXIS_PAD_RATIO

/**
 * 🔴 範囲は**実データに寄せる**こと(#558)。
 *
 * #549 でキルレ軸を 1 について対称化していたが、データが 1 の片側に偏っているほど
 * 反対側に空白を作り、肝心のデータが潰れた(例: 0.9~3.4 → 0.22~4.56 で下半分が空)。
 * 「1 が軸の中央」より「データが見やすい」が優先。1 の位置は基準線と目盛りで示す。
 */
export function logDomain(values: number[]): [number, number] | null {
  const usable = values.filter(v => Number.isFinite(v) && v > 0)
  if (usable.length === 0) return null
  const min = Math.min(...usable)
  const max = Math.max(...usable)
  if (min === max) return [min / 10, max * 10]
  const pad = (Math.log10(max) - Math.log10(min)) * LOG_PAD_RATIO
  return [min / 10 ** pad, max * 10 ** pad]
}

/** ログ軸の目盛り候補。各桁に 1・2・5 を置く(1,2,5,10,20,50,100…)。 */
const LOG_MANTISSAS = [1, 2, 5]
/** 1/2/5 が 2 本も入らない狭いレンジ用の細かい系列。 */
const LOG_MANTISSAS_FINE = [1, 1.5, 2, 3, 4, 5, 7]

/**
 * ログ軸の目盛りを「切りのいい値」で作る (#387)。
 *
 * Recharts の自動生成は domain を等分するので半端な値になる。桁ごとに 1/2/5 を置いて
 * 人が読める並びにする。レンジが広いと本数が増えすぎるため、収まらなければ
 * 「10 の冪のみ」→「2 桁ごと」→「3 桁ごと」と順に粗くする。
 *
 * 切りのいい値が 2 本未満しか入らない狭いレンジでは null を返し、Recharts に任せる。
 */
export function logTicks(domain: [number, number], maxTicks = 10): number[] | null {
  const [lo, hi] = domain
  if (!(lo > 0) || !(hi > lo)) return null

  const build = (mantissas: number[], expStep: number): number[] => {
    const out: number[] = []
    const startExp = Math.floor(Math.log10(lo))
    const endExp = Math.ceil(Math.log10(hi))
    for (let e = startExp; e <= endExp; e += expStep) {
      for (const m of mantissas) {
        const v = m * 10 ** e
        if (v >= lo && v <= hi) out.push(v)
      }
    }
    return out
  }

  // 細かい順に候補を並べ、maxTicks に収まる最初のものを採る。
  const usable = [build(LOG_MANTISSAS, 1), build([1], 1), build([1], 2), build([1], 3)]
    .filter(t => t.length >= 2)
  if (usable.length === 0) {
    // レンジが狭くて 1/2/5 が 2 本も入らないケース(キルレ 1.2~2.0 など)。
    // ここで諦めると Recharts が domain を等分した半端な値を出すので、桁内をもう一段
    // 細かい系列で刻む。
    const fine = build(LOG_MANTISSAS_FINE, 1)
    return fine.length >= 2 && fine.length <= maxTicks ? fine : null
  }
  return usable.find(t => t.length <= maxTicks) ?? usable[usable.length - 1]
}

/**
 * リニア軸の目盛りを「切りのいい値」で作る (#547)。
 *
 * ドメインは端のドットが軸線に乗って切れないよう `expandLinearDomain()` で 10% 広げて
 * いるため、Recharts に任せるとその半端な端を等分した目盛りになる。刻みを 1/2/5 × 10^n
 * から選び直して、人が読める並びにする。
 *
 * 勝率のような 0~1 の比率でも同じ仕組みで足りる(0.05 = 5% 刻みが選ばれる)。
 * 目盛りが 2 本未満しか入らないときは null を返し、Recharts に任せる。
 */
export function linearTicks(
  domain: [number, number],
  maxTicks = 8,
  /**
   * 刻みの下限。ラベルの表示桁より細かい刻みを選ぶと**同じラベルが並ぶ**ため、
   * 呼び出し側の書式に合わせて渡す(勝率は整数 % 表示なので 0.01)。
   */
  minStep = 0,
): number[] | null {
  const [lo, hi] = domain
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(hi > lo)) return null

  // 目標本数から必要な刻みの下限を出し、それ以上で最小の 1/2/5 刻みを採る。
  let step = Math.max(niceStep((hi - lo) / maxTicks), minStep)
  for (let guard = 0; guard < 8; guard++) {
    const first = Math.ceil(lo / step) * step
    const out: number[] = []
    // 端の浮動小数誤差で最後の目盛りが落ちないよう、ごく小さな許容を足す。
    for (let v = first; v <= hi + step * 1e-9; v += step) {
      out.push(roundNice(Math.round(v / step) * step))
    }
    if (out.length >= 2 && out.length <= maxTicks) return out
    if (out.length > maxTicks) { step = niceStep(step * 1.5); continue }
    // 本数が足りない = 刻みが粗すぎる。1 段細かくして再試行する。
    // minStep より細かくはできないので、そこで諦めて Recharts に任せる。
    const finer = niceStep(step / 2.5)
    if (!(finer > 0) || finer >= step || finer < minStep) return null
    step = finer
  }
  return null
}

/**
 * メトリクスの「基準値」。この値に破線を引き、ログ軸ならこの値を中心に対称化する。
 *
 * 勝率は 0.5(引き分け)、キルレ系は 1(キルとデスが同数)が読みの境界になる。
 * 環境分析(`kd` / `contrib_kd`)とダッシュボード(`avg_kd` / `avg_contrib_kd`)で
 * メトリクスキーが違うので、両方をここにまとめて 2 画面で同じ判定を使う(#548)。
 */
const REF_LINE_BY_METRIC: Record<string, number> = {
  win_rate:       0.5,
  kd:             1,
  contrib_kd:     1,
  avg_kd:         1,
  avg_contrib_kd: 1,
}

export function metricRefLine(metric: string | null | undefined): number | undefined {
  return metric ? REF_LINE_BY_METRIC[metric] : undefined
}

/**
 * 目盛りに基準値(勝率 50% / キルレ 1)を必ず入れる(#558)。
 *
 * ドメイン内に基準線があるのに目盛りが無いと、破線だけが浮いて何の値か読めない。
 * 軸の範囲はデータに合わせて自動で決め、**1 の目盛りだけは必ず出す**のがルール。
 *
 * 目盛りを Recharts に任せている(null)ときは何もしない。1 本だけ足しても軸にならないため。
 */
export function withRefTick(
  ticks: number[] | null,
  ref: number | undefined,
  domain: [number, number] | undefined,
): number[] | null {
  if (!ticks || ref == null || !domain) return ticks
  const [lo, hi] = domain
  if (!(ref > lo && ref < hi)) return ticks
  // 浮動小数の誤差で「同じ値がもう 1 本」増えないよう、相対誤差で見る。
  const eps = Math.max(Math.abs(ref), 1) * 1e-9
  if (ticks.some(t => Math.abs(t - ref) <= eps)) return ticks
  return [...ticks, ref].sort((a, b) => a - b)
}

// ---------------------------------------------------------------------------
// 凡例(#420)
// ---------------------------------------------------------------------------
//
// サイズ・色にメトリクスを割り当てられる(#406)が、凡例が無いと「大きい＝何が多いのか」
// が画面から読めない。ホバーすればチップに出るが、全体を眺めているときに分からない。
//
// 凡例の中身(ラベル・値・色・面積)は **呼び出し側が組み立てて渡す**。環境分析と
// ダッシュボードで色スケールの作り方が違う(pointColor と colorOfValue)ため、
// それぞれの関数をそのまま使えるほうが破綻しない。

/** サイズ指標が割り当てられているときのドット面積レンジ(px²)。
 *
 *  🔴 凡例の円と実際のドットを一致させるため、ZAxis に渡す range と凡例の面積計算は
 *  **必ずこの定数を共有する**。片方だけ変えると凡例が嘘になる。 */
export const SIZE_AREA_RANGE: [number, number] = [40, 600]

/**
 * 軸端に確保する描画余白(px)。マーカーが軸線に載って半分切れるのを防ぐ。
 *
 * 🔴 これは**値の範囲ではなくピクセル**なので、勝率のように 0〜100% で頭打ちの軸でも
 * 「0% の下」「100% の上」に空白として見える。**必要な分だけにする。**
 * 一律 28px にしていたころは、小さい点のグラフでも上下に 28px ずつ空いていた。
 *
 * 実際に必要なのは「一番大きく描かれるマーカーの半径 + 強調ぶん」。
 */
function scatterEdgePadding(opts: {
  imagePx?: number
  hasSize?: boolean
  constSize: number
}): number {
  if (opts.imagePx) {
    // 画像の半分に、選択中に外へ付く輪のぶんを足す。
    return Math.ceil(opts.imagePx / 2 + IMAGE_RING_GAP + IMAGE_RING_WIDTH)
  }
  // ドットは面積指定。選択時のハロー・角形の対角ぶんを少し足す。
  const area = opts.hasSize ? SIZE_AREA_RANGE[1] : opts.constSize
  return Math.ceil(areaToRadius(area) + 6)
}

/**
 * 線形ドメインを値空間で広げ、上下限の点が軸線・clip に乗らないようにする。
 * (Axis padding だけだとログ軸の clip や nice tick の都合で足りないことがある)
 *
 * 広げる量は `AXIS_PAD_RATIO`。**点をプロット全体へ散らすため小さく取る**。
 */
function expandLinearDomain(
  domain: [number, number] | undefined,
  opts: { rate01?: boolean } = {},
): [number, number] | undefined {
  if (!domain) return undefined
  const [lo, hi] = domain
  const span = Math.max(hi - lo, opts.rate01 ? 0.05 : 1e-6)
  const pad = span * AXIS_PAD_RATIO
  let nlo = lo - pad
  let nhi = hi + pad
  if (opts.rate01) {
    nlo = Math.max(0, nlo)
    nhi = Math.min(1, nhi)
  } else if (lo >= 0) {
    nlo = Math.max(0, nlo)
  }
  return [nlo, nhi]
}

/** 有限な値だけの min/max。値が無いときは null。 */
function finiteRange(values: (number | null | undefined)[]): { min: number; max: number } | null {
  let mn = Infinity, mx = -Infinity
  for (const v of values) {
    if (v == null || !isFinite(v)) continue
    if (v < mn) mn = v
    if (v > mx) mx = v
  }
  return isFinite(mn) ? { min: mn, max: mx } : null
}

/**
 * 値 → ドットの面積(px²)。
 *
 * 🔴 Recharts の ZAxis のドメインは **[0, データ最大]** であって [最小, 最大] ではない。
 * `<ZAxis>` に domain を渡さないと `implicitZAxis.domain = [0, 'auto']` が効くため。
 * 実測で確認済み: range=[40,600]・データ [10,30,55,100] のとき、値 30 のドットは
 * 直径 16.27px = 面積 208 = 40 + (30/100)×560。[最小,最大] で正規化すると
 * 最小値のドットが 7.1px のはずが実際は 11.1px で、凡例が嘘になる。
 */
function valueToArea(v: number, max: number): number {
  const [aMin, aMax] = SIZE_AREA_RANGE
  const t = Math.min(1, Math.max(0, v / max))
  return aMin + (aMax - aMin) * t
}

/** 「キリのよい」刻み(1 / 2 / 5 × 10^n)。 */
function niceStep(x: number): number {
  if (x <= 0) return 1
  const base = Math.pow(10, Math.floor(Math.log10(x)))
  const f = x / base
  const nf = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10
  return nf * base
}

/** 浮動小数の誤差を落として表示・比較を安定させる。 */
function roundNice(x: number): number {
  if (!isFinite(x) || x === 0) return 0
  const p = Math.max(0, 6 - Math.floor(Math.log10(Math.abs(x))))
  const f = Math.pow(10, p)
  return Math.round(x * f) / f
}

/**
 * 凡例の下限。データ最小が max に比べて無視できる（0 含む）ときは、
 * 極小の 1/2/5 候補を並べない（#512 回帰: 0.00 が二重になる）。
 */
function legendFloor(min: number, max: number): number {
  if (!(max > 0)) return 0
  if (min > 0 && min >= max * 0.01) return min * 0.5
  return niceStep(max / 3)
}

/**
 * データ範囲から凡例用の切りのいい値を最大 `steps` 個選ぶ(#512)。
 * 1・2・5 × 10^n の候補から、範囲内をほぼ等分する。面積スケールはデータ max 基準なので ≤ max。
 */
function niceSizeLegendValues(min: number, max: number, steps: number): number[] {
  if (!(max > 0)) return []
  if (!(max > min) || steps <= 1) return [max]

  const lo = legendFloor(min, max)
  const cands: number[] = []
  const seen = new Set<number>()
  const push = (v: number) => {
    const r = roundNice(v)
    if (r <= 0 || r > max || r < lo) return
    if (seen.has(r)) return
    seen.add(r)
    cands.push(r)
  }

  const startExp = Math.floor(Math.log10(Math.max(lo, Number.MIN_VALUE)))
  const endExp = Math.floor(Math.log10(max))
  for (let e = startExp; e <= endExp; e++) {
    for (const m of [1, 2, 5]) push(m * Math.pow(10, e))
  }
  // max 側の代表(83 → 50、または max 自体が 1/2/5 ならそれ)
  push(Math.floor(max / niceStep(max / 2)) * niceStep(max / 2))
  push(max)

  cands.sort((a, b) => a - b)
  if (cands.length === 0) return [max]
  if (cands.length <= steps) return cands

  // 先頭・末尾を残し、間を等間隔インデックスで取る
  const out: number[] = []
  for (let i = 0; i < steps; i++) {
    const idx = Math.round((i / (steps - 1)) * (cands.length - 1))
    const v = cands[idx]
    if (!out.length || out[out.length - 1] !== v) out.push(v)
  }
  return out
}

/**
 * サイズ凡例を作る。切りのいい代表値を並べる(#512)。
 *
 * Recharts は面積を `radius = sqrt(面積 / π)` で描く(recharts/es6/cartesian/Scatter.js)。
 * 凡例の円も同じ式で描くので実際のドットと一致する。
 */
export function buildSizeLegend(
  label: string, values: (number | null)[], fmt: (v: number) => string, steps = 3,
): SizeLegend | null {
  const r = finiteRange(values)
  // max <= 0 だと面積の比率が作れない(実データでは件数・平均値なので起きない)。
  if (!r || r.max <= 0) return null
  const vals = niceSizeLegendValues(r.min, r.max, steps)
  // 表示ラベルが同じ値は落とす(0.001 と 0.002 がどちらも 0.00 など)。
  const items: { label: string; area: number }[] = []
  const seenLabels = new Set<string>()
  for (const v of vals) {
    const item = { label: fmt(v), area: valueToArea(v, r.max) }
    if (seenLabels.has(item.label)) continue
    seenLabels.add(item.label)
    items.push(item)
  }
  if (items.length === 0) return null
  return { label, items }
}

/** 面積(px²)→ 半径。Recharts のドットと同じ式。 */
export function areaToRadius(area: number): number {
  return Math.sqrt(Math.max(area, 0) / Math.PI)
}

/**
 * 色凡例を作る。`colorOf` は **本体のドットと同じ関数**を渡すこと(色がズレないため)。
 * 値のラベルは両端と中央だけに付ける(全段に付けると数字が潰れて読めない)。
 */
export function buildColorLegend(
  label: string, values: (number | null)[], fmt: (v: number) => string,
  colorOf: (v: number) => string, steps = 7,
): ColorLegend | null {
  const r = finiteRange(values)
  // 幅が無いと全ドットが同じ色なので、帯にして説明することが無い。
  if (!r || r.max <= r.min) return null
  const mid = Math.floor(steps / 2)
  const items = Array.from({ length: steps }, (_, i) => {
    const v = r.min + (r.max - r.min) * (i / (steps - 1))
    const showLabel = i === 0 || i === steps - 1 || i === mid
    return { label: showLabel ? fmt(v) : null, color: colorOf(v) }
  })
  return { label, items }
}

function ScatterLegends({ sizeLegend, colorLegend }: { sizeLegend?: SizeLegend | null; colorLegend?: ColorLegend | null }) {
  if (!sizeLegend && !colorLegend) return null
  // 一番大きい円に合わせて行の高さを取る(円が上下で切れないように)。
  const maxR = sizeLegend ? areaToRadius(Math.max(...sizeLegend.items.map(i => i.area))) : 0
  // サイズ凡例の円の色。色にもメトリクスを割り当てているときは実際のドットが
  // そのスケールの色になるので、accent のままだと凡例だけ違う色で浮く。
  // 色凡例の**中央のスウォッチ**を借りれば、常に実際のドットと同じパレットになる。
  const dotColor = colorLegend
    ? colorLegend.items[Math.floor(colorLegend.items.length / 2)].color
    : 'var(--accent)'
  return (
    <div className="scatter-legend">
      {sizeLegend && (
        <div className="scatter-legend-group">
          <span className="scatter-legend-title">サイズ: {sizeLegend.label}</span>
          <span className="scatter-legend-items" style={{ minHeight: maxR * 2 }}>
            {sizeLegend.items.map((it, i) => (
              <span className="scatter-legend-size" key={i}>
                <span
                  className="scatter-legend-dot"
                  style={{ width: areaToRadius(it.area) * 2, height: areaToRadius(it.area) * 2, background: dotColor }}
                />
                <span className="scatter-legend-value">{it.label}</span>
              </span>
            ))}
          </span>
        </div>
      )}
      {colorLegend && (
        <div className="scatter-legend-group">
          <span className="scatter-legend-title">
            {colorLegend.encoding === 'color_shape' ? '色・形' : '色'}: {colorLegend.label}
          </span>
          <span className="scatter-legend-items">
            {colorLegend.layout === 'chips' ? (
              <span className="scatter-legend-chips">
                {colorLegend.items.map((it, i) => (
                  <span className="scatter-legend-chip-item" key={i} title={it.label ?? undefined}>
                    {colorLegend.encoding === 'color_shape' ? (
                      <ScatterMarkerGlyph
                        shape={it.shape ?? 'circle'}
                        color={it.color}
                        size={12}
                        className="scatter-legend-marker"
                      />
                    ) : (
                      <span className="scatter-legend-chip" style={{ background: it.color }} />
                    )}
                    <span className="scatter-legend-value">{it.label ?? ' '}</span>
                  </span>
                ))}
              </span>
            ) : (
              <span className="scatter-legend-bar">
                {colorLegend.items.map((it, i) => (
                  <span className="scatter-legend-band" key={i}>
                    <span className="scatter-legend-chip" style={{ background: it.color }} />
                    <span className="scatter-legend-value">{it.label ?? ' '}</span>
                  </span>
                ))}
              </span>
            )}
          </span>
        </div>
      )}
    </div>
  )
}

export function ScatterChart({
  points, xLabel, yLabel, xIsRate, yIsRate, xDomain, yDomain, xRefLine, yRefLine, hasSize, xLogScale, yLogScale, fillOpacity = 0.55, constSize = 120, height = 320,
  sizeLegend, colorLegend, imagePx,
}: {
  points:       ScatterPoint[]
  xLabel:       string
  yLabel:       string
  xIsRate?:     boolean
  yIsRate?:     boolean
  /** X 軸をログスケールにする (#381)。0 以下・非有限の点は描けないので除外される。 */
  xLogScale?:   boolean
  /** Y 軸をログスケールにする (#381)。 */
  yLogScale?:   boolean
  /** 明示ドメイン [min, max]。指定時は xIsRate の [0,1] 既定より優先(オートスケール用)。 */
  xDomain?:     [number, number]
  yDomain?:     [number, number]
  /** 基準線(例: 勝率 0.5)。指定軸に破線を引く。 */
  xRefLine?:    number
  yRefLine?:    number
  hasSize?:     boolean
  /** ドットの塗り透過度。未指定時は環境分析・ダッシュボードと同じ 0.55(#435)。 */
  fillOpacity?: number
  /** サイズメトリクス未指定時の一定サイズ。ブキ/ステージは大きめ (280)、バトルは小さめ (120) を想定。
   *  ZAxis range のピクセル面積。 */
  constSize?:   number
  height?:      number
  /** ドットのサイズ・色が何を表しているかの凡例(#420)。buildSizeLegend / buildColorLegend で作る。
   *  未指定(サイズ・色にメトリクスを割り当てていない)なら出さない。 */
  sizeLegend?:  SizeLegend | null
  colorLegend?: ColorLegend | null
  /** 点をブキ画像で描く(#627)。一辺の px。指定時はサイズ・色メトリクスが効かない。
   *  画像を持たない点は従来の図形にフォールバックする。 */
  imagePx?:     number
}) {
  const [hover, setHover] = useState<ScatterPoint | null>(null)
  // クリックでピン留め。保存ボタンへマウスを移してもツールチップが消えないようにする。
  const [pinned, setPinned] = useState<ScatterPoint | null>(null)
  // カーソル中心のレンズ(#630)。ピン留め中はカーソルが外れても保つ（画像保存用）。
  const [lens, setLens] = useState<LensState | null>(null)
  const [lensPinned, setLensPinned] = useState(false)
  const [tooltipPlacement, setTooltipPlacement] = useState<TooltipPlacement | null>(null)
  // 画像保存直前に立てる。配置を斜め・遠め候補込みでやり直す。
  const [exportLayout, setExportLayout] = useState(false)
  const areaRef = useRef<HTMLDivElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const active = hover ?? pinned

  // X / Y どちらか null は描画対象外
  const plotted = useMemo(() => points.filter(p => p.x !== null && p.y !== null), [points])

  // ログ軸に載る点だけに絞る (#381)。リニアなら plotted と同じ。
  const drawable = useMemo(() => {
    if (!xLogScale && !yLogScale) return plotted
    return plotted.filter(p =>
      (!xLogScale || isLogPlottable(p.x)) && (!yLogScale || isLogPlottable(p.y)),
    )
  }, [plotted, xLogScale, yLogScale])

  // ログ軸で落ちた件数。**黙って消さない**ための注記に使う(切り替えた瞬間に点が減るので、
  // 理由が見えないとバグに見える)。
  const droppedByLog = plotted.length - drawable.length

  // 🔴 Recharts の scale="log" は domain={['auto','auto']} と併用すると壊れるので、
  // 残った点から min/max を作って明示的に渡す。点が全部落ちたらリニアに落とす。
  // 範囲は実データに寄せる。基準値(キルレ 1)を軸の中央に置くための対称化はしない(#558)。
  const xLogDomain = useMemo(
    () => (xLogScale ? logDomain(drawable.map(p => p.x as number)) : null),
    [drawable, xLogScale],
  )
  const yLogDomain = useMemo(
    () => (yLogScale ? logDomain(drawable.map(p => p.y as number)) : null),
    [drawable, yLogScale],
  )
  // ログ軸の目盛りは 1/2/5 系列で明示する(#387)。Recharts 任せだと domain を等分した
  // 半端な値になる。null のときは従来どおり Recharts に任せる。
  const xLogTicks = useMemo(() => (xLogDomain ? logTicks(xLogDomain) : null), [xLogDomain])
  const yLogTicks = useMemo(() => (yLogDomain ? logTicks(yLogDomain) : null), [yLogDomain])
  const xLog = xLogDomain !== null
  const yLog = yLogDomain !== null

  // 明示ドメインが無いリニア軸は実データから作る。Recharts の auto に任せると
  // ドメインが分からず目盛りを組み立てられない(#547)。比率軸は従来どおり 0~1 を基準にする。
  const xDataRange = useMemo(() => finiteRange(drawable.map(p => p.x)), [drawable])
  const yDataRange = useMemo(() => finiteRange(drawable.map(p => p.y)), [drawable])

  // 端のマーカーが切れないよう、線形ドメインは値空間でも少し広げる。
  // ログ軸は logDomain 側の余白を使う。
  const xAxisDomain = xLogDomain
    ?? expandLinearDomain(xDomain, { rate01: xIsRate })
    ?? (xIsRate
          ? expandLinearDomain([0, 1], { rate01: true })
          : expandLinearDomain(xDataRange ? [xDataRange.min, xDataRange.max] : undefined))
  const yAxisDomain = yLogDomain
    ?? expandLinearDomain(yDomain, { rate01: yIsRate })
    ?? (yIsRate
          ? expandLinearDomain([0, 1], { rate01: true })
          : expandLinearDomain(yDataRange ? [yDataRange.min, yDataRange.max] : undefined))

  // リニア軸の目盛りも 1/2/5 系列で明示する(#547)。
  // 勝率は `fmtRateTick` が整数 % に丸めるので、1% より細かい刻みは選ばせない
  // (0.5% 刻みにすると「50%」が 2 本並ぶ)。
  // 横軸はラベルが横に並ぶので本数を抑えめに、縦軸は縦に積むので少し多めでよい。
  // 最後に基準値(勝率 50% / キルレ 1)を必ず足す。範囲は自動、1 の目盛りは出す(#558)。
  //
  // ログ軸で `logTicks` が null(レンジが狭くて 1/2/5 が 2 本入らない)のときは
  // リニア刻みに落とす。1 桁に満たないレンジならログとリニアの見た目はほぼ同じで、
  // Recharts の半端な自動目盛りに任せるより読める。目盛りが無いと基準値も足せない。
  const xTicks = useMemo(
    () => withRefTick(
      xAxisDomain ? (xLogTicks ?? linearTicks(xAxisDomain, 8, xIsRate ? 0.01 : 0)) : null,
      xRefLine, xAxisDomain,
    ),
    [xLogTicks, xIsRate, xRefLine, xAxisDomain?.[0], xAxisDomain?.[1]],
  )
  const yTicks = useMemo(
    () => withRefTick(
      yAxisDomain ? (yLogTicks ?? linearTicks(yAxisDomain, 10, yIsRate ? 0.01 : 0)) : null,
      yRefLine, yAxisDomain,
    ),
    [yLogTicks, yIsRate, yRefLine, yAxisDomain?.[0], yAxisDomain?.[1]],
  )

  // groupKey → siblings: 重なり判定用に同一 groupKey の点を集約
  const siblings = useMemo(() => {
    const m = new Map<string, ScatterPoint[]>()
    for (const p of drawable) {
      if (!p.groupKey) continue
      const arr = m.get(p.groupKey) ?? []
      arr.push(p)
      m.set(p.groupKey, arr)
    }
    return m
  }, [drawable])

  const hoverSiblings = active?.groupKey ? (siblings.get(active.groupKey) ?? [active]) : (active ? [active] : [])
  const ROW_LIMIT = SCATTER_TIP_ROW_LIMIT

  // サイズ範囲 (sqrt スケール)。指定なしは ZAxis で一定サイズ。
  // 🔴 凡例と同じ定数を使う(SIZE_AREA_RANGE のコメント参照)。
  const zRange: [number, number] = hasSize ? SIZE_AREA_RANGE : [constSize, constSize]

  // 軸端の余白は、実際に描かれるマーカーの大きさから出す(一律に取ると空白が目立つ)。
  const edgePad = scatterEdgePadding({ imagePx, hasSize, constSize })

  // ばらけ表示用に、各点の**元の**描画座標を控える(#630)。
  //
  // `shape` コールバックに来る cx/cy は常に元の位置なので、広げている最中でも
  // ここは base のまま保たれる。データが変わったら作り直す(古い名前を残さない)。
  //
  // キーは点の名前。画像モードはブキ単位だけなので名前は一意(#627)。
  const basePos = useMemo(() => new Map<string, { x: number; y: number }>(), [drawable])
  // rAF のコールバックから読むので ref でも持つ（クロージャが古い Map を掴まないように）。
  const basePosRef = useRef(basePos)
  basePosRef.current = basePos

  // データ・サイズ・モードが変わったら、ずらしたままにしない(座標が合わなくなる)。
  useEffect(() => {
    setLens(null)
    setLensPinned(false)
  }, [drawable, imagePx])

  // ツールチップの再配置は、レンズが**ある程度動いたときだけ**やる(#630)。
  // 配置は全マーカーの実寸を読んで決めるので、毎フレームやると重い。
  const lensKey = lens ? `${Math.round(lens.x / 24)},${Math.round(lens.y / 24)}` : ''

  // 動きを減らす設定を尊重する。ずれること自体は情報なので残し、戻りの遷移だけ切る。
  const reduceMotion = useMemo(
    () => typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true,
    [],
  )

  // ツールチップを一度 hidden で描画して実寸を測り、上下左右の最適位置へ移す。
  // マーカーも DOM の実寸を読むため、形・サイズ指標の有無にかかわらず避けられる(#497)。
  // 自分の点(ハロー込み)は他点より優先して隠さない。
  useLayoutEffect(() => {
    const area = areaRef.current
    const tooltip = tooltipRef.current
    if (!active || !area || !tooltip) return

    // ずれているときはツールチップも移動先に付ける(#630)。元の位置に出すと、
    // どの画像の説明なのか分からなくなる。
    const baseX = (active as unknown as { cx?: number }).cx ?? 0
    const baseY = (active as unknown as { cy?: number }).cy ?? 0
    const off = lens?.offsets.get(active.name) ?? null
    const anchorX = baseX + (off?.dx ?? 0)
    const anchorY = baseY + (off?.dy ?? 0)
    const areaRect = area.getBoundingClientRect()
    const tooltipRect = tooltip.getBoundingClientRect()

    const toLocal = (rect: DOMRect): ObstacleRect => ({
      left:   rect.left - areaRect.left,
      top:    rect.top - areaRect.top,
      right:  rect.right - areaRect.left,
      bottom: rect.bottom - areaRect.top,
    })

    const markers = [...area.querySelectorAll<SVGGElement>('[data-scatter-point="true"]')]
    const activeMarker = area.querySelector<SVGGElement>('[data-scatter-active="true"]')
    const anchorObstacle = activeMarker
      ? toLocal(activeMarker.getBoundingClientRect())
      : {
          left:   anchorX - 6,
          top:    anchorY - 6,
          right:  anchorX + 6,
          bottom: anchorY + 6,
        }

    // ハロー込みの外接円半径＋余白。固定 14px だと大きいドットにツールチップが被る。
    const anchorHalf = Math.max(
      (anchorObstacle.right - anchorObstacle.left) / 2,
      (anchorObstacle.bottom - anchorObstacle.top) / 2,
    )
    const gap = Math.max(TOOLTIP_GAP, Math.ceil(anchorHalf + ANCHOR_CLEARANCE))

    const obstacles = markers
      .map(marker => toLocal(marker.getBoundingClientRect()))
      // アクティブ点自身と、完全に同じ座標に重なった兄弟点は通常障害物から除く
      // (自分への被りは anchorObstacle 側で最優先に扱う)。
      .filter(rect => {
        const centerX = (rect.left + rect.right) / 2
        const centerY = (rect.top + rect.bottom) / 2
        return Math.abs(centerX - anchorX) > 1 || Math.abs(centerY - anchorY) > 1
      })

    setTooltipPlacement(chooseScatterTooltipPlacement({
      anchorX,
      anchorY,
      tooltipWidth: tooltipRect.width,
      tooltipHeight: tooltipRect.height,
      chartWidth: area.clientWidth,
      chartHeight: height,
      obstacles,
      anchorObstacle,
      gap,
      dotAvoidPad: exportLayout ? EXPORT_DOT_AVOID_PAD : DOT_AVOID_PAD,
      // 斜め・遠め・四隅の候補も常に見る。**離れてもいいから重ねない**ほうが読みやすい。
      // 遠い候補は順位付けで最後に回るので、近くに空きがあればそちらが選ばれる。
      richCandidates: true,
    }))
  }, [active, hoverSiblings.length, height, exportLayout, lensKey])

  // チャート上から保存ボタンへ移ってもツールチップを残す。
  // 消すのは「パネル全体」から出たときだけ(.chart-card / .env-chart-section)。
  const pinnedRef = useRef(pinned)
  pinnedRef.current = pinned
  const lensPinnedRef = useRef(lensPinned)
  lensPinnedRef.current = lensPinned

  // カーソル位置からレンズを更新する(#630)。
  //
  // 🔴 マウス移動のたびに state を更新すると、点の数だけ再描画が走って詰まる。
  // **1 フレームに 1 回**にまとめる。マウスイベントは 1 フレームに何度も来る。
  const lensFrameRef = useRef<number | null>(null)
  const lensPendingRef = useRef<{ x: number; y: number } | null>(null)
  const moveLens = useCallback((clientX: number, clientY: number) => {
    const area = areaRef.current
    if (!imagePx || !area || lensPinnedRef.current) return
    const rect = area.getBoundingClientRect()
    lensPendingRef.current = { x: clientX - rect.left, y: clientY - rect.top }
    if (lensFrameRef.current !== null) return
    lensFrameRef.current = requestAnimationFrame(() => {
      lensFrameRef.current = null
      const p = lensPendingRef.current
      const el = areaRef.current
      if (!p || !el || !imagePx) return
      setLens(buildLens(p.x, p.y, basePosRef.current, imagePx))
    })
  }, [imagePx])

  useEffect(() => () => {
    if (lensFrameRef.current !== null) cancelAnimationFrame(lensFrameRef.current)
  }, [])
  useEffect(() => {
    const area = areaRef.current
    if (!area) return
    const panel = area.closest('.chart-card, .env-chart-section')
    if (!panel) return

    const onPanelLeave = (e: Event) => {
      const related = (e as MouseEvent).relatedTarget as Node | null
      if (related && panel.contains(related)) return
      setHover(null)
      // ピン留め中はパネル外でも残す(明示クリック解除まで)。
      if (!pinnedRef.current) setTooltipPlacement(null)
      if (!lensPinnedRef.current) setLens(null)
    }
    const onExportPrepare = () => {
      // キャプチャ前に同期で配置し直す(次フレーム待ちだけでは React 更新が間に合わない)。
      flushSync(() => setExportLayout(true))
    }
    const onHtmlPrepare = () => {
      // HTML では埋め込み JS にホバーを任せるので、アプリ側の固定チップは消す。
      flushSync(() => {
        setHover(null)
        setPinned(null)
        setTooltipPlacement(null)
        setExportLayout(false)
      })
    }
    panel.addEventListener('mouseleave', onPanelLeave)
    panel.addEventListener(PANEL_EXPORT_PREPARE_EVENT, onExportPrepare)
    panel.addEventListener(PANEL_EXPORT_HTML_PREPARE_EVENT, onHtmlPrepare)
    return () => {
      panel.removeEventListener('mouseleave', onPanelLeave)
      panel.removeEventListener(PANEL_EXPORT_PREPARE_EVENT, onExportPrepare)
      panel.removeEventListener(PANEL_EXPORT_HTML_PREPARE_EVENT, onHtmlPrepare)
    }
  }, [])

  // 保存が終わって is-exporting が外れたら、通常の配置モードに戻す。
  useEffect(() => {
    const area = areaRef.current
    if (!area) return
    const panel = area.closest('.chart-card, .env-chart-section')
    if (!panel) return
    const obs = new MutationObserver(() => {
      if (!panel.classList.contains('is-exporting')) setExportLayout(false)
    })
    obs.observe(panel, { attributes: true, attributeFilter: ['class'] })
    return () => obs.disconnect()
  }, [])

  return (
    <div
      className="chart-hover-area"
      ref={areaRef}
      style={{ position: 'relative' }}
      // レンズはカーソルそのものを中心にする(#630)。
      //
      // 🔴 点に乗ったかどうかは見ない。**カーソルの位置だけ**で決まるので、
      // 「広げた瞬間に画像が逃げて mouseleave」というチカチカが起きようがない。
      // 当たり判定の円も要らなくなった。
      onMouseMove={e => moveLens(e.clientX, e.clientY)}
    >
    <ResponsiveContainer width="100%" height={height}>
      <RScatterChart margin={CHART_MARGIN}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
        {/* ログ軸では 0 以下の基準線は載らない(extendDomain で軸ごと壊れるため出さない)。 */}
        {xRefLine != null && (!xLog || xRefLine > 0) && (
          <ReferenceLine x={xRefLine} stroke="var(--text-muted)" strokeDasharray="5 4" ifOverflow="extendDomain" />
        )}
        {yRefLine != null && (!yLog || yRefLine > 0) && (
          <ReferenceLine y={yRefLine} stroke="var(--text-muted)" strokeDasharray="5 4" ifOverflow="extendDomain" />
        )}
        <XAxis
          type="number"
          dataKey="x"
          name={xLabel}
          height={X_AXIS_HEIGHT}
          padding={{ left: edgePad, right: edgePad }}
          tick={{ fill: 'var(--text)', fontSize: 10, fontWeight: 600 } as object}
          tickFormatter={xIsRate ? fmtRateTick : fmtTick}
          scale={xLog ? 'log' : 'auto'}
          allowDataOverflow={xLog}
          domain={xAxisDomain ?? ['auto', 'auto']}
          ticks={xTicks ?? undefined}
          label={{ value: xLabel, position: 'insideBottom', offset: -10, fill: 'var(--text)', fontSize: 11, fontWeight: 600 } as object}
        />
        <YAxis
          type="number"
          dataKey="y"
          name={yLabel}
          padding={{ top: edgePad, bottom: edgePad }}
          tick={{ fill: 'var(--text)', fontSize: 10, fontWeight: 600 } as object}
          width={Y_AXIS_WIDTH}
          tickFormatter={yIsRate ? fmtRateTick : fmtTick}
          scale={yLog ? 'log' : 'auto'}
          allowDataOverflow={yLog}
          domain={yAxisDomain ?? ['auto', 'auto']}
          ticks={yTicks ?? undefined}
          label={{ value: yLabel, angle: -90, position: 'insideLeft', offset: 12, fill: 'var(--text)', fontSize: 11, fontWeight: 600, style: { textAnchor: 'middle' } } as object}
        />
        <ZAxis type="number" dataKey="size" range={zRange} />
        {/* 🔴 <Scatter> より**前**に置く。SVG は書いた順に重なるので、ここに置いた
            引き出し線・選択の輪は必ず画像の下に来る(#630)。 */}
        {imagePx && (
          <ScatterUnderLayer
            lens={lens}
            basePos={basePos}
            activeName={active?.name ?? null}
            imagePx={imagePx}
            animate={!reduceMotion}
          />
        )}
        <Scatter
          data={drawable}
          shape={(props: any) => {
            const payload = props.payload as ScatterPoint | undefined
            const tipJson = payload
              ? JSON.stringify(buildScatterTipPayload(payload, siblings))
              : undefined
            // レンズ計算用に元座標を控える(#630)。cx/cy はずらしていても常に元の位置。
            if (payload && props.cx != null && props.cy != null) {
              basePos.set(payload.name, { x: props.cx, y: props.cy })
            }
            return scatterPointShape({
              ...props,
              fillOpacity,
              active: sameScatterAnchor(props, active as { cx?: number; cy?: number } | null),
              tipJson,
              imagePx,
              offset: payload ? lens?.offsets.get(payload.name) ?? null : null,
              animate: !reduceMotion,
            })
          }}
          onMouseEnter={(p: any) => {
            // 同じ点へ入り直した場合も再計測するため、新しいオブジェクトとして保持する。
            setTooltipPlacement(null)
            setHover({ ...p })
          }}
          onClick={(p: any) => {
            // クリックでピン留め/再クリックで解除。画像保存前に点を固定できる。
            const next = { ...p }
            const willUnpin = sameScatterAnchor(pinned as { cx?: number; cy?: number } | null, next)
            setPinned(willUnpin ? null : next)
            // レンズも一緒に固定する。こうするとずらしたまま画像に保存できる。
            setLensPinned(!willUnpin && !!lens)
            if (willUnpin) setLens(null)
            setTooltipPlacement(null)
            setHover(next)
          }}
          isAnimationActive={false}
        >
          {drawable.map((p, i) => (
            <Cell key={i} fill={p.color} fillOpacity={fillOpacity} stroke="var(--surface)" strokeWidth={0.5} />
          ))}
        </Scatter>
      </RScatterChart>
    </ResponsiveContainer>
    <ScatterLegends sizeLegend={sizeLegend} colorLegend={colorLegend} />
    {droppedByLog > 0 && (
      <div
        style={{
          fontSize: 10,
          color: 'var(--text-muted)',
          textAlign: 'right',
          marginTop: -18,
          paddingRight: 8,
          pointerEvents: 'none',
        }}
      >
        {droppedByLog} 件を非表示(ログ軸に載らない 0 以下・∞)
      </div>
    )}
    {active && (() => {
      // 初回はアクティブ点位置へ hidden で描画し、useLayoutEffect で実寸計測後に表示する。
      const bx = (active as unknown as { cx?: number }).cx ?? 0
      const by = (active as unknown as { cy?: number }).cy ?? 0
      const off = lens?.offsets.get(active.name) ?? null
      const hx = bx + (off?.dx ?? 0)
      const hy = by + (off?.dy ?? 0)
      const tipStyle: CSSProperties = {
        position: 'absolute',
        left: tooltipPlacement?.left ?? hx,
        top: tooltipPlacement?.top ?? hy,
        visibility: tooltipPlacement ? 'visible' : 'hidden',
        pointerEvents: 'none',
        minWidth: 160,
        maxWidth: 280,
        zIndex: 5,
      }
      return (
      <div
        ref={tooltipRef}
        className="cal-tooltip"
        style={tipStyle}
        data-placement={tooltipPlacement?.direction}
      >
        {hoverSiblings.length > 1 ? (
          <>
            {/* 重なってる全件: 共通の x/y 等を 1 回 + 各点の rowText を並べる */}
            <div className="hover-tt-title">{active.tooltipRows.slice(0, 2).map(r => `${r.label} ${r.value}`).join(' / ')} <span className="hover-tt-row--muted">({hoverSiblings.length} 件)</span></div>
            {hoverSiblings.slice(0, ROW_LIMIT).map((p, i) => (
              <div key={i} className="hover-tt-row hover-tt-row--muted">{p.rowText ?? p.name}</div>
            ))}
            {hoverSiblings.length > ROW_LIMIT && (
              <div className="hover-tt-row hover-tt-row--muted">他 {hoverSiblings.length - ROW_LIMIT} 件</div>
            )}
          </>
        ) : (
          <>
            <div className="hover-tt-title">
              {active.iconUrl && <img className="hover-tt-icon" src={active.iconUrl} alt="" />}
              {active.name}
            </div>
            {active.tooltipRows.map((r, i) => (
              <div key={i} className={r.muted ? 'hover-tt-row hover-tt-row--muted' : 'hover-tt-row'}>
                {r.label}: {r.value}
              </div>
            ))}
          </>
        )}
      </div>
      )
    })()}
    </div>
  )
}
