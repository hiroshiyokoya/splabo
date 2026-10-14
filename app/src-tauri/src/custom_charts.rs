//! スマホからダッシュボードのカスタムグラフを保存する（#819）。
//!
//! グラフの定義の正本はデスクトップの localStorage（`splabo:shellCustomCharts`）で、保存のたびに
//! `settings.json`（tauri-plugin-store）へミラーされている（`settingsStore.ts`）。スマホからは
//! localStorage に触れないので、ミラーの方を書き換え、デスクトップの画面にイベントで知らせて
//! localStorage へ写させる（`custom_charts_changed`）。
//!
//! - 操作は 1 つずつ（追加・更新・削除・並べ替え）。並び全体を上書きすると、PC とスマホで同時に
//!   別のグラフを足したときに片方が消えるため
//! - グラフの中身はここでは解釈しない（`id` だけ見る）。読み込み時の正規化はフロントの
//!   `loadCustomCharts` がする

use std::sync::Mutex;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Runtime};
use tauri_plugin_store::StoreExt;

/// ミラー先の store（`settingsStore.ts` の `STORE_FILE`）
const STORE_FILE: &str = "settings.json";
/// グラフの定義のキー（`settingsStore.ts` の `CUSTOM_CHARTS_KEY`）
pub const CUSTOM_CHARTS_KEY: &str = "splabo:shellCustomCharts";
/// ミラー時刻のキー（`settingsStore.ts` の `MIRRORED_AT_KEY`）
const MIRRORED_AT_KEY: &str = "_mirroredAt";
/// デスクトップの画面に知らせるイベント
pub const CHANGED_EVENT: &str = "custom_charts_changed";
/// グラフの数の上限（壊れたリクエストで store を膨らませないため）
const MAX_CHARTS: usize = 100;

/// HTTP のスレッドは並んで来るので、読んで書くまでを 1 つずつにする
static LOCK: Mutex<()> = Mutex::new(());

/// グラフへの操作
#[derive(Debug, Clone, PartialEq)]
pub enum ChartOp {
    /// `id` が同じものがあれば置き換え、無ければ末尾に足す
    Upsert(Value),
    Delete(String),
    /// `id` の並び。ここに無いグラフ（ほかの端末が今足したものなど）は、元の順のまま後ろに残す
    Reorder(Vec<String>),
}

/// デスクトップに渡す中身
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedPayload {
    /// localStorage にそのまま入れる文字列（JSON の配列）
    pub raw: String,
    /// store に書いたミラー時刻（epoch ms）
    pub mirrored_at: i64,
}

/// store の値（JSON の配列を文字列にしたもの）を読む。無い・壊れているときは空。
pub fn parse_charts(raw: Option<&Value>) -> Vec<Value> {
    raw.and_then(Value::as_str)
        .and_then(|s| serde_json::from_str::<Value>(s).ok())
        .and_then(|v| match v {
            Value::Array(a) => Some(a),
            _ => None,
        })
        .unwrap_or_default()
}

fn chart_id(c: &Value) -> Option<&str> {
    c.get("id").and_then(Value::as_str)
}

/// 操作を当てる。
pub fn apply_op(charts: &mut Vec<Value>, op: ChartOp) -> Result<(), String> {
    match op {
        ChartOp::Upsert(chart) => {
            let id = match chart_id(&chart) {
                Some(id) if !id.is_empty() => id.to_string(),
                _ => return Err("グラフの id がありません".to_string()),
            };
            if !chart.is_object() {
                return Err("グラフの形が不正です".to_string());
            }
            match charts.iter().position(|c| chart_id(c) == Some(id.as_str())) {
                Some(i) => charts[i] = chart,
                None => {
                    if charts.len() >= MAX_CHARTS {
                        return Err(format!("グラフは {MAX_CHARTS} 個までです"));
                    }
                    charts.push(chart);
                }
            }
        }
        ChartOp::Delete(id) => {
            charts.retain(|c| chart_id(c) != Some(id.as_str()));
        }
        ChartOp::Reorder(ids) => {
            let mut rest = std::mem::take(charts);
            for id in &ids {
                if let Some(i) = rest.iter().position(|c| chart_id(c) == Some(id.as_str())) {
                    charts.push(rest.remove(i));
                }
            }
            charts.extend(rest);
        }
    }
    Ok(())
}

