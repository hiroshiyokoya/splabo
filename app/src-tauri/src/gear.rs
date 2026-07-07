//! geartoon 由来のギア表示系コマンドモジュール。
//!
//! splabo v0.8 統合（Phase A1）で geartoon の `lib.rs` からギア表示系 4 コマンドを
//! chartoon crate へ移植したもの。暗号化・復号は `crate::gear_crypto` に委譲する。
//!
//! 表示系コマンド（Phase A1）:
//! - `read_gear_db`     : gear_db.bin を復号（無ければ gear_db.json）して JSON 文字列で返す
//! - `get_data_dir`     : data ディレクトリの絶対パス（スラッシュ区切り）を返す
//! - `read_all_gti`     : images/ 配下の全 .gti を XOR 解除して base64 data URL 化して返す
//! - `delete_gear_data` : app_data/data/ を丸ごと削除する
//!
//! 取得系コマンド（Phase A2・splabo v0.8）:
//! - `fetch_gear_full`  : bullet_token → GraphQL → 画像 DL → gear_db.json 構築 → 暗号化して
//!                        gear_db.bin / .gti 化。geartoon サイドカー fetch_gear を Rust に置換。
//!                        出力フォーマットは現行 geartoon 出力（gear-export-v1）と完全互換。

use tauri::{AppHandle, Emitter, Manager};

use crate::gear_crypto;

/// PathBuf を Windows の \\?\ プレフィックスなし・スラッシュ区切りの文字列に変換
fn path_to_slash(p: &std::path::Path) -> String {
    let s = p.to_string_lossy();
    // Windows extended path prefix を除去
    let s = s.strip_prefix(r"\\?\").unwrap_or(&s);
    s.replace('\\', "/")
}

/// データディレクトリのパスを解決する。
/// gear_db.bin（暗号化済み）または gear_db.json（開発用平文）が存在するディレクトリを返す。
fn resolve_data_dir(app: &AppHandle) -> Option<std::path::PathBuf> {
    if let Ok(data_dir) = app.path().app_data_dir() {
        let p = data_dir.join("data");
        if p.join("gear_db.bin").exists() || p.join("gear_db.json").exists() {
            return Some(p);
        }
    }
    for rel in ["../../tools/data", "../tools/data"] {
        let p = std::path::PathBuf::from(rel);
        if p.join("gear_db.bin").exists() || p.join("gear_db.json").exists() {
            if let Ok(canonical) = p.canonicalize() {
                return Some(canonical);
            }
        }
    }
    None
}

/// gear_db を読み込んで JSON 文字列で返す。
/// gear_db.bin（暗号化済み）があれば復号し、なければ gear_db.json をそのまま返す（開発用）。
#[tauri::command]
pub fn read_gear_db(app: AppHandle) -> Result<String, String> {
    let dir = resolve_data_dir(&app)
        .ok_or_else(|| "ギアデータが見つかりません".to_string())?;

    let bin_path = dir.join("gear_db.bin");
    if bin_path.exists() {
        let encrypted = std::fs::read(&bin_path).map_err(|e| e.to_string())?;
        let plain = gear_crypto::decrypt_db(&encrypted)?;
        String::from_utf8(plain).map_err(|e| e.to_string())
    } else {
        std::fs::read_to_string(dir.join("gear_db.json")).map_err(|e| e.to_string())
    }
}

/// data/ の絶対パスを返す（フロントエンドが画像パスを解決するために使用）
/// パスはスラッシュ区切り・\\?\ プレフィックスなしで返す
#[tauri::command]
pub fn get_data_dir(app: AppHandle) -> Result<String, String> {
    resolve_data_dir(&app)
        .map(|p| path_to_slash(&p))
        .ok_or_else(|| "ギアデータディレクトリが見つかりません".to_string())
}

/// data ディレクトリ配下の images/ を再帰スキャンして全 .gti ファイルを収集する。
fn collect_gti_paths(dir: &std::path::Path, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_gti_paths(&path, out);
        } else if path.extension().and_then(|s| s.to_str()) == Some("gti") {
            out.push(path_to_slash(&path));
        }
    }
}

