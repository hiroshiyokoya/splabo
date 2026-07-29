import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

/**
 * 開発ビルドの版表示に添えるコミット ID(#569)。
 *
 * 開発ビルドの版は常に `0.0.0-dev` 固定なので、どのコミットで動かしているのかが
 * 画面からも保存画像のクレジットからも分からない。短縮ハッシュを埋めて特定できるようにする。
 *
 * 🔴 **値は vite の起動時に確定する。** dev サーバーを動かしたまま新しいコミットを
 * 積んでも表示は変わらない(再起動するまで前のまま)。埋め込み方式である以上避けられない。
 *
 * 取れなければ空文字。呼び出し側(`displayVersion`)が素の版に落とすので壊れない。
 */
function gitShortSha(): string {
  return shaFromGitCommand() || shaFromGitDir();
}

/** `git` が使えるならこれが一番正確(worktree・submodule も git が解決する)。 */
function shaFromGitCommand(): string {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

/**
 * `git` が PATH に無い環境向けのフォールバック。`.git` を直接読む。
 *
 * CI コンテナや、Git for Windows を入れていても PATH に載っていないシェルから
 * ビルドされることがある。そこで黙ってコミット ID が消えるのを避ける。
 */
function shaFromGitDir(): string {
  try {
    // @ts-expect-error process is a nodejs global
    let dir: string = process.cwd();
    // app/ から起動されることも、リポジトリルートから起動されることもあるので上へ辿る。
    for (let i = 0; i < 6; i++) {
      const gitPath = join(dir, ".git");
      if (existsSync(gitPath)) return readHeadSha(gitPath);
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* 読めなければ諦める */
  }
  return "";
}

/** `.git`(ディレクトリ or worktree の gitdir ファイル)から HEAD のコミットを引く。 */
function readHeadSha(gitPath: string): string {
  let gitDir = gitPath;
  if (statSync(gitPath).isFile()) {
    // worktree / submodule では `.git` が `gitdir: <path>` の 1 行ファイルになる。
    const m = readFileSync(gitPath, "utf8").match(/^gitdir:\s*(.+)$/m);
    if (!m) return "";
    gitDir = resolve(dirname(gitPath), m[1].trim());
  }
  const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
  const ref = head.match(/^ref:\s*(.+)$/);
  if (!ref) return head.slice(0, 7); // detached HEAD は HEAD 自体がコミット

  const refName = ref[1].trim();
  const loose = join(gitDir, refName);
  if (existsSync(loose)) return readFileSync(loose, "utf8").trim().slice(0, 7);

  // gc 後などは refs が packed-refs にまとめられている。
  const packed = join(gitDir, "packed-refs");
  if (existsSync(packed)) {
    for (const line of readFileSync(packed, "utf8").split("\n")) {
      if (!line || line.startsWith("#") || line.startsWith("^")) continue;
      const [sha, name] = line.trim().split(/\s+/);
      if (name === refName) return sha.slice(0, 7);
    }
  }
  return "";
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  define: {
    __GIT_SHA__: JSON.stringify(gitShortSha()),
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
