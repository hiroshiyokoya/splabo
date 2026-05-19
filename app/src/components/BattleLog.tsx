import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { BattleRow } from '../types'

const PAGE_SIZE = 50

export function BattleLog() {
  const [battles, setBattles] = useState<BattleRow[]>([])
  const [offset, setOffset] = useState(0)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [weaponImages, setWeaponImages] = useState<Map<string, string>>(new Map())

  useEffect(() => {
    setLoading(true)
    Promise.all([
      invoke<BattleRow[]>('db_list_battles', { limit: PAGE_SIZE, offset }),
      invoke<number>('db_battle_count'),
    ])
      .then(([rows, count]) => {
        setBattles(rows)
        setTotal(count)
        const uniqueWeapons = [...new Set(rows.map(b => b.weapon))]
        Promise.all(
          uniqueWeapons.map(name =>
            invoke<string | null>('read_image', { kind: 'weapon', name })
              .then(url => url ? [name, url] as [string, string] : null)
              .catch(() => null)
          )
        ).then(results => {
          setWeaponImages(new Map(results.filter((r): r is [string, string] => r !== null)))
        })
      })
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [offset])

  if (loading) return <div className="loading">読み込み中...</div>

  return (
    <div className="battle-log">
      <div className="log-header">
        <h2>バトルログ</h2>
        <span className="total-count">計 {total} 試合</span>
      </div>

      {battles.length === 0 ? (
        <div className="empty">バトルデータがありません。データを取得してください。</div>
      ) : (
        <>
          <table className="battle-table">
            <thead>
              <tr>
                <th>日時</th>
                <th>モード</th>
                <th>ルール</th>
                <th>ステージ</th>
                <th>武器</th>
                <th>結果</th>
                <th>K/D/A</th>
                <th>塗り</th>
              </tr>
            </thead>
            <tbody>
              {battles.map((b) => (
                <tr key={b.id} className={`result-${b.result.toLowerCase()}`}>
                  <td>{new Date(b.played_at).toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
                  <td>{b.mode}</td>
                  <td>{b.rule}</td>
                  <td>{b.stage}</td>
                  <td>
                    <span className="weapon-cell">
                      {weaponImages.get(b.weapon) && (
                        <img src={weaponImages.get(b.weapon)} alt="" className="weapon-icon" />
                      )}
                      {b.weapon}
                    </span>
                  </td>
                  <td className={`result-cell ${b.result.toLowerCase()}`}>{b.result}</td>
                  <td>{b.kill}/{b.death}/{b.assist}</td>
                  <td>{b.inked.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="pagination">
            <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
              前へ
            </button>
            <span>{offset + 1}–{Math.min(offset + PAGE_SIZE, total)} / {total}</span>
            <button disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>
              次へ
            </button>
          </div>
        </>
      )}
    </div>
  )
}
