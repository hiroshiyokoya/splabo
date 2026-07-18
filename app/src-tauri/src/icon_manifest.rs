//! バトルアイコン（ブキ / サブ / スペシャル / ステージ / ギアパワー）の同期マニフェスト
//! （#327・#360・設計書 §6）。
//!
//! viewer のバトル行アイコン表示用に、デスクトップのキャッシュ画像を**同期ペイロードで供給**する。
//! アプリバイナリには任天堂資産を一切含めない（設計書 §6「バイナリはクリーン維持」）。画像は
//! あくまでユーザー自身のデスクトップが任天堂から取得したキャッシュ ＝ ユーザーのデータ、という
//! 既存ギア画像と同じ建て付けを踏襲する。
//!
//! ## 差分配信（設計書 §6「ハッシュ / 更新時刻を比べ、変わったものだけ転送」）
//! - `GET /icons/manifest` が `{kind, name_hash, path, hash, size, modified_at}` の一覧を返す。
//! - viewer は手元の `hash` と突き合わせ、**差分（新規 / hash 変化）だけ** `GET /images/...` する。
//! - 取りこぼし対策として画像配信側も ETag（= 同じ `hash`）に対応。`If-None-Match` 一致なら 304。
//!
//! ## 画像キャッシュの置き場所（2 系統あるので注意）
//! - **バトル系（本モジュールの対象）**: `app_data_dir()/images/<kind>/<sha256(name)>.gti`
//!   （`images.rs` が書く。`kind` は weapon / sub_weapon / special_weapon / stage / ability）
//! - **ギア系（#324 で既に配信済み）**: `app_data_dir()/data/images/{gear,brand,skill}/...`
//!   （`gear.rs` が書く。ファイル名は URL 由来でハッシュではない）
//!
//! 両者はディレクトリ名が重ならないため、`/images/<先頭セグメント>` で振り分けられる。
//!
//! ## ギアパワーアイコンの網羅性について（#360 調査結果）
//! マニフェストに載るのは **実際にキャッシュ済みのファイルだけ**。ギアパワーは
//! `splatnet3.rs::cache_ability_images` が「保存済みバトルに登場したもの」だけをキャッシュするため、
//! `abilities.rs::ABILITY_HASHES` の全 26 種 + `empty` が最初から揃うとは限らない。
//!
//! 登場に依存しない先回りキャッシュ（全種一括取得）は **現状の情報では実装できない**。
//! 実データ（`battles.my_team` JSON）の画像 URL は
//! `https://api.lp1.av5ja.srv.nintendo.net/resources/prod/v3/skill_img/<hash>_0.png`
//! に `?Expires=...&Signature=...&Key-Pair-Id=...` が付いた **CloudFront の署名付き URL** で、
//! 署名はレスポンス由来。クライアント側でハッシュから URL を組み立てても署名が無く取得できない。
//! 未署名で配信されるか / 署名を生成できるかが確認できれば実装可能（別途調査）。
//!
//! ## ルールアイコンについて（#327 調査結果）
//! **ルール（ナワバリ / エリア / ヤグラ / ホコ / アサリ）のアイコンは供給元が存在しない。**
//! - `images.rs` がキャッシュする kind に `rule` は無い（`splatnet3.rs` の `collect_image_targets`）。
//! - SplatNet3 のレスポンスからは `/vsRule/rule`（enum 文字列）しか読んでおらず画像 URL を取得していない。
//! - `db.rs` の `rule` テーブルは `id` / `key` のみで画像カラムを持たない（weapon / ability は `image_key` あり）。
//! - フロントエンドもルールはテキスト表示（`types.ts` の `RULE_LABELS`）。
//!
//! よって本モジュールはルールアイコンを扱わない。viewer 側（#35）はルールのみテキスト /
//! プレースホルダで表示すること。供給するには任天堂由来の画像 URL を新たに見つけて
//! `images.rs` に `rule` kind を足す前段の作業が要る（別イシュー）。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};

