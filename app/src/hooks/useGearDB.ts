import { useState, useEffect } from 'react'
import type { GearDB } from '../types'

/** ギアDB JSON を初回取得するフック。 */
export function useGearDB() {
  const [data, setData] = useState<GearDB | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastFetchedAt, setLastFetchedAt] = useState<Date | null>(null)

  useEffect(() => {
    let cancelled = false

    fetch('/data/gear_db.json')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then((json: GearDB) => {
        if (cancelled) return
        setData(json)
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

    return () => {
      cancelled = true
    }
  }, [])

  return { data, loading, error, lastFetchedAt }
}
