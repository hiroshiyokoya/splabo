# nxapi-wrapper（nxapi サイドカー）

SpLabo が Nintendo アカウントの認証と SplatNet 3 の取得に使う、[nxapi](https://github.com/samuelthomas2774/nxapi) のサイドカーです。`wrapper.js` と nxapi・その依存を esbuild で 1 ファイルにまとめ、`@yao-pkg/pkg` で Node.js ランタイムごと単一の実行ファイル（`nxapi-sidecar-*`）にして、SpLabo のインストーラーに同梱しています。SpLabo 本体とは、コマンドライン引数と標準入出力だけでやり取りする別のプログラムです。

## ライセンス

**このディレクトリと、ここから作るサイドカーの実行ファイルは [GNU Affero General Public License v3.0 or later](LICENSE)（AGPL-3.0-or-later）です。** nxapi が AGPL-3.0-or-later で、サイドカーは nxapi とひとつにまとめて配っているためです。

SpLabo 本体（このリポジトリのほかの部分）は [MIT License](../../LICENSE) です。配布物に入る部品のライセンスの一覧は `app/public/third-party-licenses.txt`（アプリの「このアプリについて」→「ライセンス」からも見られます）にあります。

## 改変の告知（AGPL-3.0 §5(a)）

サイドカーに入っている nxapi は**改変版**です。`build.mjs` が、バンドルする前に `node_modules/nxapi` の次のファイルを書き換えます。

| ファイル | 変更 | 理由 | 初めて入れた日 |
|---|---|---|---|
| `dist/util/product.js` | top-level await を除き、`package.json`・Docker・git の情報をバナーで埋め込んだ値から読む | 単一ファイルにまとめると実行時にファイルを読めないため | 2026-05-19 |
| `dist/common/remote-config.js` | 遠隔設定を実行時に取りに行かず、ビルド時に取得して埋め込んだ値を使う | 同上（設定は `../nxapi-remote-config.json`。ビルド時の取得は 2026-08-10 から） | 2026-05-19 |
| `dist/api/f.js` | znca-api のエラーに HTTP ステータスを足し、`ErrorResponse` の構造を残す | 失敗の理由（一時障害か、認証切れか）を見分けるため | 2026-07-23 |

変更の中身は `build.mjs` の `patchNxapiFiles()` がそのまま正本です。最後に変更した日は `git log -- tools/nxapi-wrapper/build.mjs` で確かめられます。

## 対応するソース（AGPL-3.0 §6）

サイドカーの対応するソースは、このリポジトリのうち次のものです。各リリースのソースは、そのバージョンのタグ（例: `splabo-v0.12.0`）で入手できます。

- `wrapper.js`・`build.mjs`・`build.sh`・`build.bat`
- `package.json`・`package-lock.json`（使った nxapi とその依存の版）
- `../nxapi-remote-config.json`（ビルド時に埋め込んだ遠隔設定）

nxapi 本体のソースは npm の `nxapi`（`package-lock.json` に書かれた版）と、上流の <https://github.com/samuelthomas2774/nxapi> です。

## ビルド

```bash
npm ci
npm run build:win        # または build:mac-arm / build:mac-x64 / build:linux
```
