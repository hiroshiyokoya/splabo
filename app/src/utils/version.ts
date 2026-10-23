/**
 * 版文字列の扱い(#569)。
 *
 * リポジトリ上の版は「次に出す版-dev」（例: `1.0.0-dev`・#898）で、リリース時に git タグから
 * 数値の版が注入される(#118 と同じ流儀)。開発ビルドはどれも同じ版を名乗るので、画面や保存画像から
 * 「どのコミットで動かしているのか」が分からない。開発ビルドのときだけ短縮コミットハッシュを添えて
 * 特定できるようにする。
 */

/** 開発ビルドの版に付く印。リリースビルドではタグ由来の数値の版が入るので付かない。 */
const DEV_SUFFIX = '-dev'

/**
 * 開発ビルドか。
 *
 * 🔴 判定は **`getVersion()` の生の値** に対して行うこと。`displayVersion()` の戻り値は
 * コミット ID が付いて `1.0.0-dev (a1b2c3d)` になるため、末尾で判定すると常に false になる。
 */
export function isDevVersion(version: string): boolean {
  return version.endsWith(DEV_SUFFIX)
}

/**
 * 画面・保存画像に出す版文字列。開発ビルドのときだけコミット ID を添える。
 *
 * リリースビルドは版がタグから注入されるので、そのまま返す。
 * コミット ID が取れなかったビルド（git が無い等）でも、素の版に落ちるだけで壊れない。
 */
export function displayVersion(version: string): string {
  if (!isDevVersion(version) || !__GIT_SHA__) return version
  return `${version} (${__GIT_SHA__})`
}

/**
 * この版のソースコードの場所（#534・AGPL のサイドカーのソースの案内）。
 *
 * リリースはそのバージョンのタグ、開発ビルドはコミット（取れなければ develop）を指す。
 */
export function sourceUrl(version: string): string {
  const base = 'https://github.com/hiroshiyokoya/splabo/tree/'
  if (version && !isDevVersion(version)) return `${base}splabo-v${version}`
  return `${base}${__GIT_SHA__ || 'develop'}`
}

/** 今より新しいリリース（#542・Rust の `update_check::check_for_update` が返す）。 */
export interface NewerRelease {
  /** 版（`1.0.1`） */
  version: string
  /** リリースのページ */
  url: string
}
