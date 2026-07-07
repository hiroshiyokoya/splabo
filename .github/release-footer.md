---

## ダウンロード

| OS | ファイル（下部 Assets 内） |
|---|---|
| Windows | splabo_VERSION_x64-setup.exe（推奨）または .msi（下記「更新時の注意」も参照） |
| macOS (Apple Silicon) | splabo_VERSION_aarch64.dmg |

## ⚠️ インストール時の警告について

本アプリは現在コード署名されていないため、OS の警告が表示される場合があります。

### Windows — SmartScreen 警告
「Windows によって PC が保護されました」と表示された場合：
**「詳細情報」→「実行」** をクリックしてください。

### Windows — 旧バージョン（v0.7 以前）から更新して「NSIS Error」が出た場合
統合に伴う内部識別子の変更により、**exe インストーラでの更新時に「Error launching installer」等の NSIS エラー**が表示されることがあります（この更新の初回のみ）。次のいずれかで回避してください:
- **`.msi` インストーラを使う**（最も簡単・おすすめ）
- または Windows の「設定 → アプリ」で旧「splabo」を先にアンインストールしてから exe を実行

いずれの方法でも設定・戦績・ギアのデータは保持されます（保存場所が別のため上書きされません）。次回以降の更新では発生しません。

### macOS — Gatekeeper ブロック
「壊れているため開けません」と表示された場合：
ターミナルで以下を実行してください。
```
xattr -cr /Applications/splabo.app
```

---

📄 [README](https://github.com/hiroshiyokoya/splabo/blob/splabo-vVERSION/README.md)

<br>

バグ報告・機能要望・感想など、フィードバックは[フィードバックフォーム](https://docs.google.com/forms/d/e/1FAIpQLSd2m8eNn4HwTjOY1PMnecJvSH95QCJxNi0Lyy1w4zxhIdndrQ/viewform)からお気軽にどうぞ（匿名可）。
