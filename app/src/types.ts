export interface Skill {
  id: number
  name: string
  image: string
}

export interface GearItem {
  id: number
  name: string
  rarity: number
  brand: string
  brand_image: string
  image: string
  primary_skill: Skill
  additional_skills: Skill[]
  exp: number
}

export type GearCategory = 'head' | 'clothing' | 'shoes'

export interface GearDB {
  head: GearItem[]
  clothing: GearItem[]
  shoes: GearItem[]
}
