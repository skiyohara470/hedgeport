import React from 'react'
import ReactDOM from 'react-dom/client'

import { App } from './App'
import './styles.css'

/**
 * React renderer のエントリポイント。
 * preload が公開した window.hedgeport API を使う UI を root へマウントする。
 */
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
