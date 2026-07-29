/// <reference types="vite/client" />

/** ビルド時に埋め込む短縮コミットハッシュ(#569)。`vite.config.ts` の `define` が与える。
 *  取得できなかったときは空文字。 */
declare const __GIT_SHA__: string
