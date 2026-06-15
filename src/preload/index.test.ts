// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { exposeMock, invokeMock, sendMock, onMock, removeListenerMock } = vi.hoisted(() => ({
  exposeMock: vi.fn(),
  invokeMock: vi.fn(),
  sendMock: vi.fn(),
  onMock: vi.fn(),
  removeListenerMock: vi.fn(),
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: exposeMock },
  ipcRenderer: { invoke: invokeMock, send: sendMock, on: onMock, removeListener: removeListenerMock },
}))

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

describe('preload api', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    // contextIsolation 有効時の経路（contextBridge 公開）を通す。
    Object.defineProperty(process, 'contextIsolated', { value: true, configurable: true })
  })

  it('window へ公開する API がファイル転送 IPC を正しい channel と引数で呼ぶ', async () => {
    await import('./index')

    expect(exposeMock).toHaveBeenCalledWith('hedgeport', expect.any(Object))
    const api = exposeMock.mock.calls[0][1] as Record<string, (...args: unknown[]) => unknown>

    api.downloadFile(target, '/remote/a.csv', '/local/a.csv')
    api.uploadFile(target, '/local/a.csv', '/remote/a.csv')
    api.readText(target, '/remote/a.txt')
    api.writeText(target, '/remote/a.txt', 'hello')
    api.deleteFile(target, '/remote/a.csv')
    api.downloadToDirectory(target, '/remote/a.csv', '/local/dir')
    api.pickDirectory()
    api.createRemoteDirectory(target, '/remote', 'new')
    api.renameRemote(target, '/remote/a.txt', 'b.txt', 'file')
    api.createLocalDirectory('/local', 'new')
    api.renameLocal('/local/a.txt', 'b.txt', 'file')
    api.readLocalText('/local/a.txt', 'shift_jis')
    api.writeLocalText('/local/a.txt', 'x', 'shift_jis', false)
    api.chooseApplication('/local/a.txt')
    api.startExternalEdit(target, '/a.txt', 'system-default')
    api.uploadExternalEdit('s1')
    api.discardExternalEdit('s1')
    api.revealExternalEdit('s1')
    api.listExternalSessions()
    api.loadSettings()
    api.saveSettings({ version: 1, theme: 'dark' })
    api.batchDeleteRemote(target, [{ path: '/a.txt', type: 'file' }])
    api.batchDeleteLocal([{ path: '/local/a.txt', type: 'file' }])
    api.batchDownload(target, ['/a.txt'], '/local/dir')
    api.batchUpload(target, ['/local/a.txt'], '/remote')
    api.paste({
      entries: [{ path: '/a.txt', name: 'a.txt', type: 'file' }],
      source: { kind: 'remote', target },
      destination: { kind: 'local', target: null, directory: '/local' },
    })
    api.openPreview({ source: 'remote', path: '/a.txt', name: 'a.txt', target })
    api.previewMetadata()
    api.loadPreview('shift_jis')

    expect(invokeMock).toHaveBeenCalledWith('storage:download', target, '/remote/a.csv', '/local/a.csv')
    expect(invokeMock).toHaveBeenCalledWith('storage:upload', target, '/local/a.csv', '/remote/a.csv')
    expect(invokeMock).toHaveBeenCalledWith('storage:read-text', target, '/remote/a.txt', undefined)
    expect(invokeMock).toHaveBeenCalledWith(
      'storage:write-text',
      target,
      '/remote/a.txt',
      'hello',
      undefined,
      undefined
    )
    expect(invokeMock).toHaveBeenCalledWith('storage:delete', target, '/remote/a.csv')
    expect(invokeMock).toHaveBeenCalledWith('storage:download-to-directory', target, '/remote/a.csv', '/local/dir')
    expect(invokeMock).toHaveBeenCalledWith('dialog:pick-directory')
    expect(invokeMock).toHaveBeenCalledWith('storage:create-directory', target, '/remote', 'new')
    expect(invokeMock).toHaveBeenCalledWith('storage:rename', target, '/remote/a.txt', 'b.txt', 'file')
    expect(invokeMock).toHaveBeenCalledWith('local:create-directory', '/local', 'new')
    expect(invokeMock).toHaveBeenCalledWith('local:rename', '/local/a.txt', 'b.txt', 'file')
    expect(invokeMock).toHaveBeenCalledWith('local:read-text', '/local/a.txt', 'shift_jis')
    expect(invokeMock).toHaveBeenCalledWith('local:write-text', '/local/a.txt', 'x', 'shift_jis', false)
    expect(invokeMock).toHaveBeenCalledWith('local:open-with', '/local/a.txt')
    expect(invokeMock).toHaveBeenCalledWith('external:open', target, '/a.txt', 'system-default')
    expect(invokeMock).toHaveBeenCalledWith('external:upload', 's1')
    expect(invokeMock).toHaveBeenCalledWith('external:discard', 's1')
    expect(invokeMock).toHaveBeenCalledWith('external:reveal', 's1')
    expect(invokeMock).toHaveBeenCalledWith('external:list')
    expect(invokeMock).toHaveBeenCalledWith('settings:load')
    expect(invokeMock).toHaveBeenCalledWith('settings:save', { version: 1, theme: 'dark' })
    expect(invokeMock).toHaveBeenCalledWith('storage:batch-delete', target, [{ path: '/a.txt', type: 'file' }])
    expect(invokeMock).toHaveBeenCalledWith('local:batch-delete', [{ path: '/local/a.txt', type: 'file' }])
    expect(invokeMock).toHaveBeenCalledWith('storage:batch-download', target, ['/a.txt'], '/local/dir')
    expect(invokeMock).toHaveBeenCalledWith('storage:batch-upload', target, ['/local/a.txt'], '/remote')
    expect(invokeMock).toHaveBeenCalledWith(
      'clipboard:paste',
      expect.objectContaining({ entries: expect.any(Array), source: expect.any(Object) })
    )
    // プレビュー: open は要求オブジェクト、load は encoding を invoke へ渡す。
    expect(invokeMock).toHaveBeenCalledWith('preview:open', {
      source: 'remote',
      path: '/a.txt',
      name: 'a.txt',
      target,
    })
    expect(invokeMock).toHaveBeenCalledWith('preview:metadata')
    expect(invokeMock).toHaveBeenCalledWith('preview:load', 'shift_jis')
  })

  it('onHistoryNavigation は購読/解除し、direction だけを listener へ渡す', async () => {
    await import('./index')
    const api = exposeMock.mock.calls[0][1] as Record<string, (...args: unknown[]) => unknown>

    const listener = vi.fn()
    const unsubscribe = api.onHistoryNavigation(listener) as () => void

    expect(onMock).toHaveBeenCalledWith('history:navigate', expect.any(Function))
    const handler = onMock.mock.calls[0][1] as (event: unknown, direction: string) => void
    // main から (event, direction) で届くが、renderer へは direction のみ渡す。
    handler({ sender: 'ipc' }, 'back')
    expect(listener).toHaveBeenCalledWith('back')

    unsubscribe()
    expect(removeListenerMock).toHaveBeenCalledWith('history:navigate', handler)
  })

  it('onHistoryNavigation は不正な direction を listener へ渡さない', async () => {
    await import('./index')
    const api = exposeMock.mock.calls[0][1] as Record<string, (...args: unknown[]) => unknown>
    const listener = vi.fn()
    api.onHistoryNavigation(listener)
    const handler = onMock.mock.calls[0][1] as (event: unknown, direction: unknown) => void

    handler({}, 'garbage')
    handler({}, 42)
    handler({}, undefined)
    expect(listener).not.toHaveBeenCalled()

    handler({}, 'forward')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith('forward')
  })
})
