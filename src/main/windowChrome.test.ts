import { describe, expect, it } from 'vitest'

import { windowChromeOptions } from './windowChrome'

describe('windowChromeOptions', () => {
  it('macOS は hiddenInset + traffic light 位置を返す', () => {
    expect(windowChromeOptions('darwin')).toEqual({
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 14, y: 13 },
    })
  })

  it('Windows / Linux は native frame 維持のため空（mac 風を模倣しない）', () => {
    expect(windowChromeOptions('win32')).toEqual({})
    expect(windowChromeOptions('linux')).toEqual({})
  })
})
