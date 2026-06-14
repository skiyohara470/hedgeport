// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'

import type { StorageEntry } from '../../../../shared/storage'
import { createTranslator } from '../i18n/translations'
import {
  describeActions,
  isTypingTarget,
  matchesShortcut,
  menuItem,
  shortcutLabel,
  summarizeSelection,
  type ActionContext,
  type FileActionId,
} from './fileActions'

const file = (name: string): StorageEntry => ({ name, path: `/${name}`, type: 'file' })
const dir = (name: string): StorageEntry => ({ name, path: `/${name}`, type: 'directory' })

const baseContext = (overrides: Partial<ActionContext> = {}): ActionContext => ({
  paneKind: 'remote',
  selection: [file('a.txt')],
  busy: false,
  canDownloadToLocal: true,
  hasClipboard: false,
  ...overrides,
})

const find = (context: ActionContext, id: FileActionId) => describeActions(context).find((action) => action.id === id)!

describe('matchesShortcut', () => {
  const base = { key: 'd', metaKey: false, ctrlKey: true, shiftKey: false, altKey: false }

  it('mod / shift / key の一致を判定する', () => {
    expect(matchesShortcut(base, { key: 'd', mod: true })).toBe(true)
    expect(matchesShortcut({ ...base, shiftKey: true }, { key: 'd', mod: true })).toBe(false)
    expect(matchesShortcut({ ...base, shiftKey: true }, { key: 'd', mod: true, shift: true })).toBe(true)
  })

  it('alt 同時押しは常に不一致', () => {
    expect(matchesShortcut({ ...base, altKey: true }, { key: 'd', mod: true })).toBe(false)
  })

  it('Delete は Backspace を mac でのみ等価扱い', () => {
    const del = { key: 'Backspace', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false }
    // 非 mac（テスト環境）では Backspace を Delete として扱わない。
    expect(matchesShortcut(del, { key: 'Delete' })).toBe(false)
    expect(matchesShortcut({ ...del, key: 'Delete' }, { key: 'Delete' })).toBe(true)
  })
})

describe('shortcutLabel / menuItem', () => {
  it('1 文字キーは大文字化し修飾を連結する', () => {
    expect(shortcutLabel({ key: 'd', mod: true, shift: true })).toBe('Ctrl+Shift+D')
    expect(shortcutLabel({ key: 'Enter' })).toBe('Enter')
  })

  it('menuItem は shortcut から表示ラベルを生成する', () => {
    const item = menuItem('Copy', () => undefined, { shortcut: { key: 'c', mod: true } })
    expect(item.shortcutLabel).toBe('Ctrl+C')
    expect(item.disabled).toBeUndefined()
  })
})

describe('isTypingTarget', () => {
  it('input/textarea を入力中とみなす', () => {
    expect(isTypingTarget(document.createElement('input'))).toBe(true)
    expect(isTypingTarget(document.createElement('textarea'))).toBe(true)
    expect(isTypingTarget(document.createElement('div'))).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
  })
})

