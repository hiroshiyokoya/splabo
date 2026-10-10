//! 保存コーデ（#782）。
//!
//! ギアタブで作ったコーデ（頭・服・靴の 3 部位）をタイトル・メモつきで保存する。
//!
//! ## 保存先
//! `app_data_dir()/saved_coordinates.json`（平文 JSON）。`app_data_dir()/data/` は
//! ギア取得のたびに `gear_db.bin` が上書きされ、「ギアデータ削除」で丸ごと消えるため使わない。
//!
//! ## ギアの持ち方
//! ギアは `(部位, id)` で参照する（`id` は SplatNet3 の `headGearId` 等。同じギアは 1 つしか
//! 持てないので手持ちの中で一意）。追加ギアパワーは後から変わりうるので、保存時点の
//! メイン・サブの gearPowerId をスナップショットとして持ち、表示側で現在の gear_db と突き合わせる。
//! ギア名も保存時点のものを持つ（手放したギアを「ギアなし」と出すときの表示用）。
//!
//! ## viewer への提供
//! コンパニオンサーバーの `GET /coordinates.bin` が本ファイルの内容を gear_db と同じ方式
//! （`gear_crypto::encrypt_db`）で暗号化して配信する（`export_bytes`）。viewer は閲覧のみ。

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

pub const FILE_NAME: &str = "saved_coordinates.json";
pub const SCHEMA: &str = "saved-coordinates-v1";
pub const VERSION: u32 = 1;

/// 読み書き（read-modify-write）を直列化する。
static FILE_LOCK: Mutex<()> = Mutex::new(());

/// 保存コーデの 1 部位ぶんのギア参照（保存時点のスナップショットつき）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GearRef {
    /// SplatNet3 のギア ID（部位内で一意）。
    pub id: i64,
    /// 保存時点のギア名。
    #[serde(default)]
    pub name: String,
    /// 保存時点のメインギアパワー（gearPowerId）。
    pub main: i64,
    /// 保存時点のサブギアパワー（gearPowerId・アキは -1）。
    #[serde(default)]
    pub subs: Vec<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CoordinateGears {
    pub head: GearRef,
    pub clothing: GearRef,
    pub shoes: GearRef,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SavedCoordinate {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub memo: String,
    /// UTC ISO8601（`%Y-%m-%dT%H:%M:%SZ`）。
    pub created_at: String,
    pub updated_at: String,
    pub gears: CoordinateGears,
}

/// ファイル全体（= viewer へ配信する JSON の形）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SavedCoordinatesFile {
    pub schema: String,
    pub version: u32,
    pub coordinates: Vec<SavedCoordinate>,
}

impl Default for SavedCoordinatesFile {
    fn default() -> Self {
        Self { schema: SCHEMA.to_string(), version: VERSION, coordinates: Vec::new() }
    }
}

/// `save_coordinate` の入力。`id` が既存なら更新、無い・未知なら新規作成。
#[derive(Debug, Clone, Deserialize)]
pub struct SaveCoordinateInput {
    #[serde(default)]
    pub id: Option<String>,
    pub title: String,
    #[serde(default)]
    pub memo: String,
    pub gears: CoordinateGears,
}

fn now_iso() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// 保存先パス（`app_data_dir()/saved_coordinates.json`）。
pub fn file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("アプリデータディレクトリ解決失敗: {e}"))?;
    Ok(dir.join(FILE_NAME))
}

/// ファイルを読む。無ければ空。壊れていればエラー（上書きして消さないため）。
pub fn read_file(path: &Path) -> Result<SavedCoordinatesFile, String> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|e| format!("保存コーデの読み込みに失敗しました: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(SavedCoordinatesFile::default()),
        Err(e) => Err(e.to_string()),
    }
}

/// 一時ファイルに書いてから置き換える（書きかけで壊さない）。
fn write_file(path: &Path, file: &SavedCoordinatesFile) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_vec_pretty(file).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// 新規作成または更新して、保存後の 1 件を返す。
pub fn upsert(path: &Path, input: SaveCoordinateInput) -> Result<SavedCoordinate, String> {
    let _guard = FILE_LOCK.lock().map_err(|e| e.to_string())?;
    let mut file = read_file(path)?;
    let now = now_iso();
    let title = input.title.trim().to_string();
    let memo = input.memo.trim_end().to_string();

    let existing = input
        .id
        .as_deref()
        .and_then(|id| file.coordinates.iter_mut().find(|c| c.id == id));
    let saved = match existing {
        Some(c) => {
            c.title = title;
            c.memo = memo;
            c.gears = input.gears;
            c.updated_at = now;
            c.clone()
        }
        None => {
            let c = SavedCoordinate {
                id: new_id(),
                title,
                memo,
                created_at: now.clone(),
                updated_at: now,
                gears: input.gears,
            };
            file.coordinates.push(c.clone());
            c
        }
    };
    file.schema = SCHEMA.to_string();
    file.version = VERSION;
    write_file(path, &file)?;
    Ok(saved)
}

