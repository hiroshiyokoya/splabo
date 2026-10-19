/**
 * 版文字列の扱い(#569)。
 *
 * リポジトリ上の版は常に `0.0.0-dev` で、リリース時に git タグから注入される(#118 と同じ流儀)。
 * つまり開発ビルドはどれも同じ版を名乗るので、画面や保存画像から「どのコミットで動かして
 * いるのか」が分からない。開発ビルドのときだけ短縮コミットハッシュを添えて特定できるようにする。
 */

/** 開発ビルドの版。リリースビルドではタグ由来の版が入るのでこの値にならない。 */
export const DEV_VERSION = '0.0.0-dev'

/**
 * 開発ビルドか。
 *
 * 🔴 判定は **`getVersion()` の生の値** に対して行うこと。`displayVersion()` の戻り値は
 * コミット ID が付いて `0.0.0-dev (a1b2c3d)` になるため、そのまま比較すると常に false になる。
 */
export function isDevVersion(version: string): boolean {
  return version === DEV_VERSION
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
