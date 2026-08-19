import type { CSSProperties } from 'react'
import type { ScatterKitIcons } from '../../utils/scatterCategoryColors'

/** ブキ・ステージ軸ラベル用チップ(#643)。散布図と同じキット行。 */
export type WeaponKitTipData = {
  name: string
  iconUrl?: string | null
  /** ステージ画像のように横長の元画像を、パネル表示と同じ cover 切り取りで出す(#739)。 */
  iconIsWide?: boolean
} & ScatterKitIcons

export function WeaponKitTipBody(t: WeaponKitTipData) {
  return (
    <>
      <div className="hover-tt-title">
        {t.iconUrl && (
          <img
            className={`hover-tt-icon${t.iconIsWide ? ' hover-tt-icon--stage' : ''}`}
            src={t.iconUrl}
            alt=""
          />
        )}
        {t.name}
      </div>
      {(t.spIconUrl || t.subIconUrl) && (
        <div className="hover-tt-kit">
          {t.spIconUrl && (
            <img
              className="hover-tt-kit-icon hover-tt-kit-icon--sp"
              src={t.spIconUrl}
              alt=""
              title={t.spName ?? undefined}
            />
          )}
          {t.subIconUrl && (
            <img
              className="hover-tt-kit-icon"
              src={t.subIconUrl}
              alt=""
              title={t.subName ?? undefined}
            />
          )}
        </div>
      )}
    </>
  )
}

export function weaponKitTipStyle(mx: number, my: number): CSSProperties {
  return {
    position: 'fixed',
    left: Math.min(mx + 14, window.innerWidth - 240),
    top: Math.min(my + 14, window.innerHeight - 120),
    pointerEvents: 'none',
    zIndex: 1000,
  }
}