/// 1 件削除する（無ければ何もしない）。
pub fn remove(path: &Path, id: &str) -> Result<(), String> {
    let _guard = FILE_LOCK.lock().map_err(|e| e.to_string())?;
    let mut file = read_file(path)?;
    let before = file.coordinates.len();
    file.coordinates.retain(|c| c.id != id);
    if file.coordinates.len() == before {
        return Ok(());
    }
    write_file(path, &file)
}

/// viewer へ配信する平文 JSON（ファイルが無ければ空の一覧）。
///
/// ETag は暗号化前のこのバイト列から作る（暗号化は nonce が毎回変わるため）。
pub fn export_bytes(path: &Path) -> Result<Vec<u8>, String> {
    let file = {
        let _guard = FILE_LOCK.lock().map_err(|e| e.to_string())?;
        read_file(path)?
    };
    serde_json::to_vec(&file).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_saved_coordinates(app: AppHandle) -> Result<Vec<SavedCoordinate>, String> {
    let path = file_path(&app)?;
    let _guard = FILE_LOCK.lock().map_err(|e| e.to_string())?;
    Ok(read_file(&path)?.coordinates)
}

#[tauri::command]
pub fn save_coordinate(app: AppHandle, input: SaveCoordinateInput) -> Result<SavedCoordinate, String> {
    upsert(&file_path(&app)?, input)
}

#[tauri::command]
pub fn delete_saved_coordinate(app: AppHandle, id: String) -> Result<(), String> {
    remove(&file_path(&app)?, &id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "splabo_saved_coords_test_{}_{}",
            std::process::id(),
            tag
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(FILE_NAME)
    }

    fn gear(id: i64) -> GearRef {
        GearRef { id, name: format!("gear{id}"), main: 4, subs: vec![0, -1, 4] }
    }

    fn input(id: Option<&str>, title: &str) -> SaveCoordinateInput {
        SaveCoordinateInput {
            id: id.map(str::to_string),
            title: title.to_string(),
            memo: "memo".to_string(),
            gears: CoordinateGears { head: gear(1), clothing: gear(2), shoes: gear(3) },
        }
    }

    #[test]
    fn missing_file_reads_as_empty() {
        let path = temp_path("missing");
        assert_eq!(read_file(&path).unwrap(), SavedCoordinatesFile::default());
    }

    #[test]
    fn creates_then_updates_by_id() {
        let path = temp_path("upsert");
        let a = upsert(&path, input(None, "  イカ速  ")).unwrap();
        assert_eq!(a.title, "イカ速");
        assert!(!a.id.is_empty());

        let b = upsert(&path, input(Some(&a.id), "インク効率")).unwrap();
        assert_eq!(b.id, a.id);
        assert_eq!(b.created_at, a.created_at);
        assert_eq!(b.title, "インク効率");

        let file = read_file(&path).unwrap();
        assert_eq!(file.coordinates.len(), 1);
        assert_eq!(file.schema, SCHEMA);
    }

    #[test]
    fn unknown_id_creates_new() {
        let path = temp_path("unknown");
        let a = upsert(&path, input(Some("nope"), "x")).unwrap();
        assert_ne!(a.id, "nope");
        assert_eq!(read_file(&path).unwrap().coordinates.len(), 1);
    }

    #[test]
    fn removes_by_id() {
        let path = temp_path("remove");
        let a = upsert(&path, input(None, "a")).unwrap();
        let b = upsert(&path, input(None, "b")).unwrap();
        remove(&path, &a.id).unwrap();
        remove(&path, "nope").unwrap();
        let ids: Vec<_> = read_file(&path).unwrap().coordinates.into_iter().map(|c| c.id).collect();
        assert_eq!(ids, vec![b.id]);
    }

    #[test]
    fn broken_file_is_an_error_and_not_overwritten() {
        let path = temp_path("broken");
        std::fs::write(&path, b"{not json").unwrap();
        assert!(upsert(&path, input(None, "a")).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"{not json");
    }

    #[test]
    fn export_has_envelope() {
        let path = temp_path("export");
        let empty: serde_json::Value = serde_json::from_slice(&export_bytes(&path).unwrap()).unwrap();
        assert_eq!(empty["schema"], SCHEMA);
        assert_eq!(empty["version"], VERSION);
        assert_eq!(empty["coordinates"], serde_json::json!([]));

        upsert(&path, input(None, "a")).unwrap();
        let v: serde_json::Value = serde_json::from_slice(&export_bytes(&path).unwrap()).unwrap();
        assert_eq!(v["coordinates"][0]["gears"]["head"]["subs"], serde_json::json!([0, -1, 4]));
    }
}
