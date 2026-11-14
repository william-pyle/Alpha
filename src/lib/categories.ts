import type { CardCategory } from '../types'

export function categoryIcon(category: string, categories: CardCategory[]): string {
  return categories.find(item => item.id === category)?.icon ?? '📁'
}

export function categoryName(category: string, categories: CardCategory[]): string {
  return categories.find(item => item.id === category)?.name ?? category.replace(/-/g, ' ')
}