/// store のグラフに操作を当てて保存し、デスクトップに知らせる。新しい並びを返す。
pub fn apply<R: Runtime>(app: &AppHandle<R>, op: ChartOp) -> Result<Vec<Value>, String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    // デスクトップが読み込み済みなら同じ store を返す（設定は向こうのものが使われる）
    let store = app
        .store_builder(STORE_FILE)
        .disable_auto_save()
        .build()
        .map_err(|e| format!("設定ファイルを開けません: {e}"))?;

    let mut charts = parse_charts(store.get(CUSTOM_CHARTS_KEY).as_ref());
    apply_op(&mut charts, op)?;

    let raw = serde_json::to_string(&charts).map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().timestamp_millis();
    store.set(CUSTOM_CHARTS_KEY, raw.clone());
    store.set(MIRRORED_AT_KEY, now);
    store.save().map_err(|e| format!("設定ファイルに保存できません: {e}"))?;

    let _ = app.emit(CHANGED_EVENT, ChangedPayload { raw, mirrored_at: now });
    Ok(charts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ids(charts: &[Value]) -> Vec<&str> {
        charts.iter().filter_map(chart_id).collect()
    }

    #[test]
    fn parses_store_value() {
        let v = json!(r#"[{"id":"a"},{"id":"b"}]"#);
        assert_eq!(ids(&parse_charts(Some(&v))), ["a", "b"]);
        assert!(parse_charts(None).is_empty());
        assert!(parse_charts(Some(&json!("not json"))).is_empty());
        assert!(parse_charts(Some(&json!(r#"{"id":"a"}"#))).is_empty());
        assert!(parse_charts(Some(&json!(3))).is_empty());
    }

    #[test]
    fn upsert_replaces_or_appends() {
        let mut c = vec![json!({"id":"a","shape":"bar"}), json!({"id":"b"})];
        apply_op(&mut c, ChartOp::Upsert(json!({"id":"a","shape":"line"}))).unwrap();
        assert_eq!(c[0]["shape"], "line");
        apply_op(&mut c, ChartOp::Upsert(json!({"id":"c"}))).unwrap();
        assert_eq!(ids(&c), ["a", "b", "c"]);
    }

    #[test]
    fn upsert_rejects_missing_id() {
        let mut c = vec![];
        assert!(apply_op(&mut c, ChartOp::Upsert(json!({"shape":"bar"}))).is_err());
        assert!(apply_op(&mut c, ChartOp::Upsert(json!({"id":""}))).is_err());
        assert!(c.is_empty());
    }

    #[test]
    fn upsert_limits_count() {
        let mut c: Vec<Value> = (0..MAX_CHARTS).map(|i| json!({"id": i.to_string()})).collect();
        assert!(apply_op(&mut c, ChartOp::Upsert(json!({"id":"new"}))).is_err());
        // 既存の更新は上限に関係なくできる
        assert!(apply_op(&mut c, ChartOp::Upsert(json!({"id":"0","shape":"line"}))).is_ok());
    }

    #[test]
    fn delete_removes_only_that_id() {
        let mut c = vec![json!({"id":"a"}), json!({"id":"b"})];
        apply_op(&mut c, ChartOp::Delete("a".into())).unwrap();
        assert_eq!(ids(&c), ["b"]);
        apply_op(&mut c, ChartOp::Delete("zzz".into())).unwrap();
        assert_eq!(ids(&c), ["b"]);
    }

    #[test]
    fn reorder_keeps_charts_not_listed() {
        let mut c = vec![json!({"id":"a"}), json!({"id":"b"}), json!({"id":"c"}), json!({"id":"d"})];
        // d はスマホが知らない（PC が今足した）グラフ。消さずに後ろへ残す。x は無い id
        apply_op(&mut c, ChartOp::Reorder(vec!["c".into(), "x".into(), "a".into(), "b".into()])).unwrap();
        assert_eq!(ids(&c), ["c", "a", "b", "d"]);
    }
}