describe('describeActions', () => {
  it('単一ファイル選択(remote)で download/rename/delete が有効', () => {
    const context = baseContext()
    expect(find(context, 'download-local').enabled).toBe(true)
    expect(find(context, 'download-dialog').enabled).toBe(true)
    expect(find(context, 'rename').enabled).toBe(true)
    expect(find(context, 'delete').enabled).toBe(true)
    expect(find(context, 'open').enabled).toBe(true)
  })

  it('複数選択では rename/open が無効、delete は件数ラベル', () => {
    const context = baseContext({ selection: [file('a.txt'), file('b.txt'), file('c.txt')] })
    expect(find(context, 'rename').enabled).toBe(false)
    expect(find(context, 'open').enabled).toBe(false)
    expect(find(context, 'delete').label).toBe('Delete 3 items')
    expect(find(context, 'download-local').label).toBe('Download 3 files to Local')
  })

  it('ディレクトリを含むと download/copy は無効（delete は有効）', () => {
    const context = baseContext({ selection: [file('a.txt'), dir('sub')] })
    expect(find(context, 'download-local').enabled).toBe(false)
    expect(find(context, 'download-dialog').enabled).toBe(false)
    expect(find(context, 'copy').enabled).toBe(false)
    expect(find(context, 'delete').enabled).toBe(true)
  })

  it('ローカルペイン非表示なら download-local は無効、download-dialog は有効', () => {
    const context = baseContext({ canDownloadToLocal: false })
    expect(find(context, 'download-local').enabled).toBe(false)
    expect(find(context, 'download-dialog').enabled).toBe(true)
  })

  it('busy 中は破壊/転送系が無効、copy-path は有効', () => {
    const context = baseContext({ busy: true })
    expect(find(context, 'delete').enabled).toBe(false)
    expect(find(context, 'download-local').enabled).toBe(false)
    expect(find(context, 'new-folder').enabled).toBe(false)
    expect(find(context, 'copy-path').enabled).toBe(true)
  })

  it('paste はクリップボードがあるときだけ有効', () => {
    expect(find(baseContext({ hasClipboard: false }), 'paste').enabled).toBe(false)
    expect(find(baseContext({ hasClipboard: true }), 'paste').enabled).toBe(true)
  })

  it('local pane では upload が現れ download は現れない', () => {
    const ids = describeActions(baseContext({ paneKind: 'local', selection: [file('a.txt')] })).map((a) => a.id)
    expect(ids).toContain('upload')
    expect(ids).not.toContain('download-local')
  })

  it('reveal / open-folder は local のみ。reveal は単一選択時のみ有効', () => {
    const localSingle = baseContext({ paneKind: 'local', selection: [file('a.txt')] })
    const localMulti = baseContext({ paneKind: 'local', selection: [file('a.txt'), file('b.txt')] })
    expect(describeActions(localSingle).map((a) => a.id)).toContain('reveal')
    expect(describeActions(baseContext()).map((a) => a.id)).not.toContain('reveal')
    expect(find(localSingle, 'reveal').enabled).toBe(true)
    expect(find(localMulti, 'reveal').enabled).toBe(false)
    expect(find(localMulti, 'open-folder').enabled).toBe(true)
    // 非 mac/非 Windows のテスト環境では File Manager 表記。
    expect(find(localSingle, 'reveal').label).toBe('Show in File Manager')
  })

  it('translator を渡すとラベルを翻訳する', () => {
    const ja = createTranslator('ja')
    const single = baseContext({ selection: [file('a.txt')], t: ja })
    const multi = baseContext({ selection: [file('a.txt'), file('b.txt'), file('c.txt')], t: ja })
    expect(find(single, 'open').label).toBe('開く')
    expect(find(multi, 'delete').label).toBe('3 件を削除')
    expect(find(baseContext({ paneKind: 'local', selection: [file('a.txt')], t: ja }), 'reveal').label).toBe(
      'File Manager で表示'
    )
  })

  it('S3 bucket 一覧ルートでは mutation / 転送 / open-with を無効化し、ディレクトリ Open のみ残す', () => {
    // bucket（ディレクトリ）を単一選択した状態の root。
    const root = baseContext({ selection: [dir('bucket-a')], isBucketListRoot: true })
    // Open（ディレクトリ移動）は有効。
    expect(find(root, 'open').enabled).toBe(true)
    // mutation / 転送 / open-with / copy-path は無効。
    for (const id of [
      'open-with',
      'download-local',
      'download-dialog',
      'copy',
      'paste',
      'rename',
      'copy-path',
      'delete',
      'new-folder',
    ] as FileActionId[]) {
      expect(find({ ...root, hasClipboard: true }, id).enabled).toBe(false)
    }
  })

  it('bucket 内（非ルート）では通常の S3 アクションが有効に戻る', () => {
    const insideBucket = baseContext({ selection: [file('a.txt')], isBucketListRoot: false })
    expect(find(insideBucket, 'download-local').enabled).toBe(true)
    expect(find(insideBucket, 'delete').enabled).toBe(true)
    expect(find(insideBucket, 'rename').enabled).toBe(true)
    expect(find({ ...insideBucket, hasClipboard: true }, 'paste').enabled).toBe(true)
    expect(find(baseContext({ selection: [], isBucketListRoot: false }), 'new-folder').enabled).toBe(true)
  })
})

describe('summarizeSelection', () => {
  it('単一は名前、複数は件数要約', () => {
    expect(summarizeSelection([file('a.txt')])).toBe('"a.txt"')
    expect(summarizeSelection([file('a.txt'), file('b.txt'), dir('sub')])).toBe('2 files and 1 folder')
  })
})