/// マニフェストの契約名（viewer #35 と対）。gear-export-v1 / battle-export-v1 と同じ流儀。
pub const SCHEMA: &str = "icon-manifest-v1";
pub const SCHEMA_VERSION: i64 = 1;

/// マニフェストに載せるバトルアイコンの kind（`images.rs` の kind と一致させる）。
///
/// `ability`（ギアパワー / スキル）は #360 で追加。`splatnet3.rs::cache_ability_images` が
/// `app_data_dir()/images/ability/<sha256(stat.ink キー)>.gti` に書いており、配信側
/// （`companion.rs::resolve_image_path`）も元から許可済みだったが、マニフェストに
/// 載っていなかったため viewer から**発見・差分同期できなかった**。
/// `name_hash` は他の kind と同じく `sha256(名前)` で、ここでの「名前」は
/// stat.ink のアビリティキー（`ink_saver_main` 等・空スロットは `empty`）。
///
/// **`rule` は供給元が無いため存在しない**（モジュール冒頭の調査結果参照）。
pub const BATTLE_ICON_KINDS: [&str; 5] =
    ["weapon", "sub_weapon", "special_weapon", "stage", "ability"];

/// マニフェスト 1 件（= キャッシュ画像 1 ファイル）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct IconEntry {
    /// weapon / sub_weapon / special_weapon / stage / ability。
    pub kind: String,
    /// ファイル名から拡張子を除いたもの ＝ `sha256(name)` の hex。
    /// viewer は battle_db の `weapon_name` / `stage_name` を sha256 して突き合わせる。
    /// `ability` のみ「名前」は stat.ink キー（`ink_saver_main` / `empty` 等）。
    pub name_hash: String,
    /// `GET /images/<kind>/<name_hash>.gti` でそのまま引ける相対パス。
    pub path: String,
    /// ファイル内容の sha256 hex。**差分判定の主キー**（ETag と同値）。
    pub hash: String,
    /// バイト数（viewer の進捗表示用）。
    pub size: u64,
    /// 更新時刻（UNIX 秒）。取得不能なら null。差分判定は `hash` が主で、これは補助。
    pub modified_at: Option<i64>,
}

/// `GET /icons/manifest` のレスポンス。
#[derive(Debug, Clone, Serialize)]
pub struct IconManifest {
    pub schema: &'static str,
    pub version: i64,
    /// 生成時刻（UTC ISO8601）。
    pub generated_at: String,
    /// kind 昇順 → name_hash 昇順で安定ソート済み（差分比較の再現性のため）。
    pub icons: Vec<IconEntry>,
}

/// バイト列の sha256 hex。差分判定 / ETag の共通ハッシュ。
pub fn hash_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// `If-None-Match` ヘッダ値と ETag の一致判定（純粋関数・テスト対象）。
///
/// tiny_http は生ヘッダを渡すため、クォート有無の両方を許容する（`"abc"` / `abc`）。
/// `*` は「何かあれば 304」の意味なので一致扱い。複数値（カンマ区切り）にも対応する。
pub fn etag_matches(if_none_match: Option<&str>, etag: &str) -> bool {
    let Some(header) = if_none_match else {
        return false;
    };
    header.split(',').any(|candidate| {
        let c = candidate.trim();
        let c = c.strip_prefix("W/").unwrap_or(c);
        let c = c.trim_matches('"');
        c == "*" || c == etag
    })
}

