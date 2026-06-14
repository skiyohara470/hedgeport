import { BrowserWindow, dialog, type IpcMainInvokeEvent, type OpenDialogOptions } from 'electron'

/**
 * 保存先ディレクトリ選択ダイアログを開く。
 * 呼び出し元 webContents の親ウィンドウへ attach した modal とし、キャンセル時は null を返す。
 *
 * @param event IPC invoke イベント（親ウィンドウ特定のため event.sender を使う）
 * @returns 選択されたディレクトリの絶対パス。キャンセル時は null
 */
export async function pickDirectory(event: IpcMainInvokeEvent): Promise<string | null> {
  const parent = BrowserWindow.fromWebContents(event.sender)
  const options: OpenDialogOptions = { properties: ['openDirectory', 'createDirectory'] }
  const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
}
