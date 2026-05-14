import type { GearItem } from '../types'

interface Props {
  gear:      GearItem
  /** コンボ探索モードで選択済みの場合 true */
  selected?: boolean
  /** コンボ探索モードでタップ時のコールバック */
  onSelect?: () => void
}

const MAX_RARITY = 5

function Stars({ rarity }: { rarity: number }) {
  return (
    <div className="gear-stars">
      {Array.from({ length: MAX_RARITY }, (_, i) => (
        <span key={i} className={i < rarity ? 'star filled' : 'star'}>★</span>
      ))}
    </div>
  )
}

function SkillIcon({ image, name, size }: { image: string; name: string; size: 'main' | 'sub' }) {
  const isUnknown = name === 'はてな'
  return (
    <div className={`skill-icon skill-icon--${size} ${isUnknown ? 'skill-icon--unknown' : ''}`} title={name}>
      <img src={`/data/${image}`} alt={name} />
    </div>
  )
}

export function GearCard({ gear, selected, onSelect }: Props) {
  const subSlots = Array.from({ length: 3 }, (_, i) => gear.additional_skills[i] ?? null)

  return (
    <div
      className={`gear-card${selected ? ' gear-card--selected' : ''}${onSelect ? ' gear-card--selectable' : ''}`}
      onClick={onSelect}
      role={onSelect ? 'button' : undefined}
      tabIndex={onSelect ? 0 : undefined}
      onKeyDown={onSelect ? (e) => { if (e.key === 'Enter' || e.key === ' ') onSelect() } : undefined}
    >

      {/* 上段: ブランドロゴ（左）・レアリティ（右） */}
      <div className="gear-card__header">
        <img
          className="gear-card__brand-logo"
          src={`/data/${gear.brand_image}`}
          alt={gear.brand}
          title={gear.brand}
        />
        <Stars rarity={gear.rarity} />
      </div>

      {/* ギア画像（中央） */}
      <div className="gear-card__image-wrap">
        <img
          className="gear-card__image"
          src={`/data/${gear.image}`}
          alt={gear.name}
          loading="lazy"
        />
      </div>

      {/* ギア名（中央） */}
      <div className="gear-card__name" title={gear.name}>{gear.name}</div>

      {/* EXP（右寄り） */}
      <div className="gear-card__exp">EXP {gear.exp.toLocaleString()}</div>

      {/* スキル: メイン + サブ3つ（横幅いっぱい） */}
      <div className="gear-card__skills">
        <SkillIcon image={gear.primary_skill.image} name={gear.primary_skill.name} size="main" />
        {subSlots.map((skill, i) =>
          skill ? (
            <SkillIcon key={i} image={skill.image} name={skill.name} size="sub" />
          ) : (
            <div key={i} className="skill-icon skill-icon--sub skill-icon--empty" />
          )
        )}
      </div>

    </div>
  )
}
