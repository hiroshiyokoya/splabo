/**
 * appSettings — テーマ・表示密度の定義と localStorage 永続化
 */

// ── テーマ ────────────────────────────────────────────────────

export interface Theme {
  id: string
  /** カラードット表示用の代表色 */
  dot: string
  vars: Record<string, string>
}

export const THEMES: Theme[] = [
  {
    id: 'purple',
    dot: '#1a1a1e',
    vars: {
      '--bg':                  '#1a1a1e',
      '--surface':             '#17172a',
      '--surface-hover':       '#20203a',
      '--border':              '#2a2a45',
      '--text':                '#eeeef8',
      '--text-muted':          '#6060a0',
      '--accent':              '#c8f030',
      '--accent-dim':          '#9dc024',
      '--accent-dark':         '#0d0d1a',
      '--star-off':            '#2a2a45',
      '--accent-hover-border': 'rgba(200, 240, 48, 0.4)',
      '--accent-hover-bg':     'rgba(200, 240, 48, 0.05)',
      '--accent-active-bg':    'rgba(200, 240, 48, 0.08)',
      '--accent-glow':         'rgba(200, 240, 48, 0.3)',
      '--chip-bg':             'rgba(255, 255, 255, 0.02)',
      '--chip-border':         'rgba(255, 255, 255, 0.06)',
      '--chip-text':           'rgba(255, 255, 255, 0.75)',
      '--drawer-bg':           'rgba(20, 18, 38, 0.08)',
      '--sheet-bg':            'rgba(35, 25, 70, 0.75)',
      '--sheet-surface':       'rgba(35, 25, 70, 0.35)',
      '--sheet-border-top':    'rgba(200, 240, 48, 0.6)',
    },
  },
  {
    id: 'solarized-dark',
    dot: '#002b36',
    vars: {
      '--bg':                  '#002b36',
      '--surface':             '#073642',
      '--surface-hover':       '#0d3d4f',
      '--border':              '#1b4b5a',
      '--text':                '#839496',
      '--text-muted':          '#586e75',
      '--accent':              '#b58900',
      '--accent-dim':          '#8a6800',
      '--accent-dark':         '#001e27',
      '--star-off':            '#1b4b5a',
      '--accent-hover-border': 'rgba(181, 137, 0, 0.4)',
      '--accent-hover-bg':     'rgba(181, 137, 0, 0.05)',
      '--accent-active-bg':    'rgba(181, 137, 0, 0.08)',
      '--accent-glow':         'rgba(181, 137, 0, 0.3)',
      '--chip-bg':             'rgba(255, 255, 255, 0.02)',
      '--chip-border':         'rgba(255, 255, 255, 0.06)',
      '--chip-text':           'rgba(255, 255, 255, 0.75)',
      '--drawer-bg':           'rgba(0, 43, 54, 0.15)',
      '--sheet-bg':            'rgba(7, 54, 66, 0.88)',
      '--sheet-surface':       'rgba(7, 54, 66, 0.4)',
      '--sheet-border-top':    'rgba(181, 137, 0, 0.6)',
    },
  },
  {
    id: 'solarized-light',
    dot: '#fdf6e3',
    vars: {
      '--bg':                  '#fdf6e3',
      '--surface':             '#eee8d5',
      '--surface-hover':       '#e6dfc8',
      '--border':              '#cdc8b8',
      '--text':                '#3d454a',
      '--text-muted':          '#93a1a1',
      '--accent':              '#268bd2',
      '--accent-dim':          '#1a6fa8',
      '--accent-dark':         '#f5eedc',
      '--star-off':            '#cdc8b8',
      '--accent-hover-border': 'rgba(38, 139, 210, 0.4)',
      '--accent-hover-bg':     'rgba(38, 139, 210, 0.05)',
      '--accent-active-bg':    'rgba(38, 139, 210, 0.08)',
      '--accent-glow':         'rgba(38, 139, 210, 0.3)',
      '--chip-bg':             'rgba(0, 0, 0, 0.03)',
      '--chip-border':         'rgba(0, 0, 0, 0.07)',
      '--chip-text':           'rgba(0, 0, 0, 0.7)',
      '--drawer-bg':           'rgba(238, 232, 213, 0.5)',
      '--sheet-bg':            'rgba(220, 212, 192, 0.92)',
      '--sheet-surface':       'rgba(220, 212, 192, 0.5)',
      '--sheet-border-top':    'rgba(38, 139, 210, 0.6)',
    },
  },
  {
    id: 'orange',
    dot: '#1a0e00',
    vars: {
      '--bg':                  '#1a0e00',
      '--surface':             '#2a1800',
      '--surface-hover':       '#3a2200',
      '--border':              '#4a3010',
      '--text':                '#f0e0c0',
      '--text-muted':          '#806040',
      '--accent':              '#ff7621',
      '--accent-dim':          '#cc5c18',
      '--accent-dark':         '#0f0800',
      '--star-off':            '#4a3010',
      '--accent-hover-border': 'rgba(255, 118, 33, 0.4)',
      '--accent-hover-bg':     'rgba(255, 118, 33, 0.05)',
      '--accent-active-bg':    'rgba(255, 118, 33, 0.08)',
      '--accent-glow':         'rgba(255, 118, 33, 0.3)',
      '--chip-bg':             'rgba(255, 255, 255, 0.02)',
      '--chip-border':         'rgba(255, 255, 255, 0.06)',
      '--chip-text':           'rgba(255, 255, 255, 0.75)',
      '--drawer-bg':           'rgba(30, 15, 0, 0.15)',
      '--sheet-bg':            'rgba(60, 30, 0, 0.82)',
      '--sheet-surface':       'rgba(60, 30, 0, 0.4)',
      '--sheet-border-top':    'rgba(255, 118, 33, 0.6)',
    },
  },
  {
    id: 'splat',
    dot: '#0a0a10',
    vars: {
      '--bg':                  '#0a0a10',
      '--surface':             '#12101e',
      '--surface-hover':       '#1e1830',
      '--border':              '#2a1840',
      '--text':                '#f0e0ff',
      '--text-muted':          '#804080',
      '--accent':              '#ff2d78',
      '--accent-dim':          '#cc1f60',
      '--accent-dark':         '#05050a',
      '--star-off':            '#2a1840',
      '--accent-hover-border': 'rgba(255, 45, 120, 0.4)',
      '--accent-hover-bg':     'rgba(255, 45, 120, 0.05)',
      '--accent-active-bg':    'rgba(255, 45, 120, 0.08)',
      '--accent-glow':         'rgba(255, 45, 120, 0.3)',
      '--chip-bg':             'rgba(255, 255, 255, 0.02)',
      '--chip-border':         'rgba(255, 255, 255, 0.06)',
      '--chip-text':           'rgba(255, 255, 255, 0.75)',
      '--drawer-bg':           'rgba(15, 5, 25, 0.15)',
      '--sheet-bg':            'rgba(40, 10, 50, 0.82)',
      '--sheet-surface':       'rgba(40, 10, 50, 0.4)',
      '--sheet-border-top':    'rgba(255, 45, 120, 0.6)',
    },
  },
  {
    id: 'forest',
    dot: '#0a1a0f',
    vars: {
      '--bg':                  '#0a1a0f',
      '--surface':             '#0f2215',
      '--surface-hover':       '#16301e',
      '--border':              '#1e4028',
      '--text':                '#d0f0e0',
      '--text-muted':          '#507060',
      '--accent':              '#00e5ff',
      '--accent-dim':          '#00b0cc',
      '--accent-dark':         '#05100a',
      '--star-off':            '#1e4028',
      '--accent-hover-border': 'rgba(0, 229, 255, 0.4)',
      '--accent-hover-bg':     'rgba(0, 229, 255, 0.05)',
      '--accent-active-bg':    'rgba(0, 229, 255, 0.08)',
      '--accent-glow':         'rgba(0, 229, 255, 0.3)',
      '--chip-bg':             'rgba(255, 255, 255, 0.02)',
      '--chip-border':         'rgba(255, 255, 255, 0.06)',
      '--chip-text':           'rgba(255, 255, 255, 0.75)',
      '--drawer-bg':           'rgba(5, 20, 10, 0.15)',
      '--sheet-bg':            'rgba(10, 40, 20, 0.85)',
      '--sheet-surface':       'rgba(10, 40, 20, 0.4)',
      '--sheet-border-top':    'rgba(0, 229, 255, 0.6)',
    },
  },
]

