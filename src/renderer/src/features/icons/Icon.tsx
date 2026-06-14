/** アプリ共通のアイコン名。 */
export type IconName =
  | 'columns'
  | 'eye'
  | 'connections'
  | 'plus'
  | 'close'
  | 'up'
  | 'refresh'
  | 'back'
  | 'forward'
  | 'folder'
  | 'file'
  | 'download'
  | 'upload'
  | 'copy'
  | 'paste'
  | 'trash'
  | 'folder-plus'
  | 'rename'
  | 'settings'

interface IconProps {
  name: IconName
}

/**
 * アプリ共通アイコン。見た目は name ごとの path 定義に寄せ、呼び出し側を簡潔にする。
 * @param props アイコン名
 */
export function Icon({ name }: IconProps) {
  const paths: Record<IconName, JSX.Element> = {
    columns: <path d="M4 5h16v14H4zM12 5v14" />,
    eye: <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Zm9.5 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />,
    connections: <path d="M9 7 4 12l5 5M4 12h12M15 4h5v16h-5" />,
    plus: <path d="M12 5v14M5 12h14" />,
    close: <path d="m7 7 10 10M17 7 7 17" />,
    up: <path d="m6 14 6-6 6 6" />,
    refresh: <path d="M20 6v5h-5M4 18v-5h5M18.5 9A7 7 0 0 0 6.2 6.2L4 9m16 6-2.2 2.8A7 7 0 0 1 5.5 15" />,
    back: <path d="m14 6-6 6 6 6M8 12h12" />,
    forward: <path d="m10 6 6 6-6 6M4 12h12" />,
    folder: <path d="M3 6.5h7l2 2h9v9.5H3z" />,
    file: <path d="M6 3h8l4 4v14H6zM14 3v5h5" />,
    download: <path d="M12 4v10m0 0 4-4m-4 4-4-4M5 19h14" />,
    upload: <path d="M12 20V10m0 0 4 4m-4-4-4 4M5 5h14" />,
    copy: <path d="M9 9h10v11H9zM5 15V4h10" />,
    paste: <path d="M9 4h6v3H9zM7 5H5v15h14V5h-2M9 12h6M9 16h6" />,
    trash: <path d="M5 7h14M10 7V4h4v3M6 7l1 13h10l1-13" />,
    'folder-plus': <path d="M3 6.5h7l2 2h9v9.5H3zM12 12v5M9.5 14.5h5" />,
    rename: <path d="m4 20 1-4L16 5l3 3L8 19zM14 7l3 3" />,
    settings: (
      <path d="M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm8 3a8 8 0 0 0-.1-1.3l2-1.5-2-3.4-2.3 1a8 8 0 0 0-2.2-1.3L14.8 2H9.2l-.4 2.5a8 8 0 0 0-2.2 1.3l-2.3-1-2 3.4 2 1.5A8 8 0 0 0 4 12c0 .4 0 .9.1 1.3l-2 1.5 2 3.4 2.3-1a8 8 0 0 0 2.2 1.3l.4 2.5h5.6l.4-2.5a8 8 0 0 0 2.2-1.3l2.3 1 2-3.4-2-1.5c.1-.4.1-.9.1-1.3Z" />
    ),
  }

  return (
    <svg className="button-icon" viewBox="0 0 24 24" aria-hidden="true">
      {paths[name]}
    </svg>
  )
}
