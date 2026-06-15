import { describe, expect, it, vi } from 'vitest'

import { handleAppCommand, handleSwipe, mapAppCommand, mapSwipeDirection } from './navigationInput'

describe('mapAppCommand', () => {
  it('戻る/進むだけを写像し、未知コマンドは null', () => {
    expect(mapAppCommand('browser-backward')).toBe('back')
    expect(mapAppCommand('browser-forward')).toBe('forward')
    expect(mapAppCommand('volume-up')).toBeNull()
    expect(mapAppCommand('media-play-pause')).toBeNull()
  })
})

describe('mapSwipeDirection', () => {
  it('右=back / 左=forward、上下は null', () => {
    expect(mapSwipeDirection('right')).toBe('back')
    expect(mapSwipeDirection('left')).toBe('forward')
    expect(mapSwipeDirection('up')).toBeNull()
    expect(mapSwipeDirection('down')).toBeNull()
  })
})

describe('handleAppCommand', () => {
  it('戻る/進むのみ preventDefault + send する', () => {
    const preventDefault = vi.fn()
    const send = vi.fn()
    expect(handleAppCommand('browser-backward', { preventDefault, send })).toBe('back')
    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('back')
  })

  it('未知コマンドは preventDefault も send もしない', () => {
    const preventDefault = vi.fn()
    const send = vi.fn()
    expect(handleAppCommand('volume-up', { preventDefault, send })).toBeNull()
    expect(preventDefault).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })
})

describe('handleSwipe', () => {
  it('右/左のみ send（preventDefault は不要）', () => {
    const send = vi.fn()
    expect(handleSwipe('left', send)).toBe('forward')
    expect(send).toHaveBeenCalledWith('forward')
    send.mockClear()
    expect(handleSwipe('up', send)).toBeNull()
    expect(send).not.toHaveBeenCalled()
  })
})