/// data/images/ 配下の全 .gti ファイルを一括スキャンして読み込み、
/// XOR 解除した PNG を base64 data URL に変換して返す。
/// DB に含まれない画像（アキ枠など）も含めて全ファイルをカバーする。
/// 戻値: { "絶対パス（スラッシュ区切り）" → "data:image/png;base64,..." }
#[tauri::command]
pub fn read_all_gti(app: AppHandle) -> Result<std::collections::HashMap<String, String>, String> {
    use base64::{Engine, engine::general_purpose::STANDARD};

    let data_dir = resolve_data_dir(&app)
        .ok_or_else(|| "データディレクトリが見つかりません".to_string())?;
    let images_dir = data_dir.join("images");

    let mut paths = Vec::new();
    if images_dir.is_dir() {
        collect_gti_paths(&images_dir, &mut paths);
    }

    let mut map = std::collections::HashMap::new();
    for path in paths {
        match std::fs::read(&path) {
            Ok(scrambled) => {
                let png = gear_crypto::scramble_image(&scrambled);
                map.insert(path, format!("data:image/png;base64,{}", STANDARD.encode(&png)));
            }
            Err(e) => log::warn!("read_all_gti: {} をスキップ: {}", path, e),
        }
    }
    Ok(map)
}

/// AppData/data/ 以下（gear_db.bin・images/）を削除する。
/// 削除後はアプリ再起動またはリロードが必要。
#[tauri::command]
pub fn delete_gear_data(app: AppHandle) -> Result<(), String> {
    if let Ok(data_dir) = app.path().app_data_dir() {
        let p = data_dir.join("data");
        if p.exists() {
            std::fs::remove_dir_all(&p).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

// ===========================================================================
// 取得系（Phase A2）: ギア取得 Rust 化
//
// geartoon サイドカー（tools/nxapi-wrapper/wrapper.js の fetch_gear）を Rust に置換する。
// 出力フォーマット（gear_db.json のスキーマ・画像パス・.gti / gear_db.bin への暗号化）は
// wrapper.js `buildGearDb` / `downloadGearImages` および geartoon nxapi.rs `encrypt_gear_data`
// と**完全互換**（gear-export-v1 契約 = geartoon-viewer が読める形）。
// ===========================================================================

/// GraphQL レスポンス（`data.<section>.nodes`）のセクション定義。
/// (JSON セクションキー, DB カテゴリ名, ノードの ID フィールド名)
/// wrapper.js の `sections` と同一。
const GEAR_SECTIONS: [(&str, &str, &str); 3] = [
    ("headGears", "head", "headGearId"),
    ("clothingGears", "clothing", "clothingGearId"),
    ("shoesGears", "shoes", "shoesGearId"),
];

/// URL からクエリ文字列を除いた末尾ファイル名を取り出す。
/// wrapper.js `filenameFromUrl` と同一。
fn filename_from_url(url: &str) -> String {
    url.split('?')
        .next()
        .unwrap_or(url)
        .rsplit('/')
        .next()
        .unwrap_or("")
        .to_string()
}

/// gear_db.json に埋め込む相対画像パス（`images/<subdir>/<filename>`）を組み立てる。
/// wrapper.js `localImage` と同一。
fn local_image(url: &str, subdir: &str) -> String {
    format!("images/{subdir}/{}", filename_from_url(url))
}

/// 取得結果サマリ（フロント／ログ向け）。
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub struct GearFetchResult {
    pub head: usize,
    pub clothing: usize,
    pub shoes: usize,
    pub skills: usize,
    /// 生成した gear_db.bin の絶対パス（スラッシュ区切り）。
    pub db_path: String,
}

/// GraphQL の生レスポンス（equipment）から gear_db.json 相当の serde_json::Value を構築する。
///
/// wrapper.js `buildGearDb` の Rust 移植。画像パスは **.png のまま**（後段の
/// `encrypt_gear_data_at` が JSON 文字列レベルで `.png"` → `.gti"` に置換する）。
/// トップレベル構造・フィールド名・順序は wrapper.js と一致させ、gear-export-v1 契約を守る。
fn build_gear_db(equipment: &serde_json::Value) -> Result<serde_json::Value, String> {
    use serde_json::{json, Map, Value};

    let mut db = Map::new();
    // スキル辞書（id → { id, name, image }）。アキ枠を含む全スキルを収集する。
    let mut skills_map = Map::new();

    for (section, category, id_field) in GEAR_SECTIONS {
        let nodes = equipment
            .pointer(&format!("/data/{section}/nodes"))
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();

        let mut items = Vec::with_capacity(nodes.len());
        for node in &nodes {
            // primary_skill
            let ps = node.get("primaryGearPower").ok_or_else(|| {
                format!("{section}: node に primaryGearPower がありません")
            })?;
            let ps_url = ps
                .pointer("/image/url")
                .and_then(|v| v.as_str())
                .ok_or_else(|| format!("{section}: primaryGearPower.image.url がありません"))?;
            let primary_skill = json!({
                "id": ps.get("gearPowerId").cloned().unwrap_or(Value::Null),
                "name": ps.get("name").cloned().unwrap_or(Value::Null),
                "image": local_image(ps_url, "skill"),
            });

            // additional_skills
            let mut additional_skills = Vec::new();
            if let Some(arr) = node.get("additionalGearPowers").and_then(|v| v.as_array()) {
                for p in arr {
                    let url = p
                        .pointer("/image/url")
                        .and_then(|v| v.as_str())
                        .ok_or_else(|| {
                            format!("{section}: additionalGearPowers[].image.url がありません")
                        })?;
                    additional_skills.push(json!({
                        "id": p.get("gearPowerId").cloned().unwrap_or(Value::Null),
                        "name": p.get("name").cloned().unwrap_or(Value::Null),
                        "image": local_image(url, "skill"),
                    }));
                }
            }

            // スキル辞書に登録（重複は上書きで問題なし）
            if let Some(id) = primary_skill.get("id") {
                skills_map.insert(skill_key(id), primary_skill.clone());
            }
            for s in &additional_skills {
                if let Some(id) = s.get("id") {
                    skills_map.insert(skill_key(id), s.clone());
                }
            }

            let brand = node.get("brand").ok_or_else(|| format!("{section}: brand がありません"))?;
            let brand_url = brand
                .pointer("/image/url")
                .and_then(|v| v.as_str())
                .ok_or_else(|| format!("{section}: brand.image.url がありません"))?;
            let gear_url = node
                .pointer("/image/url")
                .and_then(|v| v.as_str())
                .ok_or_else(|| format!("{section}: image.url がありません"))?;

            items.push(json!({
                "id": node.get(id_field).cloned().unwrap_or(Value::Null),
                "name": node.get("name").cloned().unwrap_or(Value::Null),
                "rarity": node.get("rarity").cloned().unwrap_or(Value::Null),
                "brand": brand.get("name").cloned().unwrap_or(Value::Null),
                "brand_image": local_image(brand_url, "brand"),
                "image": local_image(gear_url, &format!("gear/{category}")),
                "primary_skill": primary_skill,
                "additional_skills": additional_skills,
                "exp": node.pointer("/stats/exp").cloned().unwrap_or(Value::Null),
            }));
        }
        db.insert(category.to_string(), Value::Array(items));
    }

    db.insert("skills".to_string(), Value::Object(skills_map));
    Ok(Value::Object(db))
}

/// スキル辞書のキー生成。JS オブジェクトのキー（`skillsMap[id]`）は数値 id を
/// 文字列化したものになるため、数値はそのまま数値文字列に、それ以外は文字列表現にする。
fn skill_key(id: &serde_json::Value) -> String {
    match id {
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// GraphQL の生レスポンスから、DL 対象の画像 (URL, 保存先相対サブディレクトリ) を収集する。
/// wrapper.js `downloadGearImages` と同じ対象（ギア画像・ブランド画像・スキル画像）。
/// スキル画像は URL 単位で重複排除する。
fn collect_image_targets(equipment: &serde_json::Value) -> Vec<(String, String)> {
    let mut targets: Vec<(String, String)> = Vec::new();
    let mut seen_skill_urls = std::collections::HashSet::new();

    for (section, _category, _id) in GEAR_SECTIONS {
        // wrapper.js は保存先を label（head/clothing/shoes）で分ける。
        let label = match section {
            "headGears" => "head",
            "clothingGears" => "clothing",
            "shoesGears" => "shoes",
            _ => continue,
        };
        let Some(nodes) = equipment
            .pointer(&format!("/data/{section}/nodes"))
            .and_then(|v| v.as_array())
        else {
            continue;
        };
        for node in nodes {
            if let Some(url) = node.pointer("/image/url").and_then(|v| v.as_str()) {
                targets.push((url.to_string(), format!("gear/{label}")));
            }
            if let Some(url) = node.pointer("/brand/image/url").and_then(|v| v.as_str()) {
                targets.push((url.to_string(), "brand".to_string()));
            }
            if let Some(url) = node.pointer("/primaryGearPower/image/url").and_then(|v| v.as_str()) {
                if seen_skill_urls.insert(url.to_string()) {
                    targets.push((url.to_string(), "skill".to_string()));
                }
            }
            if let Some(arr) = node.get("additionalGearPowers").and_then(|v| v.as_array()) {
                for sub in arr {
                    if let Some(url) = sub.pointer("/image/url").and_then(|v| v.as_str()) {
                        if seen_skill_urls.insert(url.to_string()) {
                            targets.push((url.to_string(), "skill".to_string()));
                        }
                    }
                }
            }
        }
    }
    targets
}

/// 画像を data_dir/images/<subdir>/<filename> に DL する（既存はスキップ）。
/// wrapper.js `downloadFile` 相当。DL 直後は PNG のまま保存し、後段でまとめて .gti 化する。
async fn download_gear_images(
    client: &reqwest::Client,
    equipment: &serde_json::Value,
    images_dir: &std::path::Path,
) -> Result<(usize, usize), String> {
    let targets = collect_image_targets(equipment);
    let mut downloaded = 0usize;
    let mut skipped = 0usize;

    for (url, subdir) in targets {
        let filename = filename_from_url(&url);
        if filename.is_empty() {
            continue;
        }
        let dest = images_dir.join(&subdir).join(&filename);
        if dest.exists() {
            skipped += 1;
            continue;
        }
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let bytes = client
            .get(&url)
            .header("User-Agent", "Mozilla/5.0")
            .send()
            .await
            .map_err(|e| format!("画像 DL 失敗 ({url}): {e}"))?
            .bytes()
            .await
            .map_err(|e| format!("画像読み取り失敗 ({url}): {e}"))?;
        std::fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
        downloaded += 1;
    }
    Ok((downloaded, skipped))
}

/// gear_db.json（画像パス .png）を暗号化して gear_db.bin へ変換し、
/// images/ 配下の .png を XOR スクランブルして .gti にリネームする。
///
/// geartoon nxapi.rs `encrypt_gear_data` の移植。JSON 文字列レベルで `.png"` → `.gti"` に
/// 置換してから暗号化する点まで完全一致させ、gear-export-v1 契約を守る。
fn encrypt_gear_data_at(out_dir: &std::path::Path, db_json: &str) -> Result<(), String> {
    // 画像パスを .gti に書き換えてから暗号化（wrapper.js は .png で出力・geartoon が置換）。
    let patched = db_json.replace(".png\"", ".gti\"");
    let encrypted = gear_crypto::encrypt_db(patched.as_bytes())?;
    let bin_path = out_dir.join("gear_db.bin");
    std::fs::write(&bin_path, encrypted).map_err(|e| e.to_string())?;

    // images/ 配下の .png を再帰的に .gti へスクランブル変換
    let images_dir = out_dir.join("images");
    if images_dir.is_dir() {
        scramble_images_recursive(&images_dir)?;
    }
    Ok(())
}

/// ディレクトリを再帰的に走査し、すべての .png を XOR スクランブルして .gti に変換する。
/// geartoon nxapi.rs `scramble_images_recursive` の移植。
fn scramble_images_recursive(dir: &std::path::Path) -> Result<(), String> {
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            scramble_images_recursive(&path)?;
        } else if path.extension().and_then(|s| s.to_str()) == Some("png") {
            let data = std::fs::read(&path).map_err(|e| e.to_string())?;
            let scrambled = gear_crypto::scramble_image(&data);
            let gti_path = path.with_extension("gti");
            std::fs::write(&gti_path, scrambled).map_err(|e| e.to_string())?;
            std::fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// 出力先 data ディレクトリを解決する（本番: app_data_dir/data）。無ければ作成する。
fn resolve_gear_out_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("アプリデータディレクトリ解決失敗: {e}"))?;
    let out = data_dir.join("data");
    std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
    Ok(out)
}

/// ギアを取得して gear_db.bin / .gti を生成する（Phase A2 の本命コマンド）。
///
/// フロー: bullet_token 取得 → MyOutfitCommonDataEquipmentsQuery →
/// gear_db.json 構築 → 画像 DL → 暗号化（gear_db.bin / .gti）。
/// 出力は現行 geartoon 出力（gear-export-v1）と完全互換。
#[tauri::command]
pub async fn fetch_gear_full(app: AppHandle) -> Result<GearFetchResult, String> {
    if !crate::auth::is_logged_in(&app) {
        return Err("NOT_LOGGED_IN: Nintendo アカウントでログインしていません。設定からログインしてください。".to_string());
    }

    let bt = crate::nxapi::nxapi_get_bullet_token(&app).await?;
    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("HTTP クライアント構築失敗: {e}"))?;

    let equipment = crate::splatnet3::fetch_gear_equipment(
        &client,
        &bt.bullet_token,
        &bt.country,
        &bt.language,
    )
    .await?;

    let out_dir = resolve_gear_out_dir(&app)?;
    let result = build_and_write_gear_data(&client, &equipment, &out_dir).await?;
    log::info!(
        "[gear] 取得完了 頭 {} / 服 {} / 靴 {} / スキル {} → {}",
        result.head, result.clothing, result.shoes, result.skills, result.db_path
    );
    // 取得元（ギアタブの「データ更新」/ サイドバーの一括取得）を問わず、
    // フロントのギア一覧を再読み込みさせるためのイベントを発火する。
    let _ = app.emit("gear_updated", ());
    Ok(result)
}

/// gear_db 構築 → 画像 DL → 暗号化 をまとめて実行する。
/// テストからも呼べるように fetch_gear_full 本体から分離してある（equipment を注入可能）。
async fn build_and_write_gear_data(
    client: &reqwest::Client,
    equipment: &serde_json::Value,
    out_dir: &std::path::Path,
) -> Result<GearFetchResult, String> {
    let db = build_gear_db(equipment)?;

    let head = db.get("head").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
    let clothing = db.get("clothing").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
    let shoes = db.get("shoes").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
    let skills = db.get("skills").and_then(|v| v.as_object()).map(|o| o.len()).unwrap_or(0);

    let db_json = serde_json::to_string_pretty(&db).map_err(|e| e.to_string())?;

    // 画像 DL（images/ に PNG で保存）→ 暗号化（.png → .gti、gear_db.json → gear_db.bin）
    let images_dir = out_dir.join("images");
    download_gear_images(client, equipment, &images_dir).await?;
    encrypt_gear_data_at(out_dir, &db_json)?;

    let db_path = path_to_slash(&out_dir.join("gear_db.bin"));
    Ok(GearFetchResult { head, clothing, shoes, skills, db_path })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// テスト用の最小 equipment フィクスチャ（wrapper.js が受け取る `splatnet.getEquipment()`
    /// の構造に一致）。頭 1・服 1・靴 1 の 3 ギア、共有スキルあり。
    fn fixture_equipment() -> serde_json::Value {
        serde_json::json!({
            "data": {
                "headGears": { "nodes": [{
                    "headGearId": 100,
                    "name": "テストヘッド",
                    "rarity": 3,
                    "brand": { "name": "アロメ", "image": { "url": "https://cdn.example/brand/allome.png?x=1" } },
                    "image": { "url": "https://cdn.example/gear/head/hat.png" },
                    "primaryGearPower": { "gearPowerId": 1, "name": "インク効率アップ(メイン)", "image": { "url": "https://cdn.example/skill/ink_main.png" } },
                    "additionalGearPowers": [
                        { "gearPowerId": 0, "name": "アキ枠", "image": { "url": "https://cdn.example/skill/empty.png" } },
                        { "gearPowerId": 2, "name": "ヒト移動速度アップ", "image": { "url": "https://cdn.example/skill/run.png" } }
                    ],
                    "stats": { "exp": 1200 }
                }]},
                "clothingGears": { "nodes": [{
                    "clothingGearId": 200,
                    "name": "テストクロース",
                    "rarity": 2,
                    "brand": { "name": "バトロイカ", "image": { "url": "https://cdn.example/brand/barazushi.png" } },
                    "image": { "url": "https://cdn.example/gear/clothing/shirt.png" },
                    "primaryGearPower": { "gearPowerId": 3, "name": "スペシャル増加量アップ", "image": { "url": "https://cdn.example/skill/sp_up.png" } },
                    "additionalGearPowers": [
                        { "gearPowerId": 2, "name": "ヒト移動速度アップ", "image": { "url": "https://cdn.example/skill/run.png" } }
                    ],
                    "stats": { "exp": 0 }
                }]},
                "shoesGears": { "nodes": [{
                    "shoesGearId": 300,
                    "name": "テストシューズ",
                    "rarity": 4,
                    "brand": { "name": "エゾッコ", "image": { "url": "https://cdn.example/brand/rockenberg.png" } },
                    "image": { "url": "https://cdn.example/gear/shoes/boots.png" },
                    "primaryGearPower": { "gearPowerId": 4, "name": "爆風ダメージ軽減・改", "image": { "url": "https://cdn.example/skill/bomb_def.png" } },
                    "additionalGearPowers": [],
                    "stats": { "exp": 3600 }
                }]}
            }
        })
    }

    #[test]
    fn build_gear_db_matches_gear_export_v1_schema() {
        let eq = fixture_equipment();
        let db = build_gear_db(&eq).expect("build_gear_db failed");

        // トップレベルは head / clothing / shoes / skills（gear-export-v1 契約）
        for key in ["head", "clothing", "shoes", "skills"] {
            assert!(db.get(key).is_some(), "top-level key {key} missing");
        }

        // 各カテゴリ 1 件
        assert_eq!(db["head"].as_array().unwrap().len(), 1);
        assert_eq!(db["clothing"].as_array().unwrap().len(), 1);
        assert_eq!(db["shoes"].as_array().unwrap().len(), 1);

        // ギア 1 件のフィールド一式（GearItem スキーマ）
        let head = &db["head"][0];
        assert_eq!(head["id"], 100);
        assert_eq!(head["name"], "テストヘッド");
        assert_eq!(head["rarity"], 3);
        assert_eq!(head["brand"], "アロメ");
        assert_eq!(head["exp"], 1200);
        // 相対画像パス（.png のまま。encrypt 段で .gti 化）。クエリ文字列は除去される。
        assert_eq!(head["image"], "images/gear/head/hat.png");
        assert_eq!(head["brand_image"], "images/brand/allome.png");
        assert_eq!(head["primary_skill"]["id"], 1);
        assert_eq!(head["primary_skill"]["image"], "images/skill/ink_main.png");
        assert_eq!(head["additional_skills"].as_array().unwrap().len(), 2);
        assert_eq!(head["additional_skills"][1]["id"], 2);

        // skills 辞書はアキ枠(0)含む全スキルを収集。共有スキル(id:2)は 1 エントリに集約。
        let skills = db["skills"].as_object().unwrap();
        // ユニークな gearPowerId: 0,1,2,3,4 → 5 エントリ
        assert_eq!(skills.len(), 5, "skills = {:?}", skills.keys().collect::<Vec<_>>());
        assert_eq!(skills["0"]["name"], "アキ枠");
        assert_eq!(skills["2"]["name"], "ヒト移動速度アップ");
    }

    #[test]
    fn filename_from_url_strips_query_and_path() {
        assert_eq!(filename_from_url("https://cdn.example/a/b/c.png?x=1&y=2"), "c.png");
        assert_eq!(filename_from_url("https://cdn.example/x.png"), "x.png");
    }

    #[test]
    fn collect_image_targets_dedups_skill_urls() {
        let eq = fixture_equipment();
        let targets = collect_image_targets(&eq);
        // ギア画像 3 + ブランド 3 + スキル（ユニーク URL: ink_main, empty, run, sp_up, bomb_def = 5）
        // run.png は head/clothing で共有されるが 1 回だけ。合計 3+3+5 = 11。
        assert_eq!(targets.len(), 11, "targets = {targets:?}");
        // gear/clothing のサブディレクトリが正しく付く
        assert!(targets.iter().any(|(u, s)| u.ends_with("shirt.png") && s == "gear/clothing"));
        // ブランド画像は brand サブディレクトリ（URL はクエリ付きのまま DL 対象になる）
        assert!(targets.iter().any(|(u, s)| u.contains("allome.png") && s == "brand"));
    }

    #[test]
    fn encrypt_roundtrip_produces_gear_export_v1_bin() {
        // gear_db.json（.png パス）→ encrypt → decrypt して、画像パスが .gti 化され、
        // 復号 JSON が gear-export-v1 スキーマとして読めることを確認する。
        let tmp = std::env::temp_dir().join(format!("splabo_gear_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        // ダミー PNG 画像を 1 枚置く（.png → .gti 変換対象）
        let img_dir = tmp.join("images").join("skill");
        std::fs::create_dir_all(&img_dir).unwrap();
        let png_bytes: &[u8] = b"\x89PNG\r\n\x1a\nDUMMYPNGDATA";
        std::fs::write(img_dir.join("ink_main.png"), png_bytes).unwrap();

        let db = build_gear_db(&fixture_equipment()).unwrap();
        let db_json = serde_json::to_string_pretty(&db).unwrap();
        encrypt_gear_data_at(&tmp, &db_json).unwrap();

        // gear_db.bin が生成され、.gti に変換されている
        let bin = std::fs::read(tmp.join("gear_db.bin")).unwrap();
        assert!(tmp.join("images/skill/ink_main.gti").exists());
        assert!(!tmp.join("images/skill/ink_main.png").exists());

        // 復号ラウンドトリップ
        let plain = gear_crypto::decrypt_db(&bin).unwrap();
        let decoded: serde_json::Value = serde_json::from_slice(&plain).unwrap();
        // 画像パスが .gti になっている（gear-export-v1: viewer は .gti を read_all_gti で読む）
        assert_eq!(decoded["head"][0]["image"], "images/gear/head/hat.gti");
        assert_eq!(decoded["head"][0]["primary_skill"]["image"], "images/skill/ink_main.gti");
        assert_eq!(decoded["skills"]["2"]["image"], "images/skill/run.gti");

        // .gti を XOR 復元すると元の PNG に戻る（画像互換）
        let gti = std::fs::read(tmp.join("images/skill/ink_main.gti")).unwrap();
        assert_eq!(gear_crypto::scramble_image(&gti), png_bytes);

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
