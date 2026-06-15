import { beforeEach, describe, expect, it, vi } from 'vitest'

const { readMock, writeMock, deleteMock, readFileMock, writeFileMock, createProviderMock } = vi.hoisted(() => ({
  readMock: vi.fn(),
  writeMock: vi.fn(),
  deleteMock: vi.fn(),
  readFileMock: vi.fn(),
  writeFileMock: vi.fn(),
  createProviderMock: vi.fn(),
}))

// electron は connectionStore（isConnectionTarget 経由）が import するので最小モックを置く。
vi.mock('electron', () => ({ app: { getPath: vi.fn() } }))

vi.mock('node:fs/promises', () => ({
  readFile: readFileMock,
  writeFile: writeFileMock,
}))

vi.mock('./providers/createStorageProvider', () => ({
  createStorageProvider: createProviderMock,
}))

import { MAX_EDITABLE_TEXT_BYTES, MAX_PREVIEW_TEXT_BYTES } from '../shared/transfer'
import {
  deleteFile,
  downloadFile,
  downloadToDirectory,
  readRemoteRevision,
  readRemoteTextWithRevision,
  readTextFile,
  uploadFile,
  writeRemoteTextWithRevision,
  writeTextFile,
} from './fileTransfer'
import { computeContentRevision } from './contentRevision'

const target = {
  id: 'sftp-1',
  name: 'SFTP',
  kind: 'sftp' as const,
  host: 'sftp.example.com',
  port: 22,
  username: 'user',
  password: 'password',
  rootPath: '/exports',
}

