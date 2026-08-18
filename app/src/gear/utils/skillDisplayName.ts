import type { TFunction } from 'i18next'
import type { Skill } from '../types'

/** DB の Skill.name（日本語）を表示言語に合わせて返す。未知 ID は DB 名にフォールバック。 */
export function skillDisplayName(skill: Pick<Skill, 'id' | 'name'>, t: TFunction): string {
  if (skill.id === -1 || skill.id === 0) {
    return t('gear.empty', { defaultValue: skill.name || 'アキ' })
  }
  return t(`gear.power.${skill.id}`, { defaultValue: skill.name })
}
