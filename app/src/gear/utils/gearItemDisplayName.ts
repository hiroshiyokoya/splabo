import { localizedName } from '../../i18n/displayName'
import type { GearDB, GearItem } from '../types'

/** ギアアイテム（頭/服/靴）の表示名。表示言語が英語なら公式英語名、無ければ日本語名。 */
export function gearItemDisplayName(item: Pick<GearItem, 'name' | 'name_en'>): string {
  return localizedName(item.name, item.name_en, item.name)
}

/** 頭・服・靴すべてのギアの表示名（ギア名の改行位置の推定に使う・#886）。 */
export function allGearDisplayNames(db: GearDB): string[] {
  return [...db.head, ...db.clothing, ...db.shoes].map(gearItemDisplayName)
}

/** ブランドの表示名。表示言語が英語なら公式英語名、無ければ日本語名。 */
export function gearBrandDisplayName(item: Pick<GearItem, 'brand' | 'brand_en'>): string {
  return localizedName(item.brand, item.brand_en, item.brand)
}
