// splabo v0.8 統合(#241): chartoon シェルのテーマキーは `splabo:shellThemeId`。
// gear 側の `splabo:themeId` とはテーマ ID の系統が異なるため別名にする（衝突回避）。
// 読み出しは新キー優先・旧 `chartoon:themeId` フォールバック、書き込みは常に新キー。
const THEME_KEY     = 'splabo:shellThemeId'
const THEME_KEY_OLD = 'chartoon:themeId'

interface Theme {
  id: string
  label: string
  dot: string
  vars: Record<string, string>
}

export const THEMES: Theme[] = [
  {
    id: 'dark',
    label: 'ダーク (デフォルト)',
    dot: '#c8f030',
    vars: {},
  },
  {
    id: 'solarized-light',
    label: 'Solarized Light',
    dot: '#fdf6e3',
    vars: {
      '--bg':           '#fdf6e3',
      '--surface':      '#eee8d5',
      '--surface2':     '#e6dfc8',
      '--border':       '#cdc8b8',
      '--accent':       '#268bd2',
      '--accent-hover': '#1a6fa8',
      '--accent-fg':    '#fdf6e3',                 // 青ボタンには明るい文字
      '--text':         '#3d454a',
      '--text-muted':   '#657b83',                 // #93a1a1 だと薄すぎたので Solarized base00 寄りに
      // パネル系を反転：明るい背景・暗い文字
      '--panel-bg':              'rgba(253, 246, 227, 0.92)',
      '--panel-overlay':         'rgba(253, 246, 227, 0.55)',
      '--panel-overlay-strong':  'rgba(253, 246, 227, 0.78)',
      '--inner-highlight':       'rgba(0, 0, 0, 0.10)',
      '--inner-highlight-strong':'rgba(0, 0, 0, 0.14)',
      '--stat-item-bg':          'rgba(0, 0, 0, 0.04)',
      '--stage-img-filter':      'brightness(0.92) saturate(0.85)',
      '--panel-label-tint':      '#1a1a1e',         // パネルラベルは暗い文字寄り
      // 勝率(発散)はライト背景では明暗が反転する（中央を明るくする Λ 字）。#351
      // ダーク側の V 字を流用すると、中央の暗いグレーが明るい背景で最も目立ってしまう。
      '--cell-r1':               '#a82a3c',  // 〜20%  赤・極
      '--cell-r2':               '#c05a68',
      '--cell-r3':               '#d59099',
      '--cell-r4':               '#c8c1a8',  // 45-55% 中立（背景比 1.67:1）
      '--cell-r5':               '#7fb0c2',
      '--cell-r6':               '#4e93a6',
      '--cell-r7':               '#1c7182',  // 80%〜  青・極
      // 勝数・平均系はライト背景ではアクセント混色（淡→濃）。dark 系の黄→緑を
      // そのまま使うと、黄がクリーム背景に溶けて最小段が読めなくなる。
      '--cell-c1':               'color-mix(in srgb, var(--accent) 20%, var(--bg))',
      '--cell-c2':               'color-mix(in srgb, var(--accent) 33%, var(--bg))',
      '--cell-c3':               'color-mix(in srgb, var(--accent) 46%, var(--bg))',
      '--cell-c4':               'color-mix(in srgb, var(--accent) 60%, var(--bg))',
      '--cell-c5':               'color-mix(in srgb, var(--accent) 73%, var(--bg))',
      '--cell-c6':               'color-mix(in srgb, var(--accent) 86%, var(--bg))',
      '--cell-c7':               'var(--accent)',
    },
  },
  {
    id: 'solarized-dark',
    label: 'Solarized Dark',
    dot: '#002b36',
    vars: {
      '--bg':           '#002b36',
      '--surface':      '#073642',
      '--surface2':     '#0d3d4f',
      '--border':       '#1b4b5a',
      '--accent':       '#b58900',
      '--accent-hover': '#8a6800',
      '--accent-fg':    '#002b36', // アンバーボタンには濃文字
      '--text':         '#93a1a1',
      '--text-muted':   '#586e75',
    },
  },
]

// CSS の :root と同期しておくこと（App.css）。
// JS 起動時に applyTheme() で上書き適用されるため、CSS だけ変えても反映されない。
const BASE_VARS: Record<string, string> = {
  '--bg':            '#1a1a1e',
  '--surface':       '#17172a',
  '--surface2':      '#20203a',
  '--border':        '#2a2a45',
  '--accent':        '#c8f030',
  '--accent-hover':  '#9dc024',
  '--accent-fg':     '#2e0a4f',
  '--accent2':       '#ff7621',
  '--text':          '#eeeef8',
  '--text-muted':    '#9b9bd0',
  // モーダル / パネル系のオーバーレイ色（ライトテーマで上書き）
  '--panel-bg':              'rgba(10, 8, 24, 0.88)',     // モーダル本体の不透明背景
  '--panel-overlay':         'rgba(10, 8, 28, 0.25)',     // 薄い暗オーバーレイ
  '--panel-overlay-strong':  'rgba(10, 8, 28, 0.45)',     // 濃いめ暗オーバーレイ
  '--inner-highlight':       'rgba(255, 255, 255, 0.08)', // パネル境界・内側ハイライト
  '--inner-highlight-strong':'rgba(255, 255, 255, 0.10)',
  '--stat-item-bg':          'rgba(255, 255, 255, 0.04)',
  '--stage-img-filter':      'brightness(0.42) saturate(0.75)',
  '--panel-label-tint':      '#ffffff',                   // パネルラベルの混色相手
  // 勝率(発散) 7 段。dark / solarized-dark が使う（#351）。
  // 極は棒グラフの勝率バーと同色（低 #f472b6 / 高 #34d399）。中立は明るい無彩色で、
  // 明るさはカレンダーのバトル数ゼロ (#d0d3d8) に合わせた。
  '--cell-r1':               '#f472b6',
  '--cell-r2':               '#eb9cc9',
  '--cell-r3':               '#dfc0d3',
  '--cell-r4':               '#d0d3d8',
  '--cell-r5':               '#8ee0c4',
  '--cell-r6':               '#5cd9ab',
  '--cell-r7':               '#34d399',
  // 勝数・平均系(シーケンシャル) 7 段: 赤 → 緑。dark / solarized-dark が使う（#351）。
  // 棒グラフの勝敗色（--lose / --win）の系統。両色をそのまま端に置くと明度差が足りず
  // 大小が読めないため、赤を深く・緑を明るく延長して明度を単調にしている。
  '--cell-c1':               '#a82323',
  '--cell-c2':               '#c93b2f',
  '--cell-c3':               '#d9622f',
  '--cell-c4':               '#cf8b39',
  '--cell-c5':               '#a8ad48',
  '--cell-c6':               '#63c65c',
  '--cell-c7':               '#86efac',
}

export function applyTheme(themeId: string): void {
  const theme = THEMES.find(t => t.id === themeId) ?? THEMES[0]
  const vars = { ...BASE_VARS, ...theme.vars }
  const root = document.documentElement
  for (const [k, v] of Object.entries(vars)) {
    root.style.setProperty(k, v)
  }
}

export function initAppSettings(): void {
  applyTheme(getThemeId())
}

export function saveTheme(themeId: string): void {
  localStorage.setItem(THEME_KEY, themeId)
  applyTheme(themeId)
  // store（settings.json）へミラー（識別子変更でのテーマ喪失防止 #241）。
  void import('./settingsStore').then(m => m.mirrorToStore())
}

export function getThemeId(): string {
  return (localStorage.getItem(THEME_KEY) ?? localStorage.getItem(THEME_KEY_OLD)) ?? 'dark'
}