/// アイコンキャッシュのルート（`app_data_dir()/images`）を走査してマニフェストを組む。
///
/// - 対象は `BATTLE_ICON_KINDS` の各サブディレクトリ直下の `.gti` のみ。
/// - ディレクトリ不在（未キャッシュ）は**エラーにせず空**として扱う（起動直後は普通にありうる）。
/// - 読めなかったファイルは黙って飛ばす（ベストエフォート。1 枚の破損で同期全体を落とさない）。
pub fn build_manifest(images_root: &Path, generated_at: String) -> IconManifest {
    let mut icons = Vec::new();

    for kind in BATTLE_ICON_KINDS {
        let dir = images_root.join(kind);
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue; // 未キャッシュ kind は空扱い
        };
        // read_dir の順序は OS 依存なので、後で明示ソートする。
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("gti") {
                continue;
            }
            let Some(name_hash) = path.file_stem().and_then(|s| s.to_str()).map(str::to_owned) else {
                continue;
            };
            let Ok(bytes) = std::fs::read(&path) else {
                log::warn!("[icon-manifest] 読み取り失敗のためスキップ: {}", path.display());
                continue;
            };
            let modified_at = entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64);

            icons.push(IconEntry {
                kind: kind.to_string(),
                path: format!("images/{kind}/{name_hash}.gti"),
                hash: hash_bytes(&bytes),
                size: bytes.len() as u64,
                modified_at,
                name_hash,
            });
        }
    }

    // 安定ソート（viewer 側の差分比較・テストの再現性のため）。
    icons.sort_by(|a, b| (&a.kind, &a.name_hash).cmp(&(&b.kind, &b.name_hash)));

    IconManifest {
        schema: SCHEMA,
        version: SCHEMA_VERSION,
        generated_at,
        icons,
    }
}

/// viewer が持つ `path -> hash` と現行マニフェストを突き合わせ、**取り直すべき path** を返す。
///
/// サーバー実装では使わない（差分判断は viewer 側が行う）が、**契約そのものをテストで固定**するために
/// 参照実装として置く。viewer #35 はこれと同じ規則で実装すること:
/// - viewer が知らない path → 取得
/// - hash が違う path → 取得
/// - hash が同じ path → **取得しない**
/// - viewer にだけあってマニフェストに無い path → 破棄対象（戻り値には含めない）
pub fn changed_paths(manifest: &IconManifest, known: &BTreeMap<String, String>) -> Vec<String> {
    manifest
        .icons
        .iter()
        .filter(|icon| known.get(&icon.path) != Some(&icon.hash))
        .map(|icon| icon.path.clone())
        .collect()
}

/// マニフェストに無くなった（viewer 側で不要になった）path を返す。
pub fn stale_paths(manifest: &IconManifest, known: &BTreeMap<String, String>) -> Vec<String> {
    let current: std::collections::HashSet<&str> =
        manifest.icons.iter().map(|i| i.path.as_str()).collect();
    known
        .keys()
        .filter(|p| !current.contains(p.as_str()))
        .cloned()
        .collect()
}

