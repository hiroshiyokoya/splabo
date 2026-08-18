import { useTranslation } from 'react-i18next'
import type { GearItem, Skill } from '../types'
import { skillDisplayName } from '../utils/skillDisplayName'

interface Props {
  gear:      GearItem
  /** コーデモードで選択済みの場合 true */
  selected?: boolean
  /** コーデモードでタップ時のコールバック */
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

function SkillIcon({ image, skill, size }: { image: string; skill: Skill; size: 'main' | 'sub' }) {
  const { t } = useTranslation()
  const isUnknown = skill.name === 'はてな'
  const name = isUnknown ? t('gear.unknownSkill') : skillDisplayName(skill, t)
  return (
    <div className={`skill-icon skill-icon--${size} ${isUnknown ? 'skill-icon--unknown' : ''}`} title={name}>
      <img src={image} alt={name} />
    </div>
  )
}

export function GearCard({ gear, selected, onSelect }: Props) {
  const { t } = useTranslation()
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
          src={gear.brand_image}
          alt={gear.brand}
          title={gear.brand}
        />
        <Stars rarity={gear.rarity} />
      </div>

      {/* ギア画像（中央） */}
      <div className="gear-card__image-wrap">
        <img
          className="gear-card__image"
          src={gear.image}
          alt={gear.name}
          loading="lazy"
        />
      </div>

      {/* ギア名（中央） */}
      <div className="gear-card__name" title={gear.name}>{gear.name}</div>

      {/* ケイケン値（右寄り） */}
      <div className="gear-card__exp">{t('gear.exp', { value: gear.exp.toLocaleString() })}</div>

      {/* スキル: メイン + サブ3つ（横幅いっぱい） */}
      <div className="gear-card__skills">
        <SkillIcon image={gear.primary_skill.image} skill={gear.primary_skill} size="main" />
        {subSlots.map((skill, i) =>
          skill ? (
            <SkillIcon key={i} image={skill.image} skill={skill} size="sub" />
          ) : (
            <div key={i} className="skill-icon skill-icon--sub skill-icon--empty" />
          )
        )}
      </div>

    </div>
  )
}
