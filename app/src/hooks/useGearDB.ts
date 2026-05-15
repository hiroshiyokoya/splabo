import { useState, useEffect } from 'react'
import type { GearDB, GearItem, Skill } from '../types'
import { initTauriDataPath } from '../utils/dataPath'

const isTauri = (): boolean =>
  '__TAURI_INTERNALS__' in window

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

// ── フック ────────────────────────────────────────────────────
export function useGearDB() {
  const [data, setData] = useState<GearDB | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastFetchedAt, setLastFetchedAt] = useState<Date | null>(null)

  useEffect(() => {
    let cancelled = false

    const load = isTauri() ? loadFromTauri() : loadFromBrowser()

    load
      .then((db) => {
        if (cancelled) return
        setData(db)
        setLastFetchedAt(new Date())
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
  }, [])

  return { data, loading, error, lastFetchedAt }
}