/// `app_data_dir()/images`（バトルアイコンのキャッシュルート）を解決する。
///
/// `companion.rs` の `resolve_data_dir`（`app_data_dir()/data`）とは**別物**なので注意。
/// こちらは `images.rs` の `image_path` と同じ場所を指す。作成はしない（無ければ空マニフェスト）。
pub fn resolve_images_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| format!("アプリデータディレクトリ解決失敗: {e}"))?
        .join("images"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// 一意な一時ディレクトリを作る（migration.rs / gear.rs のテスト流儀に合わせ tempfile 非依存）。
    fn temp_root(tag: &str) -> PathBuf {
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "splabo_icon_manifest_test_{}_{}_{}",
            std::process::id(),
            tag,
            n
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_icon(root: &Path, kind: &str, name_hash: &str, content: &[u8]) {
        let dir = root.join(kind);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(format!("{name_hash}.gti")), content).unwrap();
    }

    fn manifest_of(root: &Path) -> IconManifest {
        build_manifest(root, "2026-07-16T12:00:00Z".to_string())
    }

    // --- ハッシュ ---

    #[test]
    fn hashes_are_stable_and_content_sensitive() {
        // 同じ内容なら毎回同じ（差分判定が安定する前提）。
        assert_eq!(hash_bytes(b"IMG-A"), hash_bytes(b"IMG-A"));
        // 1 バイトでも違えば別ハッシュ（変更検出できる前提）。
        assert_ne!(hash_bytes(b"IMG-A"), hash_bytes(b"IMG-B"));
        // sha256 hex は 64 文字。
        assert_eq!(hash_bytes(b"IMG-A").len(), 64);
    }

    // --- マニフェスト生成 ---

    #[test]
    fn builds_manifest_from_cache() {
        let root = temp_root("build");
        write_icon(&root, "weapon", "aaa", b"WEAPON-A");
        write_icon(&root, "stage", "bbb", b"STAGE-B");

        let m = manifest_of(&root);
        assert_eq!(m.schema, "icon-manifest-v1");
        assert_eq!(m.version, 1);
        assert_eq!(m.icons.len(), 2);

        // kind 昇順（stage < weapon）で安定ソートされる。
        assert_eq!(m.icons[0].kind, "stage");
        assert_eq!(m.icons[0].name_hash, "bbb");
        assert_eq!(m.icons[0].path, "images/stage/bbb.gti");
        assert_eq!(m.icons[0].hash, hash_bytes(b"STAGE-B"));
        assert_eq!(m.icons[0].size, 7);
        assert!(m.icons[0].modified_at.is_some());

        assert_eq!(m.icons[1].kind, "weapon");
        assert_eq!(m.icons[1].path, "images/weapon/aaa.gti");
    }

    #[test]
    fn manifest_is_deterministic() {
        let root = temp_root("deterministic");
        write_icon(&root, "weapon", "ccc", b"C");
        write_icon(&root, "weapon", "aaa", b"A");
        write_icon(&root, "weapon", "bbb", b"B");

        let first: Vec<String> = manifest_of(&root).icons.iter().map(|i| i.path.clone()).collect();
        let second: Vec<String> = manifest_of(&root).icons.iter().map(|i| i.path.clone()).collect();
        assert_eq!(first, second);
        assert_eq!(
            first,
            vec![
                "images/weapon/aaa.gti",
                "images/weapon/bbb.gti",
                "images/weapon/ccc.gti"
            ]
        );
    }

    #[test]
    fn missing_cache_dir_yields_empty_manifest() {
        // 起動直後 / 未フェッチでもエラーにせず空を返す。
        let root = temp_root("empty");
        let m = manifest_of(&root);
        assert!(m.icons.is_empty());
        assert_eq!(m.schema, "icon-manifest-v1");
    }

    #[test]
    fn ignores_non_gti_and_unknown_kinds() {
        let root = temp_root("filter");
        write_icon(&root, "weapon", "aaa", b"A");
        // .png（scramble 前の残骸）や一時ファイルは載せない。
        fs::write(root.join("weapon").join("raw.png"), b"PNG").unwrap();
        // gear 系や未知の kind は本マニフェストの対象外（別経路で配信済み）。
        // ※ `skill` は gear.rs 側のギア画像（`data/images/skill`）で、ここの `ability` とは別物。
        write_icon(&root, "gear", "ggg", b"G");
        write_icon(&root, "brand", "bbb", b"B");
        write_icon(&root, "skill", "sss", b"S");
        // ルールアイコンは供給元が無いので、仮に置かれても kind 一覧に無く載らない。
        write_icon(&root, "rule", "rrr", b"R");

        let m = manifest_of(&root);
        assert_eq!(m.icons.len(), 1);
        assert_eq!(m.icons[0].path, "images/weapon/aaa.gti");
    }

    #[test]
    fn rule_is_not_a_supplied_kind() {
        // #327 調査結果の回帰テスト: ルールアイコンは供給元が無いため kind に含めない。
        assert!(!BATTLE_ICON_KINDS.contains(&"rule"));
        assert_eq!(BATTLE_ICON_KINDS.len(), 5);
    }

    // --- ギアパワー（ability）#360 ---

    #[test]
    fn ability_is_a_supplied_kind() {
        // #360: `images.rs` が `ability` kind を書いており配信側も許可済みなので、
        // マニフェストにも載せて viewer が発見できるようにする。
        assert!(BATTLE_ICON_KINDS.contains(&"ability"));
    }

    #[test]
    fn includes_ability_icons_in_manifest() {
        let root = temp_root("ability");
        // ability のファイル名は sha256(stat.ink キー)。実際の書き手（images.rs）と同じ規則。
        let key_hash = hash_bytes(b"ink_saver_main");
        let empty_hash = hash_bytes(b"empty");
        write_icon(&root, "ability", &key_hash, b"ABILITY-A");
        write_icon(&root, "ability", &empty_hash, b"ABILITY-EMPTY");
        write_icon(&root, "weapon", "aaa", b"W");

        let m = manifest_of(&root);
        let abilities: Vec<&IconEntry> = m.icons.iter().filter(|i| i.kind == "ability").collect();
        assert_eq!(abilities.len(), 2);

        // kind 昇順（ability < weapon）＋ name_hash 昇順で安定ソートされる。
        assert_eq!(m.icons[0].kind, "ability");
        assert_eq!(m.icons.last().unwrap().kind, "weapon");

        // 他 kind と同じ経路・同じ形（ability 専用の特別扱いを増やさない）。
        let entry = abilities
            .iter()
            .find(|i| i.name_hash == key_hash)
            .expect("ink_saver_main のエントリが載ること");
        assert_eq!(entry.path, format!("images/ability/{key_hash}.gti"));
        assert_eq!(entry.hash, hash_bytes(b"ABILITY-A"));
        assert_eq!(entry.size, 9);
        assert!(entry.modified_at.is_some());

        // 空スロット（`empty`）も 1 種として供給される。
        assert!(abilities.iter().any(|i| i.name_hash == empty_hash));
    }

    #[test]
    fn ability_names_come_from_statink_keys() {
        // viewer は stat.ink キーを sha256 して突き合わせる、という契約の固定。
        // `abilities.rs` の canonical な全種が同じ規則で引けること（キャッシュ済みなら載る）。
        let root = temp_root("ability_keys");
        let keys: Vec<&str> = crate::abilities::ABILITY_HASHES
            .iter()
            .map(|(_, key)| key.unwrap_or(crate::abilities::EMPTY_SLOT_KEY))
            .collect();
        for key in &keys {
            write_icon(&root, "ability", &hash_bytes(key.as_bytes()), b"IMG");
        }

        let m = manifest_of(&root);
        // 26 種 + 空スロット = 27 エントリ。
        assert_eq!(m.icons.len(), keys.len());
        for key in &keys {
            let path = format!("images/ability/{}.gti", hash_bytes(key.as_bytes()));
            assert!(
                m.icons.iter().any(|i| i.path == path),
                "{key} のエントリが見つからない"
            );
        }
    }

    #[test]
    fn missing_ability_cache_does_not_break_manifest() {
        // ギアパワーが 1 件もキャッシュされていない環境（初回起動 / バトル未取得）でも、
        // 他 kind のマニフェスト生成が壊れない（例外にせず ability を単に空扱いにする）。
        let root = temp_root("ability_absent");
        write_icon(&root, "weapon", "aaa", b"W");

        let m = manifest_of(&root);
        assert_eq!(m.schema, "icon-manifest-v1");
        assert_eq!(m.icons.len(), 1);
        assert!(!m.icons.iter().any(|i| i.kind == "ability"));
    }

    // --- 差分検出（設計書 §6「変わったものだけ転送」） ---

    #[test]
    fn detects_new_icons_as_changed() {
        let root = temp_root("diff_new");
        write_icon(&root, "weapon", "aaa", b"A");
        let m = manifest_of(&root);

        // viewer が何も持っていなければ全件が対象。
        let known = BTreeMap::new();
        assert_eq!(changed_paths(&m, &known), vec!["images/weapon/aaa.gti"]);
    }

    #[test]
    fn skips_unchanged_icons() {
        let root = temp_root("diff_same");
        write_icon(&root, "weapon", "aaa", b"A");
        write_icon(&root, "stage", "sss", b"S");
        let m = manifest_of(&root);

        // viewer が同じ hash を持っていれば 1 件も転送しない。
        let known: BTreeMap<String, String> = m
            .icons
            .iter()
            .map(|i| (i.path.clone(), i.hash.clone()))
            .collect();
        assert!(changed_paths(&m, &known).is_empty());
    }

    #[test]
    fn detects_changed_content_by_hash() {
        let root = temp_root("diff_changed");
        write_icon(&root, "weapon", "aaa", b"A");
        write_icon(&root, "stage", "sss", b"S");
        let before = manifest_of(&root);
        let known: BTreeMap<String, String> = before
            .icons
            .iter()
            .map(|i| (i.path.clone(), i.hash.clone()))
            .collect();

        // 任天堂側の差し替え等で weapon 画像だけ中身が変わった状況。
        write_icon(&root, "weapon", "aaa", b"A-UPDATED");
        let after = manifest_of(&root);

        // 変わった 1 件だけが対象（stage は据え置き ＝ 再転送しない）。
        assert_eq!(changed_paths(&after, &known), vec!["images/weapon/aaa.gti"]);
    }

    #[test]
    fn detects_stale_icons_removed_from_cache() {
        let root = temp_root("diff_stale");
        write_icon(&root, "weapon", "aaa", b"A");
        let m = manifest_of(&root);

        let mut known: BTreeMap<String, String> = m
            .icons
            .iter()
            .map(|i| (i.path.clone(), i.hash.clone()))
            .collect();
        // viewer にだけ残っている古いアイコン。
        known.insert("images/weapon/gone.gti".to_string(), "deadbeef".to_string());

        // 取り直し対象ではない（＝転送しない）。
        assert!(changed_paths(&m, &known).is_empty());
        // 破棄対象として報告される。
        assert_eq!(stale_paths(&m, &known), vec!["images/weapon/gone.gti"]);
    }

    // --- ETag（取りこぼし対策の 304） ---

    #[test]
    fn etag_matches_quoted_and_bare() {
        assert!(etag_matches(Some("\"abc123\""), "abc123"));
        assert!(etag_matches(Some("abc123"), "abc123"));
        assert!(etag_matches(Some("W/\"abc123\""), "abc123"));
        // 複数候補のいずれかに一致すれば 304。
        assert!(etag_matches(Some("\"zzz\", \"abc123\""), "abc123"));
        // ワイルドカード。
        assert!(etag_matches(Some("*"), "abc123"));
    }

    #[test]
    fn etag_mismatch_or_absent_transfers() {
        assert!(!etag_matches(Some("\"other\""), "abc123"));
        assert!(!etag_matches(None, "abc123"));
        assert!(!etag_matches(Some(""), "abc123"));
    }

    // --- JSON 形（viewer #35 が読む契約） ---

    #[test]
    fn serializes_manifest_shape() {
        let root = temp_root("json");
        write_icon(&root, "weapon", "aaa", b"A");
        let m = manifest_of(&root);
        let json = serde_json::to_value(&m).unwrap();

        assert_eq!(json["schema"], "icon-manifest-v1");
        assert_eq!(json["version"], 1);
        assert_eq!(json["generated_at"], "2026-07-16T12:00:00Z");
        let icon = &json["icons"][0];
        assert_eq!(icon["kind"], "weapon");
        assert_eq!(icon["name_hash"], "aaa");
        assert_eq!(icon["path"], "images/weapon/aaa.gti");
        assert_eq!(icon["hash"], hash_bytes(b"A"));
        assert_eq!(icon["size"], 1);
        assert!(icon["modified_at"].is_i64());
    }
}
