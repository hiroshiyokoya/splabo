import { localizedName } from '../../i18n/displayName'
import type { GearItem } from '../types'

/** ギアアイテム（頭/服/靴）の表示名。表示言語が英語なら公式英語名、無ければ日本語名。 */
export function gearItemDisplayName(item: Pick<GearItem, 'name' | 'name_en'>): string {
  return localizedName(item.name, item.name_en, item.name)
}

/** ブランドの表示名。表示言語が英語なら公式英語名、無ければ日本語名。 */
export function gearBrandDisplayName(item: Pick<GearItem, 'brand' | 'brand_en'>): string {
  return localizedName(item.brand, item.brand_en, item.brand)
}
