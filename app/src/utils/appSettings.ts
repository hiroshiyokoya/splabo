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
  // 勝率(発散) 11 段（#351）。淡い中立 → 濃い極。白黒方向へ振るので全テーマ共通。
  '--cell-r1':               '#9d174d',
  '--cell-r2':               '#db2777',
  '--cell-r3':               '#f472b6',
  '--cell-r4':               '#f68fc5',
  '--cell-r5':               '#f9a8d4',
  '--cell-r6':               '#d0d3d8',
  '--cell-r7':               '#7dd3fc',
  '--cell-r8':               '#57c8fa',
  '--cell-r9':               '#38bdf8',
  '--cell-r10':              '#0284c7',
  '--cell-r11':              '#075985',
  // 勝数・平均系のベース色。段は白/黒との混色で作るため全テーマ共通（#351）。
  '--seq-good':              '#22c55e',
  '--seq-bad':               '#ef4444',
  '--seq-neutral':           '#fb923c',
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
