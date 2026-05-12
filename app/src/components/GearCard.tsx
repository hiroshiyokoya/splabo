import type { GearItem } from '../types'

interface Props {
  gear: GearItem
}

const MAX_RARITY = 4

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

export function GearCard({ gear }: Props) {
  const subSlots = Array.from({ length: 3 }, (_, i) => gear.additional_skills[i] ?? null)

  return (
    <div className="gear-card">
      <div className="gear-card__image-wrap">
        <img
          className="gear-card__image"
          src={`/data/${gear.image}`}
          alt={gear.name}
          loading="lazy"
        />
      </div>

      <Stars rarity={gear.rarity} />

      <div className="gear-card__name" title={gear.name}>{gear.name}</div>

      <div className="gear-card__meta">
        <span className="gear-card__brand" title={gear.brand}>
          <img
            className="gear-card__brand-logo"
            src={`/data/${gear.brand_image}`}
            alt={gear.brand}
          />
        </span>
        <span className="gear-card__exp">EXP {gear.exp.toLocaleString()}</span>
      </div>

      <div className="gear-card__skills">
        <SkillIcon image={gear.primary_skill.image} name={gear.primary_skill.name} size="main" />
        <div className="gear-card__sub-skills">
          {subSlots.map((skill, i) =>
            skill ? (
              <SkillIcon key={i} image={skill.image} name={skill.name} size="sub" />
            ) : (
              <div key={i} className="skill-icon skill-icon--sub skill-icon--empty" />
            )
          )}
        </div>
      </div>
    </div>
  )
}
