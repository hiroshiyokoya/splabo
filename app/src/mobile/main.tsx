import React from 'react'
import ReactDOM from 'react-dom/client'
import '../i18n'
import '../App.css'
import './mobile.css'
import { MobileApp } from './MobileApp'
import { establishSession } from './session'
import { applyPcSettings } from './sharedSettings'

// スマホ Web 版の入口（#788・設計 #784 §2）。デスクトップの index.html / main.tsx とは別ページ。
// 描画の前に QR のトークンを Cookie に交換しておく（以後の /api・/img は Cookie で通る）。
// PC の表示設定（スタック型の順など）も描画の前に写しておく（#789）。
void establishSession().then(async session => {
  if (session !== 'rejected' && session !== 'unreachable') await applyPcSettings()
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
      <MobileApp session={session} />
    </React.StrictMode>,
  )
})
