import type { Language } from '../../../../shared/settings'

/**
 * 英語辞書を基準（型のソース）にする。日本語辞書は同じキーを必ず持つ。
 * 値中の `{name}` などのプレースホルダは translator が params で置換する。
 */
const en = {
  // 共通
  'common.cancel': 'Cancel',
  'common.save': 'Save',
  'common.close': 'Close',
  'common.delete': 'Delete',
  'common.tryAgain': 'Try again',
  // 接続選択 / 管理
  'connection.welcomeEyebrow': 'HedgePort',
  'connection.newTabEyebrow': 'New tab',
  'connection.choose': 'Choose a connection',
  'connection.chooseHint': 'Select the storage workspace to open.',
  'connection.add': 'Add connection',
  'connection.empty': 'No connections yet.',
  'connection.storedLocally': "Connections are stored locally in HedgePort's application data directory.",
  'connection.dragToReorder': 'Drag {name} to reorder',
  'connection.dragHint': 'Drag to reorder',
  'connection.edit': 'Edit {name}',
  'connection.deleteConfirm': 'Delete "{name}"? This cannot be undone.',
  'connection.couldNotReorder': 'Could not reorder connections.',
  'connection.couldNotLoad': 'Could not load connections.',
  // 設定
  'settings.title': 'Settings',
  'settings.open': 'Settings',
  'settings.appearance': 'Appearance',
  'settings.files': 'Files',
  'settings.theme': 'Theme',
  'settings.theme.system': 'System',
  'settings.theme.light': 'Light',
  'settings.theme.dark': 'Dark',
  'settings.language': 'Language',
  'settings.language.ja': '日本語',
  'settings.language.en': 'English',
  'settings.fontSize': 'Font size',
  'settings.fontSize.small': 'Small',
  'settings.fontSize.medium': 'Medium',
  'settings.fontSize.large': 'Large',
  'settings.density': 'Display density',
  'settings.density.compact': 'Compact',
  'settings.density.comfortable': 'Comfortable',
  'settings.showHiddenFiles': 'Show hidden files',
  'settings.confirmBeforeDelete': 'Confirm before delete',
  'settings.saving': 'Saving…',
  'settings.couldNotSave': 'Could not save settings.',
  'settings.couldNotLoad': 'Could not load settings. Using defaults.',
  // ワークスペース
  'workspace.showLocal': 'Show local files',
  'workspace.hideLocal': 'Hide local files',
  'workspace.disconnect': 'Disconnect',
  'workspace.loadingRemote': 'Loading remote files...',
  'workspace.loadingConnections': 'Loading connections...',
  'pane.back': 'Back',
  'pane.forward': 'Forward',
  'pane.parent': 'Parent directory',
  'pane.reload': 'Reload directory',
  'pane.searchFiles': 'Search files',
  'pane.emptyDir': 'This directory is empty.',
  'pane.noSearchMatch': 'No files match this search.',
  'pane.noBuckets': 'No buckets are accessible in this region.',
  'pane.couldNotList': 'Could not list this directory.',
  // ファイルアクション
  'action.open': 'Open',
  'action.openWith': 'Open…',
  'action.openWithMenu': 'Open with…',
  'action.downloadLocal': 'Download to Local',
  'action.downloadLocalN': 'Download {count} files to Local',
  'action.downloadDialog': 'Download file…',
  'action.downloadDialogN': 'Download {count} files…',
  'action.upload': 'Upload file',
  'action.uploadN': 'Upload {count} files',
  'action.copy': 'Copy',
  'action.copyN': 'Copy {count} files',
  'action.paste': 'Paste',
  'action.rename': 'Rename…',
  'action.copyPath': 'Copy path',
  'action.copyPaths': 'Copy paths',
  'action.deleteOne': 'Delete',
  'action.deleteN': 'Delete {count} items',
  'action.newFolder': 'New Folder…',
  'action.revealIn': 'Show in {manager}',
  'action.openFolderIn': 'Open Folder in {manager}',
  // プレビュー画面
  'preview.eyebrow': 'File preview',
  'preview.noFile': 'No file selected',
  'preview.futureBadge': 'Future: diff view',
  'preview.hint1': 'Select a file in a workspace to display its contents here.',
  'preview.hint2': 'File reads and preview data are not connected in this phase.',
  // 確認
  'confirm.deleteEntries': 'Delete {summary}? This cannot be undone.',
} as const

/** 翻訳キー（英語辞書のキー集合）。 */
export type TranslationKey = keyof typeof en

/** プレースホルダ置換用のパラメータ。 */
export type TranslationParams = Record<string, string | number>

/** 翻訳関数。 */
export type Translator = (key: TranslationKey, params?: TranslationParams) => string

