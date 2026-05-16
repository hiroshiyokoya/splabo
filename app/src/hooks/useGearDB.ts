import { useState, useEffect, useCallback } from 'react'
import type { GearDB, GearItem, Skill } from '../types'
import { initTauriDataPath } from '../utils/dataPath'
import { isTauri } from '../utils/tauri'

// ── 画像パスの変換ヘルパー ────────────────────────────────────

function makePathFixer(toUrl: (rel: string) => string) {
  function fixSkill(s: Skill): Skill {
    return { ...s, image: s.image ? toUrl(s.image) : s.image }
  }
  function fixGear(g: GearItem): GearItem {
    return {
      ...g,
      image: g.image ? toUrl(g.image) : g.image,
      brand_image: g.brand_image ? toUrl(g.brand_image) : g.brand_image,
      primary_skill: fixSkill(g.primary_skill),
      additional_skills: g.additional_skills.map(fixSkill),
    }
  }
  function fixDB(db: GearDB): GearDB {
    return {
      head:     db.head.map(fixGear),
      clothing: db.clothing.map(fixGear),
      shoes:    db.shoes.map(fixGear),
    }
  }
  return fixDB
}

// ── Tauri モード ──────────────────────────────────────────────
async function loadFromTauri(): Promise<GearDB> {
  const { invoke, convertFileSrc } = await import('@tauri-apps/api/core')

  const [jsonStr, dataDir] = await Promise.all([
    invoke<string>('read_gear_db'),
    invoke<string>('get_data_dir'),
  ])

  // dataPath() ユーティリティを Tauri モード用に初期化
  initTauriDataPath(dataDir, (abs) => convertFileSrc(abs))

  const db: GearDB = JSON.parse(jsonStr)

  // JSON の相対パス（例: "images/xxx.png"）→ asset URL
  const fixDB = makePathFixer((rel) => convertFileSrc(`${dataDir}/${rel}`))
  return fixDB(db)
}

// ── ブラウザ dev モード ───────────────────────────────────────
async function loadFromBrowser(): Promise<GearDB> {
  const res = await fetch('/data/gear_db.json')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const db: GearDB = await res.json()

  // JSON の相対パス（例: "images/xxx.png"）→ /data/images/xxx.png
  const fixDB = makePathFixer((rel) => `/data/${rel}`)
  return fixDB(db)
}

/** localStorage キー: ニンテンドーからデータを取得した日時 */
const LS_LAST_FETCHED_KEY = 'geartoon:lastFetchedAt'

/** データ取得日時を localStorage に保存する（App.tsx から呼ぶ） */
export function saveLastFetchedAt(date: Date): void {
  localStorage.setItem(LS_LAST_FETCHED_KEY, date.toISOString())
}

// ── フック ────────────────────────────────────────────────────
export function useGearDB() {
  const [data, setData] = useState<GearDB | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // localStorage から初期値を読む（アプリ起動時も前回取得日時を維持）
  const [lastFetchedAt, setLastFetchedAt] = useState<Date | null>(() => {
    const stored = localStorage.getItem(LS_LAST_FETCHED_KEY)
    return stored ? new Date(stored) : null
  })
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)

    const load = isTauri() ? loadFromTauri() : loadFromBrowser()

    load
      .then((db) => {
        if (cancelled) return
        setData(db)
        setError(null)
      })
      .catch((err: Error) => {
        if (cancelled) return
        setError(err.message)
      })
      .finally(() => {
        if (cancelled) return
        setLoading(false)
      })

    return () => { cancelled = true }
  }, [reloadKey])

  /** nxapi_fetch_gear 完了後に呼ぶとギアDBを再読み込みし、取得日時も更新する */
  const reload = useCallback(() => {
    setReloadKey(k => k + 1)
    // localStorage の最新値を反映（saveLastFetchedAt が先に呼ばれている前提）
    const stored = localStorage.getItem(LS_LAST_FETCHED_KEY)
    if (stored) setLastFetchedAt(new Date(stored))
  }, [])

  return { data, loading, error, lastFetchedAt, reload }
}
