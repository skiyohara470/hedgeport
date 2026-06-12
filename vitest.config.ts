import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// 環境はテストファイル別に宣言する（ConnectionSelect は先頭で `// @vitest-environment jsdom`）。
// globals は使わず、各テストが vitest から describe/it/expect/vi を明示 import する。
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
  },
})
