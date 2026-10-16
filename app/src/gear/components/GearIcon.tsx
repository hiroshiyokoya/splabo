import type { GearItem } from '../types'
import { gearBrandDisplayName, gearItemDisplayName } from '../utils/gearItemDisplayName'

/**
 * ギアのアイコンに、ブランドのアイコンを小さく重ねたもの（#833）。
 *
 * コーデの候補・保存コーデのように、ギアの絵だけが並ぶところで使う。
 * どのブランドか（＝付きやすいギアパワー）を一目で分かるようにする。
 * 大きさは親の指定に従う（`.gear-icon` の幅・高さを親の CSS で決める）。
 */
export function GearIcon({ gear, className }: { gear: GearItem; className?: string }) {
  const name = gearItemDisplayName(gear)
  return (
    <span className={`gear-icon${className ? ` ${className}` : ''}`} title={name}>
      <img className="gear-icon__img" src={gear.image} alt={name} />
      {gear.brand_image && (
        <img className="gear-icon__brand" src={gear.brand_image} alt={gearBrandDisplayName(gear)} />
      )}
    </span>
  )
}
