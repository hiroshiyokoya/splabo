import { useState, useEffect } from 'react'
import type { GearDB } from '../types'

export function useGearDB() {
  const [data, setData] = useState<GearDB | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/data/gear_db.json')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then((json: GearDB) => {
        setData(json)
        setLoading(false)
      })
      .catch((err: Error) => {
        setError(err.message)
        setLoading(false)
      })
  }, [])

  return { data, loading, error }
}