// ── 表示密度 ──────────────────────────────────────────────────

export type DensityId = 'compact' | 'standard' | 'spacious'

export interface Density {
  id: DensityId
  label: string
  vars: Record<string, string>
}

export const DENSITIES: Density[] = [
  {
    id: 'compact',
    label: 'コンパクト',
    vars: {
      '--card-width':      '160px',
      '--card-image-size': '80px',
      '--card-font-size':  '0.75rem',
    },
  },
  {
    id: 'standard',
    label: '標準',
    vars: {
      '--card-width':      '200px',
      '--card-image-size': '108px',
      '--card-font-size':  '0.85rem',
    },
  },
  {
    id: 'spacious',
    label: 'ゆったり',
    vars: {
      '--card-width':      '260px',
      '--card-image-size': '140px',
      '--card-font-size':  '0.95rem',
    },
  },
]

// ── localStorage ──────────────────────────────────────────────

const LS_THEME_KEY   = 'geartoon:themeId'
const LS_DENSITY_KEY = 'geartoon:densityId'

export function loadThemeId(): string {
  return localStorage.getItem(LS_THEME_KEY) ?? 'purple'
}

export function loadDensityId(): DensityId {
  return (localStorage.getItem(LS_DENSITY_KEY) as DensityId) ?? 'standard'
}

export function applyTheme(themeId: string): void {
  const theme = THEMES.find(t => t.id === themeId) ?? THEMES[0]
  const root = document.documentElement
  for (const [k, v] of Object.entries(theme.vars)) {
    root.style.setProperty(k, v)
  }
  localStorage.setItem(LS_THEME_KEY, themeId)
}

export function applyDensity(densityId: DensityId): void {
  const density = DENSITIES.find(d => d.id === densityId) ?? DENSITIES[1]
  const root = document.documentElement
  for (const [k, v] of Object.entries(density.vars)) {
    root.style.setProperty(k, v)
  }
  localStorage.setItem(LS_DENSITY_KEY, densityId)
}

/** アプリ起動時に呼ぶ — 保存済み設定を復元する */
export function initAppSettings(): void {
  applyTheme(loadThemeId())
  applyDensity(loadDensityId())
}
