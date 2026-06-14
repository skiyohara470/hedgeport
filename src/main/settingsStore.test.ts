import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

const { getPath, getLocale } = vi.hoisted(() => ({
  getPath: vi.fn<(name: string) => string>(),
  getLocale: vi.fn<() => string>(),
}))

vi.mock('electron', () => ({ app: { getPath, getLocale } }))

import { SETTINGS_VERSION } from '../shared/settings'
import { loadSettings, saveSettings } from './settingsStore'

describe('settingsStore', () => {
  let tempDir: string

  afterEach(async () => {
    vi.restoreAllMocks()
    if (tempDir) await rm(tempDir, { recursive: true, force: true })
  })

  it('未保存時はロケール由来の既定を返す（書き込みなし）', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'hedgeport-settings-'))
    getPath.mockReturnValue(tempDir)
    getLocale.mockReturnValue('ja-JP')

    await expect(loadSettings()).resolves.toMatchObject({ theme: 'system', language: 'ja' })
    await expect(stat(join(tempDir, 'settings.json'))).rejects.toThrow()
  })

  it('保存して再読み込みでき、0600 で永続化する', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'hedgeport-settings-'))
    getPath.mockReturnValue(tempDir)
    getLocale.mockReturnValue('en-US')

    const saved = await saveSettings({
      version: SETTINGS_VERSION,
      theme: 'dark',
      fontSize: 'large',
      density: 'compact',
      showHiddenFiles: true,
      confirmBeforeDelete: false,
      language: 'ja',
    })
    expect(saved.theme).toBe('dark')

    await expect(loadSettings()).resolves.toEqual(saved)
    const info = await stat(join(tempDir, 'settings.json'))
    expect(info.mode & 0o777).toBe(0o600)
  })

  it('保存時に不正値を既定へ補正する', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'hedgeport-settings-'))
    getPath.mockReturnValue(tempDir)
    getLocale.mockReturnValue('en-US')

    const saved = await saveSettings({ theme: 'neon', language: 'de', showHiddenFiles: 'yes' })
    expect(saved.theme).toBe('system')
    expect(saved.language).toBe('en')
    expect(saved.showHiddenFiles).toBe(false)
  })

  it('壊れた JSON は通知のため reject する（ENOENT は既定）', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'hedgeport-settings-'))
    getPath.mockReturnValue(tempDir)
    getLocale.mockReturnValue('en-US')
    await writeFile(join(tempDir, 'settings.json'), '{broken', 'utf8')

    await expect(loadSettings()).rejects.toThrow('corrupted')
  })
})
