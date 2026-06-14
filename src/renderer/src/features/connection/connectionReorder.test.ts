import { describe, expect, it } from 'vitest'

import { reorderConnections } from './connectionReorder'
import type { ConnectionTarget } from './connectionTypes'

const item = (id: string): ConnectionTarget => ({
  id,
  name: id,
  kind: 'sftp',
  host: 'example.com',
  port: 22,
  username: 'u',
  password: 'p',
  rootPath: '/',
})

const ids = (targets: ConnectionTarget[] | null): string[] | null => targets?.map((t) => t.id) ?? null

describe('reorderConnections', () => {
  const base = [item('a'), item('b'), item('c'), item('d')]

  it('先頭を末尾の後ろへ移動する', () => {
    expect(ids(reorderConnections(base, 'a', 'd', 'after'))).toEqual(['b', 'c', 'd', 'a'])
  })

  it('末尾を先頭の前へ移動する', () => {
    expect(ids(reorderConnections(base, 'd', 'a', 'before'))).toEqual(['d', 'a', 'b', 'c'])
  })

  it('中間へ移動する（before / after）', () => {
    expect(ids(reorderConnections(base, 'a', 'c', 'before'))).toEqual(['b', 'a', 'c', 'd'])
    expect(ids(reorderConnections(base, 'a', 'c', 'after'))).toEqual(['b', 'c', 'a', 'd'])
  })

  it('変化しない drop（same / no-op）は null', () => {
    // 自分自身。
    expect(reorderConnections(base, 'a', 'a', 'before')).toBeNull()
    // 既に a の直後に b がある状態で a の after / b の before へ落としても変化なし。
    expect(reorderConnections(base, 'b', 'a', 'after')).toBeNull()
    expect(reorderConnections(base, 'a', 'b', 'before')).toBeNull()
  })

  it('不明な id（外部 drop / 存在しない）は null', () => {
    expect(reorderConnections(base, 'zzz', 'a', 'before')).toBeNull()
    expect(reorderConnections(base, 'a', 'zzz', 'after')).toBeNull()
  })

  it('元の配列は変更しない', () => {
    reorderConnections(base, 'a', 'd', 'after')
    expect(ids(base)).toEqual(['a', 'b', 'c', 'd'])
  })
})
