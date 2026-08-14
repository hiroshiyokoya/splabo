import { invoke } from '@tauri-apps/api/core'
import type { WeaponRecord } from '../types'
import { kitIconsForWeapon, type WeaponMeta } from './scatterCategoryColors'
import type { WeaponKitTipData } from '../components/charts/WeaponKitTip'

/** ブキ軸ラベル用チップ(#643)。名前は必ず出す。画像が無ければ省略。 */
export function weaponAxisTip(
  weaponName: string | null | undefined,
  meta?: Map<string, WeaponMeta>,
  weaponImages?: Map<string, string>,
  subImages?: Map<string, string>,
  spImages?: Map<string, string>,
): WeaponKitTipData | undefined {
  if (!weaponName) return undefined
  return {
    name: weaponName,
    iconUrl: weaponImages?.get(weaponName) ?? null,
    ...kitIconsForWeapon(weaponName, meta, subImages, spImages),
  }
}

/** メインブキ画像を名前ごとに事前ロードする。 */
export async function loadWeaponImageMap(names: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(names.filter(Boolean))]
  const results = await Promise.all(
    unique.map(name =>
      invoke<string | null>('read_image', { kind: 'weapon', name })
        .then(url => (url ? ([name, url] as [string, string]) : null))
        .catch(() => null),
    ),
  )
  return new Map(results.filter((r): r is [string, string] => r !== null))
}

/** サブ／スペシャル画像をユニーク名だけで事前ロードする(#641)。 */
export async function loadSubSpImageMaps(
  list: WeaponRecord[],
): Promise<{ subImages: Map<string, string>; spImages: Map<string, string> }> {
  const uniqueSubs = [...new Set(list.map(w => w.sub_weapon).filter((n): n is string => !!n))]
  const uniqueSps  = [...new Set(list.map(w => w.special_weapon).filter((n): n is string => !!n))]
  const loadKind = (kind: 'sub_weapon' | 'special_weapon', names: string[]) =>
    Promise.all(
      names.map(name =>
        invoke<string | null>('read_image', { kind, name })
          .then(url => (url ? ([name, url] as [string, string]) : null))
          .catch(() => null),
      ),
    ).then(results => new Map(results.filter((r): r is [string, string] => r !== null)))
  const [subImages, spImages] = await Promise.all([
    loadKind('sub_weapon', uniqueSubs),
    loadKind('special_weapon', uniqueSps),
  ])
  return { subImages, spImages }
}