describe('fileTransfer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createProviderMock.mockReturnValue({ list: vi.fn(), read: readMock, write: writeMock, delete: deleteMock })
  })

  describe('downloadFile', () => {
    it('read したバイト列をローカル絶対パスへ書き出す', async () => {
      const bytes = new Uint8Array([1, 2, 3])
      readMock.mockResolvedValue(bytes)

      await downloadFile(target, '/reports/a.csv', '/Users/me/a.csv')

      expect(createProviderMock).toHaveBeenCalledWith(target)
      expect(readMock).toHaveBeenCalledWith('/reports/a.csv')
      expect(writeFileMock).toHaveBeenCalledWith('/Users/me/a.csv', bytes)
    })

    it('不正な接続設定を弾く', async () => {
      await expect(downloadFile({ id: 'x' }, '/a.csv', '/Users/me/a.csv')).rejects.toThrow(
        'Invalid connection settings.'
      )
      expect(readMock).not.toHaveBeenCalled()
    })

    it('相対ローカルパスを弾く', async () => {
      await expect(downloadFile(target, '/a.csv', 'relative/a.csv')).rejects.toThrow('Invalid local file path.')
    })

    it('正規化でルート相当・親へ滑り込む曖昧なリモートパスを弾く', async () => {
      // provider 側で '/' へ正規化される、または非 canonical な入力はすべて拒否する。
      const invalidPaths = ['/', '', '   ', '//a.csv', '/a.csv/', '/./a.csv', '/dir/../a.csv', '/foo//bar', 'a.csv']
      for (const path of invalidPaths) {
        await expect(downloadFile(target, path, '/Users/me/a.csv')).rejects.toThrow('Invalid remote file path.')
      }
      expect(readMock).not.toHaveBeenCalled()
    })

    it('正規化済みの絶対ファイルパスは受理する', async () => {
      readMock.mockResolvedValue(new Uint8Array([1]))
      await expect(downloadFile(target, '/dir/a.csv', '/Users/me/a.csv')).resolves.toBeUndefined()
      expect(readMock).toHaveBeenCalledWith('/dir/a.csv')
    })
  })

  describe('downloadToDirectory', () => {
    it('ディレクトリ + remote basename を platform-safe に結合して書き出す', async () => {
      const bytes = new Uint8Array([4, 5])
      readMock.mockResolvedValue(bytes)

      await downloadToDirectory(target, '/reports/a.csv', '/Users/me/dl')

      expect(readMock).toHaveBeenCalledWith('/reports/a.csv')
      expect(writeFileMock).toHaveBeenCalledWith('/Users/me/dl/a.csv', bytes)
    })

    it('相対ディレクトリを弾く', async () => {
      await expect(downloadToDirectory(target, '/a.csv', 'relative/dir')).rejects.toThrow('Invalid local file path.')
      expect(readMock).not.toHaveBeenCalled()
    })
  })

  describe('uploadFile', () => {
    it('ローカルを readFile し provider.write へ Uint8Array で渡す', async () => {
      readFileMock.mockResolvedValue(Buffer.from([9, 8, 7]))

      await uploadFile(target, '/Users/me/a.csv', '/reports/a.csv')

      expect(readFileMock).toHaveBeenCalledWith('/Users/me/a.csv')
      expect(writeMock).toHaveBeenCalledWith('/reports/a.csv', new Uint8Array([9, 8, 7]))
    })
  })

  describe('readTextFile', () => {
    it('UTF-8 としてデコードして TextDocument を返す', async () => {
      readMock.mockResolvedValue(new TextEncoder().encode('こんにちは'))

      await expect(readTextFile(target, '/notes.txt')).resolves.toEqual({
        text: 'こんにちは',
        encoding: 'utf-8',
        bom: false,
      })
    })

    it('UTF-8 BOM 付きは bom:true を保持し、本文から BOM を除く', async () => {
      readMock.mockResolvedValue(new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('hi')]))

      await expect(readTextFile(target, '/bom.txt')).resolves.toEqual({ text: 'hi', encoding: 'utf-8', bom: true })
    })

    it('サイズ上限を超えると明示エラー', async () => {
      readMock.mockResolvedValue(new Uint8Array(MAX_EDITABLE_TEXT_BYTES + 1))

      await expect(readTextFile(target, '/big.txt')).rejects.toThrow('too large to edit')
    })

    it('Preview 上限注入で 1MiB 超〜20MiB 以下は読めるが、Editor 既定は弾く', async () => {
      const data = new Uint8Array(MAX_EDITABLE_TEXT_BYTES + 1024).fill(0x61)
      // Editor（既定 1MiB）は弾く。
      readMock.mockResolvedValue(data)
      await expect(readTextFile(target, '/big.txt')).rejects.toThrow('too large to edit')
      // Preview（20MiB 上限を注入）は読める。
      readMock.mockResolvedValue(data)
      const doc = await readTextFile(target, '/big.txt', 'auto', { maxBytes: MAX_PREVIEW_TEXT_BYTES })
      expect(doc.text.length).toBe(MAX_EDITABLE_TEXT_BYTES + 1024)
    })

    it('Preview 上限 20MiB 超は preview 用エラーで弾く', async () => {
      readMock.mockResolvedValue(new Uint8Array(MAX_PREVIEW_TEXT_BYTES + 1).fill(0x61))
      await expect(
        readTextFile(target, '/huge.txt', 'auto', {
          maxBytes: MAX_PREVIEW_TEXT_BYTES,
          tooLargeMessage: 'File is too large to preview (limit 20 MiB).',
        })
      ).rejects.toThrow('too large to preview')
    })

    it('NUL を含むとバイナリ扱いで弾く', async () => {
      readMock.mockResolvedValue(new Uint8Array([0x68, 0x00, 0x69]))

      await expect(readTextFile(target, '/bin.dat')).rejects.toThrow('binary')
    })

    it('不正な UTF-8 は文字コード選択を促すエラーで弾く', async () => {
      readMock.mockResolvedValue(new Uint8Array([0xff, 0xfe, 0xfd]))

      await expect(readTextFile(target, '/bad.txt')).rejects.toThrow('Choose another encoding')
    })

    it('shift_jis 指定で日本語をデコードできる', async () => {
      // 「日本語」の Shift_JIS バイト列。
      readMock.mockResolvedValue(new Uint8Array([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]))

      await expect(readTextFile(target, '/sjis.txt', 'shift_jis')).resolves.toEqual({
        text: '日本語',
        encoding: 'shift_jis',
        bom: false,
      })
    })

    it('未対応の文字コードは弾く', async () => {
      await expect(readTextFile(target, '/x.txt', 'utf-16')).rejects.toThrow('Unsupported encoding')
    })
  })

  describe('writeTextFile', () => {
    it('テキストを UTF-8 でエンコードして write する', async () => {
      await writeTextFile(target, '/notes.txt', 'hello')

      expect(writeMock).toHaveBeenCalledWith('/notes.txt', new TextEncoder().encode('hello'))
    })

    it('shift_jis 指定で日本語を SJIS バイト列として write する', async () => {
      await writeTextFile(target, '/sjis.txt', '日本語', 'shift_jis')

      expect(writeMock).toHaveBeenCalledWith('/sjis.txt', new Uint8Array([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]))
    })

    it('bom:true なら UTF-8 BOM を付けて write する', async () => {
      await writeTextFile(target, '/bom.txt', 'hi', 'utf-8', true)

      expect(writeMock).toHaveBeenCalledWith(
        '/bom.txt',
        new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('hi')])
      )
    })

    it('選択 encoding で表現できない文字を含む write を拒否する', async () => {
      // 絵文字は shift_jis で表現不能。roundtrip 不一致で write しない。
      await expect(writeTextFile(target, '/sjis.txt', 'hello 😀', 'shift_jis')).rejects.toThrow(
        'cannot represent some characters'
      )
      expect(writeMock).not.toHaveBeenCalled()
    })

    it('文字列でない text を弾く', async () => {
      await expect(writeTextFile(target, '/notes.txt', 123)).rejects.toThrow('Invalid text content.')
    })

    it('サイズ上限を超える text を弾く', async () => {
      const big = 'a'.repeat(MAX_EDITABLE_TEXT_BYTES + 1)

      await expect(writeTextFile(target, '/notes.txt', big)).rejects.toThrow('too large to save')
      expect(writeMock).not.toHaveBeenCalled()
    })

    it('曖昧なリモートパスを弾く（write も検証を通る）', async () => {
      for (const path of ['/', '//notes.txt', '/notes.txt/', '/dir/../notes.txt']) {
        await expect(writeTextFile(target, path, 'x')).rejects.toThrow('Invalid remote file path.')
      }
      expect(writeMock).not.toHaveBeenCalled()
    })
  })

  describe('revision つき read/write', () => {
    it('readRemoteTextWithRevision は document/revision/byteLength を返す（revision は生バイト由来）', async () => {
      const bytes = new TextEncoder().encode('hi')
      readMock.mockResolvedValue(bytes)
      const result = await readRemoteTextWithRevision(target, '/notes.txt')
      expect(result.document).toEqual({ text: 'hi', encoding: 'utf-8', bom: false })
      expect(result.byteLength).toBe(2)
      expect(result.revision).toBe(computeContentRevision(bytes))
    })

    it('readRemoteRevision は decode せず現在の内容リビジョンだけ返す', async () => {
      // NUL を含むバイナリでも revision は取れる。
      const bytes = new Uint8Array([0x00, 0x01])
      readMock.mockResolvedValue(bytes)
      await expect(readRemoteRevision(target, '/bin.dat')).resolves.toBe(computeContentRevision(bytes))
    })

    it('writeRemoteTextWithRevision は書き込んだ内容の revision と byteLength を返す', async () => {
      const result = await writeRemoteTextWithRevision(target, '/notes.txt', 'hi', 'utf-8', false)
      const written = writeMock.mock.calls[0][1] as Uint8Array
      expect(result.revision).toBe(computeContentRevision(written))
      expect(result.byteLength).toBe(written.byteLength)
    })
  })

  describe('deleteFile', () => {
    it('provider.delete へ委譲する', async () => {
      await deleteFile(target, '/reports/a.csv')

      expect(deleteMock).toHaveBeenCalledWith('/reports/a.csv')
    })

    it('曖昧なリモートパスを弾く（delete も検証を通る）', async () => {
      for (const path of ['/', '//a.csv', '/a.csv/', '/./a.csv']) {
        await expect(deleteFile(target, path)).rejects.toThrow('Invalid remote file path.')
      }
      expect(deleteMock).not.toHaveBeenCalled()
    })
  })
})
