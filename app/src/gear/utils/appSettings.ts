/**
 * appSettings — テーマ・表示密度・コーデ設定の定義と localStorage 永続化
 */

import { getThemeId as getShellThemeId } from '../../utils/appSettings'

// ── テーマ ────────────────────────────────────────────────────
//
// テーマは splabo シェル（設定タブ）が単一の情報源。ギアは自前の保存を持たず、
// シェルのテーマ ID に対応するパレットを `.gear-root` へ適用して追従する（#344）。
// ギアはシェルと同名の変数（--bg / --surface / --accent …）を `.gear-root` に
// 再定義しているため、:root へのテーマ適用は届かない。ここで明示的に流し込む。

export interface Theme {
  id: string
  /** カラードット表示用の代表色（CSS background 値、グラデーション可） */
  dot: string
  vars: Record<string, string>
}

/**
 * シェルのテーマ ID → ギアのテーマ ID。
 * ギアの既定パレットは geartoon 由来の 'purple' で、シェルの 'dark' と対になる。
 * それ以外（solarized-light / solarized-dark）は ID が一致するのでそのまま使う。
 */
function gearThemeIdFor(shellThemeId: string): string {
  return shellThemeId === 'dark' ? 'purple' : shellThemeId
}

export const THEMES: Theme[] = [
  // 1. Purple (default)
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
  // 2. Solarized Light
  {
    id: 'solarized-light',
    dot: '#fdf6e3',
    vars: {
      '--bg':                  '#fdf6e3',
      '--surface':             '#eee8d5',
      '--surface-hover':       '#e6dfc8',
      '--border':              '#cdc8b8',
      '--text':                '#3d454a',
      // #93a1a1 は薄すぎるためシェル側で Solarized base00 寄りに是正済み。値を合わせる（#344）。
      '--text-muted':          '#657b83',
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
  // 3. Solarized Dark + Lime
  {
    id: 'solarized-dark',
    dot: '#002b36',
    vars: {
      '--bg':                  '#002b36',
      '--surface':             '#073642',
      '--surface-hover':       '#0d3d4f',
      '--border':              '#1b4b5a',
      '--text':                '#93a1a1',
      '--text-muted':          '#586e75',
      '--accent':              '#b58900',
      '--accent-dim':          '#8a6800',
      '--accent-dark':         '#001e27',
      '--star-off':            '#1b4b5a',
      '--accent-hover-border': 'rgba(181, 137, 0, 0.4)',
      '--accent-hover-bg':     'rgba(181, 137, 0, 0.05)',
      '--accent-active-bg':    'rgba(181, 137, 0, 0.08)',
      '--accent-glow':         'rgba(181, 137, 0, 0.3)',
      '--chip-bg':             'rgba(255, 255, 255, 0.03)',
      '--chip-border':         'rgba(255, 255, 255, 0.07)',
      '--chip-text':           'rgba(255, 255, 255, 0.78)',
      '--drawer-bg':           'rgba(0, 43, 54, 0.15)',
      '--sheet-bg':            'rgba(7, 54, 66, 0.88)',
      '--sheet-surface':       'rgba(7, 54, 66, 0.4)',
      '--sheet-border-top':    'rgba(181, 137, 0, 0.6)',
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

// ── コーデ候補件数 ─────────────────────────────────────────────

export const COMBO_LIMITS = [10, 25, 50, 100] as const
export type ComboLimitValue = typeof COMBO_LIMITS[number]

export const NEAR_LIMITS = [2, 5, 10, 20] as const
export type NearLimitValue = typeof NEAR_LIMITS[number]

// ── localStorage ──────────────────────────────────────────────
//
// splabo v0.8 統合: 新キーは `splabo:*`。読み出しは `splabo:*` を優先し、
// 無ければ旧 geartoon 単体アプリの `geartoon:*` にフォールバックする（設定移行の互換層）。
// 保存は常に `splabo:*` に書く。

// テーマはシェル（`splabo:shellThemeId`）が単一の情報源のため、ギア側の保存キーは持たない（#344）。
const LS_DENSITY_KEY     = 'splabo:densityId'
const LS_COMBO_LIMIT_KEY = 'splabo:comboLimit'
const LS_NEAR_LIMIT_KEY  = 'splabo:nearLimit'

const LS_DENSITY_KEY_OLD     = 'geartoon:densityId'
const LS_COMBO_LIMIT_KEY_OLD = 'geartoon:comboLimit'
const LS_NEAR_LIMIT_KEY_OLD  = 'geartoon:nearLimit'

/** splabo:* を優先し、無ければ geartoon:* を読む。 */
function readWithFallback(newKey: string, oldKey: string): string | null {
  return localStorage.getItem(newKey) ?? localStorage.getItem(oldKey)
}

export function loadDensityId(): DensityId {
  return (readWithFallback(LS_DENSITY_KEY, LS_DENSITY_KEY_OLD) as DensityId) ?? 'standard'
}

export function loadComboLimit(): ComboLimitValue {
  const v = Number(readWithFallback(LS_COMBO_LIMIT_KEY, LS_COMBO_LIMIT_KEY_OLD))
  return (COMBO_LIMITS as readonly number[]).includes(v) ? (v as ComboLimitValue) : 25
}

export function saveComboLimit(v: ComboLimitValue): void {
  localStorage.setItem(LS_COMBO_LIMIT_KEY, String(v))
}

export function loadNearLimit(): NearLimitValue {
  const v = Number(readWithFallback(LS_NEAR_LIMIT_KEY, LS_NEAR_LIMIT_KEY_OLD))
  return (NEAR_LIMITS as readonly number[]).includes(v) ? (v as NearLimitValue) : 5
}

export function saveNearLimit(v: NearLimitValue): void {
  localStorage.setItem(LS_NEAR_LIMIT_KEY, String(v))
}

/**
 * CSS 変数の適用先。splabo 統合では chartoon の `:root` を汚さないよう、
 * ギアセクションのルート要素（`.gear-root`）にスコープして適用する。
 * まだマウントされていない場合は null（gear.css のデフォルト値がそのまま効く）。
 */
function gearRootEl(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.gear-root')
}

/**
 * シェルのテーマ ID を受け取り、対応するギアのパレットを `.gear-root` に適用する。
 * ギア側にテーマの保存は持たない（シェルが単一の情報源・#344）。
 */
export function applyTheme(shellThemeId: string): void {
  const gearThemeId = gearThemeIdFor(shellThemeId)
  const theme = THEMES.find(t => t.id === gearThemeId) ?? THEMES[0]
  const root = gearRootEl()
  if (root) {
    for (const [k, v] of Object.entries(theme.vars)) {
      root.style.setProperty(k, v)
    }
  }
}

export function applyDensity(densityId: DensityId): void {
  const density = DENSITIES.find(d => d.id === densityId) ?? DENSITIES[1]
  const root = gearRootEl()
  if (root) {
    for (const [k, v] of Object.entries(density.vars)) {
      root.style.setProperty(k, v)
    }
  }
  localStorage.setItem(LS_DENSITY_KEY, densityId)
}

/**
 * ギアセクションのマウント後に呼ぶ — シェルのテーマと保存済み密度を `.gear-root` に適用する。
 * 旧 geartoon では module ロード時に呼んでいたが、統合後は `.gear-root` が
 * 描画されてから適用する必要があるため GearSection の useEffect から呼ぶ。
 *
 * GearSection はタブ離脱でアンマウントされるため、設定でテーマを変更したあと
 * ギアタブを開き直した時点で、ここで最新のシェルテーマが再適用される（#344）。
 */
export function initAppSettings(): void {
  applyTheme(getShellThemeId())
  applyDensity(loadDensityId())
}
