interface HedgePortApi {
  openPreview: () => void
  listLocal: (path?: string) => Promise<LocalDirectory>
}

interface LocalDirectory {
  path: string
  parentPath: string | null
  entries: LocalEntry[]
}

interface LocalEntry {
  name: string
  path: string
  type: 'file' | 'directory'
}

interface Window {
  hedgeport: HedgePortApi
}
