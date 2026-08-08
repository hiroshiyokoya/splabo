//! 表記のゆれを機械的に見張る（#604）。
//!
//! Splatoon では**ブキ**と表記する。アプリは長らく「武器」で通していたので、
//! 画面・ドキュメント・コメントまで一度に揃えた。
//!
//! ただし**後から書き足すときに元へ戻りやすい**。実際 #593 で足した所だけ
//! 「ブキ」になっていて（当時は周りが「武器」）、逆向きのゆれが生まれた。
//! 人の注意ではなくテストで見張る。
//!
//! # 対象にしないもの
//!
//! - **コードの識別子**（`weapon` / `WeaponRecord` 等）。英語なのでゆれない
//! - **リリース済みの CHANGELOG**。公開した記録は書き換えない

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    /// 探す語。見つかったら落とす。
    const BANNED: &str = "武器";

    /// リポジトリのルート（`app/src-tauri` の 2 つ上）。
    fn repo_root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .nth(2)
            .expect("リポジトリのルートが見つからない")
            .to_path_buf()
    }

    /// 見張る対象。ここに無いものは見ない（node_modules や生成物を避けるため列挙する）。
    const TARGET_DIRS: &[&str] = &["app/src", "app/src-tauri/src", "docs", "tools"];
    const TARGET_FILES: &[&str] = &["README.md"];

    /// 中身を見るファイルの拡張子。
    ///
    /// `txt` を含むのは `docs/llms.txt`（AI 向けのサイト説明）が漏れていたため。
    /// 拡張子で絞る以上、**新しい種類のファイルは自分で気付けない**。
    const EXTS: &[&str] = &["ts", "tsx", "rs", "html", "css", "md", "txt", "json"];

    /// 例外。**理由を書けないものは例外にしない。**
    fn is_exempt(rel: &str) -> bool {
        // 見張り役自身。探す語をソースに書くので必ず引っかかる。
        rel.ends_with("wording.rs")
            // リリース済みの記録。公開した文面を後から書き換えない。
            || rel.ends_with("CHANGELOG.md")
            // 生成物・依存。
            || rel.contains("node_modules")
            || rel.contains("/dist/")
            || rel.contains("/target/")
    }

    fn collect(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
                if name == "node_modules" || name == "dist" || name == "target" {
                    continue;
                }
                collect(&p, out);
            } else if p
                .extension()
                .and_then(|s| s.to_str())
                .is_some_and(|e| EXTS.contains(&e))
            {
                out.push(p);
            }
        }
    }

    /// 画面・ドキュメント・コメントに「武器」が残っていないか（#604）。
    ///
    /// 新しく書いた所だけ古い表記に戻る、という壊れ方をテストで止める。
    #[test]
    fn 表記はブキに統一されている() {
        let root = repo_root();
        let mut files = Vec::new();
        for d in TARGET_DIRS {
            collect(&root.join(d), &mut files);
        }
        for f in TARGET_FILES {
            files.push(root.join(f));
        }

        let mut hits: Vec<String> = Vec::new();
        for path in files {
            let rel = path
                .strip_prefix(&root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            if is_exempt(&rel) {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else { continue };
            for (i, line) in text.lines().enumerate() {
                if line.contains(BANNED) {
                    hits.push(format!("{rel}:{} {}", i + 1, line.trim()));
                }
            }
        }

        assert!(
            hits.is_empty(),
            "「{BANNED}」が {} 箇所残っている。Splatoon の表記は「ブキ」:\n{}",
            hits.len(),
            hits.join("\n"),
        );
    }

    /// 見張りが空振りしていないか（対象ファイルを 1 つも拾えていないと常に通ってしまう）。
    #[test]
    fn 見張る対象を実際に拾えている() {
        let root = repo_root();
        let mut files = Vec::new();
        for d in TARGET_DIRS {
            collect(&root.join(d), &mut files);
        }
        assert!(
            files.len() > 50,
            "対象ファイルが {} 件しか見つからない。パスの解決が壊れていないか",
            files.len()
        );
    }
}
