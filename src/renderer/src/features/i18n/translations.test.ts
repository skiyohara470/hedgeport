import { describe, expect, it } from 'vitest'

import { createTranslator } from './translations'

describe('createTranslator', () => {
  it('言語ごとに辞書を引く', () => {
    expect(createTranslator('en')('action.open')).toBe('Open')
    expect(createTranslator('ja')('action.open')).toBe('開く')
  })

  it('プレースホルダを params で置換する', () => {
    expect(createTranslator('en')('action.deleteN', { count: 3 })).toBe('Delete 3 items')
    expect(createTranslator('ja')('action.deleteN', { count: 3 })).toBe('3 件を削除')
    expect(createTranslator('ja')('connection.dragToReorder', { name: 'Prod' })).toBe('Prod をドラッグして並び替え')
  })

  it('未知言語は英語へフォールバックする', () => {
    expect(createTranslator('de' as 'en')('common.save')).toBe('Save')
  })
})
