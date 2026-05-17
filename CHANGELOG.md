# Changelog

All notable changes to geartoon will be documented in this file.

## [Unreleased] — v1.1

### Added
- 設定画面を追加（アカウント管理・データ削除・Tips・About を統合）(#56)
- 設定画面でUI値をカスタマイズできるようにする (#65) ← WIP
- gear_db にスキル辞書を追加（アキ枠など全スキルの画像パスを動的解決）(#64)

### Fixed
- Windows で画像が表示されない問題を修正（gpng:// スキームが WebView2 でブロックされる問題を data URL バッチ変換で解決）(#62)
- 認証完了後にウィンドウをフォアグラウンドに戻すよう修正 (#47)

### Changed
- ギアカードをウィンドウ幅に応じて列数が増える固定サイズレイアウトに変更 (#56)
- 用語・表記を統一（「取得」「更新」「ログイン」等）(#53)
- app identifier を `com.geartoon.app` に変更（ユーザー名を除去）(#58)
- 開発版のバージョン表記を `0.0.0-dev` に変更 (#56)

### Infra
- リリース時に git タグから `tauri.conf.json` のバージョンを自動同期 (#59)

---

## [0.5.2] — 2026-05-16

### Added
- ギアデータ・画像を暗号化して保存（gear_db.bin / .gti 形式）(#50)
- GitHub Actions によるマルチプラットフォームリリースワークフロー (#22)
- データ更新に5分間のクールダウンを追加 (#19)

### Fixed
- nxapi をサイドカーとして同梱し、Docker 不要で動作するよう変更 (#39)

---

## [0.1.0-test] — 初期テストリリース

- Tauri アプリの骨格
- Nintendo OAuth (PKCE) 認証
- SplatNet3 からのギアデータ取得・表示
- フィルター・コーデ候補機能
