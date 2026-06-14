import React from 'react'
import ReactDOM from 'react-dom/client'

import { createDefaultSettings } from '../../shared/settings'
import { App } from './App'
import { applyAppearance } from './features/settings/appearance'
import './styles.css'

// マウント前に既定設定の外観を反映し、初回ペイントでの dark/light 混在フレームを避ける。
// 保存設定のロード完了後に SettingsProvider が正式値で再適用する。
applyAppearance(
  document.documentElement,
  createDefaultSettings(navigator.language),
  window.matchMedia('(prefers-color-scheme: dark)').matches
)

/**
 * React renderer のエントリポイント。
 * preload が公開した window.hedgeport API を使う UI を root へマウントする。
 */
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
