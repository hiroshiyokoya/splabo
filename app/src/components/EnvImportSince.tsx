/**
 * 環境データの取得開始日。再取得は設定 → データに置き、誤操作しにくくする（#669）。
 * 環境分析タブの初回取得は、ここに保存した開始日を使う。
 */
import { useTranslation } from 'react-i18next'
import { lsGet, lsSet, mirrorToStore } from '../utils/settingsStore'

export const ENV_IMPORT_KEY = 'splabo:envImport'

/** 全期間は集計が重く実用にならないので、取得の既定は 2025-01-01 以降。 */
export const DEFAULT_ENV_IMPORT_SINCE = '2025-01-01'

export type ImportSinceKind = 'all' | 'current_season' | 'from_2025' | 'custom'

export interface EnvImportPrefs {
  kind: ImportSinceKind
  custom: string
}

const KINDS: ImportSinceKind[] = ['all', 'current_season', 'from_2025', 'custom']

function addDays(dateStr: string, delta: number): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + delta)
  return dt.toISOString().slice(0, 10)
}

function utcToday(): string {
  return new Date().toISOString().slice(0, 10)
}

export function utcYesterday(): string {
  return addDays(utcToday(), -1)
}

/** その日が属する Splatoon シーズンの開始日（`season.rs` と同じ 3/6/9/12 月）。 */
function splatoonSeasonStart(isoDate: string): string {
  const [y, m] = isoDate.split('-').map(Number)
  if (m === 1 || m === 2) return `${y - 1}-12-01`
  if (m <= 5) return `${y}-03-01`
  if (m <= 8) return `${y}-06-01`
  if (m <= 11) return `${y}-09-01`
  return `${y}-12-01`
}

export function resolveImportSince(kind: ImportSinceKind, custom: string): string | null {
  if (kind === 'all') return null
  if (kind === 'current_season') return splatoonSeasonStart(utcToday())
  if (kind === 'from_2025') return DEFAULT_ENV_IMPORT_SINCE
  return custom || null
}

export function loadEnvImportPrefs(): EnvImportPrefs {
  try {
    const raw = lsGet(ENV_IMPORT_KEY)
    if (!raw) return { kind: 'from_2025', custom: DEFAULT_ENV_IMPORT_SINCE }
    const p = JSON.parse(raw) as Partial<EnvImportPrefs>
    const kind = KINDS.includes(p.kind as ImportSinceKind) ? (p.kind as ImportSinceKind) : 'from_2025'
    const custom = typeof p.custom === 'string' && p.custom ? p.custom : DEFAULT_ENV_IMPORT_SINCE
    return { kind, custom }
  } catch {
    return { kind: 'from_2025', custom: DEFAULT_ENV_IMPORT_SINCE }
  }
}

export function saveEnvImportPrefs(prefs: EnvImportPrefs): void {
  lsSet(ENV_IMPORT_KEY, JSON.stringify(prefs))
  void mirrorToStore()
}

export function ImportSincePicker({
  kind, custom, disabled, onKind, onCustom,
}: {
  kind: ImportSinceKind
  custom: string
  disabled: boolean
  onKind: (k: ImportSinceKind) => void
  onCustom: (v: string) => void
}) {
  const { t } = useTranslation()
  const kinds: { key: ImportSinceKind; label: string }[] = [
    { key: 'all', label: t('filter.allPeriod') },
    { key: 'current_season', label: t('filter.currentSeason') },
    { key: 'from_2025', label: t('settings.from2025') },
    { key: 'custom', label: t('filter.custom') },
  ]
  return (
    <label className="env-import-since">{t('settings.importSince')}
      <span className="env-period-btns">
        {kinds.map(k => (
          <button
            key={k.key}
            type="button"
            disabled={disabled}
            className={`filter-btn${kind === k.key ? ' active' : ''}`}
            onClick={() => onKind(k.key)}
          >{k.label}</button>
        ))}
      </span>
      {kind === 'custom' && (
        <input type="date" value={custom} disabled={disabled}
               max={utcYesterday()} onChange={e => onCustom(e.target.value)} />
      )}
    </label>
  )
}
