import { describe, expect, it } from 'vitest'

import { mouseButtonDirection, reduceNavigation, shouldAcceptNavigation, type LastNavigation } from './mouseNavigation'

describe('mouseButtonDirection', () => {
  it('button 3=back / 4=forward、それ以外は null', () => {
    expect(mouseButtonDirection(3)).toBe('back')
    expect(mouseButtonDirection(4)).toBe('forward')
    expect(mouseButtonDirection(0)).toBeNull()
    expect(mouseButtonDirection(2)).toBeNull()
  })
})

describe('shouldAcceptNavigation', () => {
  const prev = (over: Partial<LastNavigation> = {}): LastNavigation => ({
    direction: 'back',
    source: 'ipc',
    time: 1000,
    ...over,
  })

  it('直近が無ければ受理', () => {
    expect(shouldAcceptNavigation(null, { direction: 'back', source: 'ipc' }, 1000)).toBe(true)
  })

  it('同方向・別 source・短時間内のみ拒否（IPC↔DOM の二重通知）', () => {
    expect(shouldAcceptNavigation(prev(), { direction: 'back', source: 'dom' }, 1100)).toBe(false)
  })

  it('同 source の連続入力は受理（素早い 2 連クリック）', () => {
    expect(shouldAcceptNavigation(prev({ source: 'dom' }), { direction: 'back', source: 'dom' }, 1010)).toBe(true)
  })

  it('方向が違えば受理', () => {
    expect(shouldAcceptNavigation(prev(), { direction: 'forward', source: 'dom' }, 1050)).toBe(true)
  })

  it('ウィンドウを過ぎれば別 source でも受理', () => {
    expect(shouldAcceptNavigation(prev(), { direction: 'back', source: 'dom' }, 1000 + 301)).toBe(true)
  })
})

describe('reduceNavigation', () => {
  it('受理・拒否に関わらず観測を last へ記録する', () => {
    // 拒否ケース（二重通知）でも last は今回の入力で更新される。
    const prev: LastNavigation = { direction: 'back', source: 'ipc', time: 1000 }
    const rejected = reduceNavigation(prev, { direction: 'back', source: 'dom' }, 1100)
    expect(rejected.accept).toBe(false)
    expect(rejected.last).toEqual({ direction: 'back', source: 'dom', time: 1100 })
  })

  it('IPC accept → DOM duplicate reject → 直後 DOM 入力は accept（取りこぼさない）', () => {
    // 1) IPC back: 直近なし → accept、last=ipc。
    const s1 = reduceNavigation(null, { direction: 'back', source: 'ipc' }, 1000)
    expect(s1.accept).toBe(true)
    // 2) 同一物理入力の DOM back（別 source・短時間）→ reject。だが last は dom に更新。
    const s2 = reduceNavigation(s1.last, { direction: 'back', source: 'dom' }, 1010)
    expect(s2.accept).toBe(false)
    // 3) ユーザーが押した 2 回目の DOM back（直近 dom と同 source）→ accept。
    const s3 = reduceNavigation(s2.last, { direction: 'back', source: 'dom' }, 1020)
    expect(s3.accept).toBe(true)
  })
})
