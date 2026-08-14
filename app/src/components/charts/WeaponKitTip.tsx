import type { CSSProperties } from 'react'
import type { ScatterKitIcons } from '../../utils/scatterCategoryColors'

/** ブキ軸ラベル用チップ(#643)。散布図と同じキット行。 */
export type WeaponKitTipData = {
  name: string
  iconUrl?: string | null
} & ScatterKitIcons

export function WeaponKitTipBody(t: WeaponKitTipData) {
  return (
    <>
      <div className="hover-tt-title">
        {t.iconUrl && <img className="hover-tt-icon" src={t.iconUrl} alt="" />}
        {t.name}
      </div>
      {(t.spIconUrl || t.subIconUrl) && (
        <div className="hover-tt-kit">
          <div className="hover-tt-kit-well">
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