const ja: Record<TranslationKey, string> = {
  'common.cancel': 'キャンセル',
  'common.save': '保存',
  'common.close': '閉じる',
  'common.delete': '削除',
  'common.tryAgain': '再試行',
  'connection.welcomeEyebrow': 'HedgePort',
  'connection.newTabEyebrow': '新しいタブ',
  'connection.choose': '接続を選択',
  'connection.chooseHint': '開くストレージワークスペースを選択します。',
  'connection.add': '接続を追加',
  'connection.empty': '接続がまだありません。',
  'connection.storedLocally': '接続情報は HedgePort のアプリデータ領域にローカル保存されます。',
  'connection.dragToReorder': '{name} をドラッグして並び替え',
  'connection.dragHint': 'ドラッグして並び替え',
  'connection.edit': '{name} を編集',
  'connection.deleteConfirm': '「{name}」を削除しますか？この操作は元に戻せません。',
  'connection.couldNotReorder': '接続の並び替えを保存できませんでした。',
  'connection.couldNotLoad': '接続情報を読み込めませんでした。',
  'settings.title': '設定',
  'settings.open': '設定',
  'settings.appearance': '外観',
  'settings.files': 'ファイル',
  'settings.theme': 'テーマ',
  'settings.theme.system': 'システム',
  'settings.theme.light': 'ライト',
  'settings.theme.dark': 'ダーク',
  'settings.language': '表示言語',
  'settings.language.ja': '日本語',
  'settings.language.en': 'English',
  'settings.fontSize': '文字サイズ',
  'settings.fontSize.small': '小',
  'settings.fontSize.medium': '中',
  'settings.fontSize.large': '大',
  'settings.density': '表示密度',
  'settings.density.compact': 'コンパクト',
  'settings.density.comfortable': '標準',
  'settings.showHiddenFiles': '隠しファイルを表示',
  'settings.confirmBeforeDelete': '削除前に確認する',
  'settings.saving': '保存中…',
  'settings.couldNotSave': '設定を保存できませんでした。',
  'settings.couldNotLoad': '設定を読み込めませんでした。既定値を使用します。',
  'workspace.showLocal': 'ローカルファイルを表示',
  'workspace.hideLocal': 'ローカルファイルを隠す',
  'workspace.disconnect': '切断',
  'workspace.loadingRemote': 'リモートファイルを読み込み中...',
  'workspace.loadingConnections': '接続情報を読み込み中...',
  'pane.back': '戻る',
  'pane.forward': '進む',
  'pane.parent': '親ディレクトリ',
  'pane.reload': 'ディレクトリを再読み込み',
  'pane.searchFiles': 'ファイルを検索',
  'pane.emptyDir': 'このディレクトリは空です。',
  'pane.noSearchMatch': '検索条件に一致するファイルはありません。',
  'pane.noBuckets': 'このリージョンでアクセスできるバケットがありません。',
  'pane.couldNotList': 'このディレクトリを一覧できませんでした。',
  'action.open': '開く',
  'action.openWith': '開く…',
  'action.openWithMenu': '開き方…',
  'action.downloadLocal': 'ローカルへダウンロード',
  'action.downloadLocalN': '{count} 件をローカルへダウンロード',
  'action.downloadDialog': 'ファイルをダウンロード…',
  'action.downloadDialogN': '{count} 件をダウンロード…',
  'action.upload': 'ファイルをアップロード',
  'action.uploadN': '{count} 件をアップロード',
  'action.copy': 'コピー',
  'action.copyN': '{count} 件をコピー',
  'action.paste': '貼り付け',
  'action.rename': '名前を変更…',
  'action.copyPath': 'パスをコピー',
  'action.copyPaths': 'パスをコピー',
  'action.deleteOne': '削除',
  'action.deleteN': '{count} 件を削除',
  'action.newFolder': '新規フォルダ…',
  'action.revealIn': '{manager} で表示',
  'action.openFolderIn': '{manager} でフォルダを開く',
  'preview.eyebrow': 'ファイルプレビュー',
  'preview.noFile': 'ファイルが選択されていません',
  'preview.futureBadge': '将来: 差分表示',
  'preview.hint1': 'ワークスペースでファイルを選択すると、ここに内容が表示されます。',
  'preview.hint2': 'この段階ではファイル読み込みとプレビューは接続されていません。',
  'confirm.deleteEntries': '{summary} を削除しますか？この操作は元に戻せません。',
}

const dictionaries: Record<Language, Record<TranslationKey, string>> = { en, ja }

/**
 * 指定言語の翻訳関数を作る純関数。
 * `{name}` 形式のプレースホルダを params で置換する。未知キーはキー文字列をそのまま返す。
 *
 * @param language 表示言語
 * @returns Translator
 */
export function createTranslator(language: Language): Translator {
  const dictionary = dictionaries[language] ?? en
  return (key, params) => {
    const template = dictionary[key] ?? en[key] ?? key
    if (!params) return template
    return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match))
  }
}
