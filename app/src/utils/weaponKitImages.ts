import { invoke } from '@tauri-apps/api/core'
import type { WeaponRecord } from '../types'

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
