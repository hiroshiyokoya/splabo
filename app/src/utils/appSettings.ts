const THEME_KEY = 'chartoon:themeId'

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
    dot: '#7c3aed',
    vars: {},
  },
  {
    id: 'light',
    label: 'ライト',
    dot: '#7c3aed',
    vars: {
      '--bg': '#f8f9fa',
      '--surface': '#ffffff',
      '--surface2': '#f1f3f5',
      '--border': '#dee2e6',
      '--text': '#212529',
      '--text-muted': '#6c757d',
    },
  },
  {
    id: 'solarized-dark',
    label: 'Solarized Dark',
    dot: '#268bd2',
    vars: {
      '--bg': '#002b36',
      '--surface': '#073642',
      '--surface2': '#0d4a59',
      '--border': '#103b44',
      '--accent': '#268bd2',
      '--accent-hover': '#1a77b8',
      '--text': '#839496',
      '--text-muted': '#657b83',
    },
  },
]

const BASE_VARS: Record<string, string> = {
  '--bg': '#0f0f13',
  '--surface': '#1a1a24',
  '--surface2': '#22222f',
  '--border': '#2e2e40',
  '--accent': '#7c3aed',
  '--accent-hover': '#6d28d9',
  '--text': '#e5e7eb',
  '--text-muted': '#6b7280',
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
  const themeId = localStorage.getItem(THEME_KEY) ?? 'dark'
  applyTheme(themeId)
}

export function saveTheme(themeId: string): void {
  localStorage.setItem(THEME_KEY, themeId)
  applyTheme(themeId)
}

export function getThemeId(): string {
  return localStorage.getItem(THEME_KEY) ?? 'dark'
}
