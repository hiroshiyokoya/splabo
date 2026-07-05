# geartoon TODO

## 直近でやったこと

- [x] ボトムシートUI全面改善（ギアカード横レイアウト・合計AP表示・ドラッグ開閉）
- [x] コーデ探索ロジック強化（AP プール制約・発動型/スタック型の上限連動）
- [x] STEP_VALUES を全達成可能値40種に修正
- [x] stepUp / stepDown が aAvail を考慮してスキップするよう修正
- [x] コンボ→コーデに用語統一
- [x] ボトムシートのカラーテーマをCSS変数で管理（A〜Dの4色）
- [x] ✕ボタン削除（ハンドル操作で開閉）
- [x] CLAUDE.md にbash禁止ルールを追加
- [x] Tauri 化（デスクトップアプリとしてパッケージング）— Issue #11, #32
- [x] Nintendo OAuth 認証フロー調査・Rust 実装（PKCE・session_token取得まで）— Issue #33, #20

---

## やること

### 認証・データ取得（最優先）

- [ ] **nxapi サイドカー実装**（Issue [#39](https://github.com/hiroshiyokoya/geartoon/issues/39)）  
  nxapi を `pkg` で単一実行ファイル化し、Tauri にバンドル。  
  stdin/stdout JSON IPC で Rust ↔ Node.js 通信。  
  Docker 依存を解消し、アプリ内から直接ギアデータを取得できるようにする。
- [ ] **アプリ内データ更新**（Issue [#12](https://github.com/hiroshiyokoya/geartoon/issues/12)）  
  サイドカー経由で SplatNet 3 から gear_db.json を更新する UI フロー。  
  ← #39 完了後に着手。

### セキュリティ

- [ ] **ローカル DB 暗号化**（Issue [#5](https://github.com/hiroshiyokoya/geartoon/issues/5)）  
  session_token / bulletToken を AES-256-GCM で暗号化してローカル保存。

### コーデ機能

- [ ] コーデ候補の表示改善（ギアカードをよりコンパクトに？候補数の上限UI）
- [ ] コーデをお気に入り保存する機能
- [ ] コーデ共有（画像エクスポートなど）

### ギア一覧

- [ ] ギアカードのデザイン調整（レアリティ表示など）
- [ ] EXP の視覚的なプログレス表示

### インフラ・環境

- [ ] GitHub Actions 自動ビルド（Issue [#22](https://github.com/hiroshiyokoya/geartoon/issues/22)）
- [ ] macOS / Linux での動作確認
- [ ] README スクリーンショット追加（Issue [#15](https://github.com/hiroshiyokoya/geartoon/issues/15)）
