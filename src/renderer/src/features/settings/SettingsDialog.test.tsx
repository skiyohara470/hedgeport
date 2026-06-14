// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createDefaultSettings } from '../../../../shared/settings'
import { I18nProvider } from '../i18n/I18nContext'
import { SettingsDialog } from './SettingsDialog'

afterEach(cleanup)

const renderDialog = (language: 'ja' | 'en', overrides: Partial<Parameters<typeof SettingsDialog>[0]> = {}) => {
  const value = createDefaultSettings(language === 'ja' ? 'ja' : 'en')
  const props = {
    value,
    onChange: vi.fn(),
    onSave: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  }
  render(
    <I18nProvider language={language}>
      <SettingsDialog {...props} />
    </I18nProvider>
  )
  return props
}

describe('SettingsDialog', () => {
  it('英語ラベルで主要項目を表示する', () => {
    renderDialog('en')
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy()
    expect(screen.getByLabelText('Theme')).toBeTruthy()
    expect(screen.getByLabelText('Language')).toBeTruthy()
    expect(screen.getByLabelText('Font size')).toBeTruthy()
    expect(screen.getByLabelText('Display density')).toBeTruthy()
    expect(screen.getByLabelText('Show hidden files')).toBeTruthy()
    expect(screen.getByLabelText('Confirm before delete')).toBeTruthy()
  })

  it('日本語ではラベルを翻訳する', () => {
    renderDialog('ja')
    expect(screen.getByRole('dialog', { name: '設定' })).toBeTruthy()
    expect(screen.getByLabelText('テーマ')).toBeTruthy()
    expect(screen.getByLabelText('隠しファイルを表示')).toBeTruthy()
  })

  it('変更で onChange を呼ぶ（即時プレビュー）', () => {
    const props = renderDialog('en')
    fireEvent.change(screen.getByLabelText('Theme'), { target: { value: 'light' } })
    expect(props.onChange).toHaveBeenCalledWith(expect.objectContaining({ theme: 'light' }))
    fireEvent.click(screen.getByLabelText('Show hidden files'))
    expect(props.onChange).toHaveBeenCalledWith(expect.objectContaining({ showHiddenFiles: true }))
  })

  it('Save / Cancel を発火する', () => {
    const props = renderDialog('en')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(props.onSave).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(props.onCancel).toHaveBeenCalledTimes(1)
  })

  it('Escape は 1 回だけ onCancel を呼ぶ（二重発火しない）', () => {
    const props = renderDialog('en')
    // dialog 内 input にフォーカスしてから Escape（bubble との二重発火がないことを確認）。
    screen.getByLabelText('Theme').focus()
    fireEvent.keyDown(screen.getByLabelText('Theme'), { key: 'Escape', bubbles: true })
    expect(props.onCancel).toHaveBeenCalledTimes(1)
  })

  it('保存中は操作不可、エラーを表示する', () => {
    renderDialog('en', { saving: true, error: 'Could not save settings.' })
    expect((screen.getByRole('button', { name: 'Saving…' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByLabelText('Theme') as HTMLSelectElement).disabled).toBe(true)
    expect(screen.getByRole('alert').textContent).toBe('Could not save settings.')
  })
})
