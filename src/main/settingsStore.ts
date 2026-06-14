import { join } from 'node:path'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'

import { app } from 'electron'

import { createDefaultSettings, normalizeSettings, type AppSettings } from '../shared/settings'

const settingsFileName = 'settings.json'

function settingsFilePath(): string {
  return join(app.getPath('userData'), settingsFileName)
}

/**
 * 現在の OS ロケールに基づく既定設定を返す。
 */
function defaults(): AppSettings {
  return createDefaultSettings(app.getLocale())
}

/**
 * 設定をロードする。
 * ファイルが無ければ既定を返す（書き込みはしない）。壊れた JSON / 不正値は安全に既定へ補正する。
 *
 * @returns 正規化済みの AppSettings
 */
export async function loadSettings(): Promise<AppSettings> {
  const fallback = defaults()
  let text: string
  try {
    text = await readFile(settingsFilePath(), 'utf8')
  } catch (error) {
    // 未保存（ENOENT）は静かに既定を返す。それ以外の IO 失敗（EACCES 等）は呼び出し側で通知させる。
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw error
  }
  try {
    return normalizeSettings(JSON.parse(text), fallback)
  } catch {
    // 壊れた JSON は通知できるよう reject する（App 側は既定で起動を継続する）。
    throw new Error('The settings file is corrupted.')
  }
}

/**
 * 設定を保存する（全体置換）。main 側で必ず再検証・正規化してから永続化する。
 * 一時ファイルへ書いてから rename し、owner-only（0600）にする。
 *
 * @param value 保存する設定（未検証値）
 * @returns 正規化して保存した AppSettings
 */
export async function saveSettings(value: unknown): Promise<AppSettings> {
  const normalized = normalizeSettings(value, defaults())
  const directory = app.getPath('userData')
  const destination = settingsFilePath()
  const temporary = `${destination}.tmp`
  await mkdir(directory, { recursive: true })
  await writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, destination)
  await chmod(destination, 0o600)
  return normalized
}
