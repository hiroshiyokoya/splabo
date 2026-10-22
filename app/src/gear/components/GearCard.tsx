import { useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { GearItem, Skill } from '../types'
import { skillDisplayName } from '../utils/skillDisplayName'
import { gearItemDisplayName, gearBrandDisplayName } from '../utils/gearItemDisplayName'
import { longestSegmentWidth } from '../utils/nameBreaks'

interface Props {
  gear:      GearItem
  /** コーデモードで選択済みの場合 true */
  selected?: boolean
  /** コーデモードでタップ時のコールバック */
  onSelect?: () => void
  /** コーデ PNG 用（#883）。ケイケン値を出さず、画像は遅延読み込みしない（写る前に撮らないため） */
  forExport?: boolean
  /** ギア名に改行の切れ目を入れる（buildNameBreaker・#886） */
  breakName?: (name: string) => string
}

const MAX_RARITY = 5

/** ギア名の切れ端を欄に入れるために縮めてよい下限（#888）。これより小さくするなら折り返す */
const MIN_NAME_SCALE = 0.8

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

export function GearCard({ gear, selected, onSelect, forExport = false, breakName }: Props) {
  const { t } = useTranslation()
  const subSlots = Array.from({ length: 3 }, (_, i) => gear.additional_skills[i] ?? null)
  const name = gearItemDisplayName(gear)
  const brokenName = breakName ? breakName(name) : name
  const hasBreaks = brokenName !== name
  // いちばん長い切れ端が欄に入るように、文字を縮める倍率（#888）。
  // 1 = そのまま、0 = MIN_NAME_SCALE まで縮めても入らない（keep-all をやめて長さをそろえて折り返す）。
  // 入らないまま keep-all にすると、非常改行で行末ぎりぎりで切られ、禁則も効かない。
  const nameRef = useRef<HTMLDivElement>(null)
  const appliedScale = useRef(1)
  const [nameScale, setNameScale] = useState(1)
  useLayoutEffect(() => {
    const el = nameRef.current
    if (!el || !hasBreaks) return
    const check = () => {
      const width = el.clientWidth
      if (width <= 0) return // 非表示などで測れない
      // 縮めたあとの大きさではなく、元の大きさで測る
      const baseSize = parseFloat(getComputedStyle(el).fontSize) / appliedScale.current
      const need = longestSegmentWidth(el, brokenName, baseSize)
      const ratio = need <= width ? 1 : width / need
      // 端数の丸めで 1px あふれないよう少しだけ余分に縮める
      const next = ratio >= 1 ? 1 : ratio >= MIN_NAME_SCALE ? Math.floor(ratio * 0.98 * 100) / 100 : 0
      appliedScale.current = next > 0 ? next : 1
      setNameScale(next)
    }
    check()
    // 欄の幅は flex で決まり、中身（文字の大きさ・keep-all）では変わらないので、測り直しでループしない
    const ro = new ResizeObserver(check)
    ro.observe(el)
    // ウェブフォント（スマホ版の丸ゴシック）が後から読み込まれると幅が変わる
    void document.fonts?.ready.then(check)
    return () => ro.disconnect()
  }, [hasBreaks, brokenName])
  // 切れ目があって（縮めれば）入るときだけ、単語の途中で改行しない
  const phrased = hasBreaks && nameScale > 0
  const nameStyle = phrased && nameScale < 1
    ? { fontSize: `calc(var(--card-font-size) * ${nameScale})` }
    : undefined
  const brand = gearBrandDisplayName(gear)

  return (
    <div
      className={`gear-card${selected ? ' gear-card--selected' : ''}${onSelect ? ' gear-card--selectable' : ''}`}
      onClick={onSelect}
      role={onSelect ? 'button' : undefined}
      tabIndex={onSelect ? 0 : undefined}
      onKeyDown={onSelect ? (e) => { if (e.key === 'Enter' || e.key === ' ') onSelect() } : undefined}
    >

      {/* 上段: ブランドロゴ（左）・ギア名（ロゴの右、下端を揃える）・レアリティ（右上）（#883） */}
      <div className="gear-card__header">
        <img
          className="gear-card__brand-logo"
          src={gear.brand_image}
          alt={brand}
          title={brand}
        />
        <div
          ref={nameRef}
          className={`gear-card__name${phrased ? ' gear-card__name--phrased' : ''}`}
          style={nameStyle}
          title={name}
        >
          {brokenName}
        </div>
        <Stars rarity={gear.rarity} />
      </div>

      {/* ギア画像（中央） */}
      <div className="gear-card__image-wrap">
        <img
          className="gear-card__image"
          src={gear.image}
          alt={name}
          loading={forExport ? 'eager' : 'lazy'}
        />
      </div>

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

      {/* ケイケン値（パワーの下・右寄り） */}
      {!forExport && (
        <div className="gear-card__exp">{t('gear.exp', { value: gear.exp.toLocaleString() })}</div>
      )}

    </div>
  )
}
