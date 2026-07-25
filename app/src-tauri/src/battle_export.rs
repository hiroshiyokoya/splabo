//! battle_db エクスポート（splabo-viewer 連携・#325）。
//!
//! 直近バトルのサマリ行 + 集計を **versioned 暗号ファイル `battle_db.bin`** に書き出す。
//! - 暗号は `gear_crypto`（AES-256-GCM・共有鍵）をそのまま流用（`[nonce12][ct+tag]`）。
//! - 契約: `battle-export-v1`（トップに `{schema, version, generated_at, source_db_user_version}` を明示）。
//! - トリカラは一覧・集計とも除外（chartoon フロントと整合・#293）。
//! - win_rate の分母は decisive = total − draws（`db.rs` の定義に合わせる）。
//! - `battles[]` と `aggregates` は **同一の母集団（直近 N 戦）**（#361）。
//!   母集団は `scoped_cte()` の 1 箇所だけで定義し、一覧・集計とも同じ CTE に JOIN する。
//! - `aggregates_by_period` は **全期間 / 今シーズン / 直近 30 日 / 直近 7 日** の 4 期間分の集計
//!   （#375 で導入・#379 で「今週」「直近 N 戦」を廃してローリング期間に置き換え）。
//!   既存の `aggregates`（直近 N 戦）は**そのまま残す**（古い viewer のフォールバック先）。
//!
//! 詳細契約: リポ `docs/battle-db-contract.md`（viewer #30 と対。viewer 側にも同内容）。

use chrono::{DateTime, Datelike, Days, TimeZone, Utc};
use serde::Serialize;
use sqlx::Row;
use tauri::{AppHandle, Manager};

use crate::db::DbPool;
use crate::gear_crypto;

const SCHEMA: &str = "battle-export-v1";
const SCHEMA_VERSION: i64 = 1;
const DEFAULT_LIMIT: i64 = 50;

/// トリカラマッチ除外条件（`db_list_battles` と揃える）。
const TRIKOLOR_EXCLUDE: &str = "(json_extract(b.raw_json, '$.vsRule.rule') IS NULL \
     OR json_extract(b.raw_json, '$.vsRule.rule') <> 'TRI_COLOR')";

/// 「このバトルはトリカラではありえない」と **`raw_json` を読まずに** 判定できる条件（#375）。
///
/// `TRIKOLOR_EXCLUDE` は 1 行あたり平均 190KB の `raw_json` を `json_extract` で
/// 舐めるため、全期間ぶんの母集団を作るとこれだけで 200ms 前後かかる（実測）。
/// 下記の**事前ゲート**を OR で前置すると、大半の行で `raw_json` に触らずに済み
/// 実測 211ms → 13ms になる（同一結果）。
///
/// 根拠（トリカラ戦は必ずどちらかに当たる）:
/// - SplatNet3 取り込みではトリカラの lobby は `splatfest_open` 固定
///   （`splatnet3.rs` の FEST 分岐・移行 v18 も同じ扱い）。
/// - stat.ink 取り込みでは rule が `tricolor`（`statink.rs` の `TRI_COLOR` → `tricolor`）。
///
/// ゲートを通った行には従来どおり `TRIKOLOR_EXCLUDE` を適用するので、
/// 「フェスロビー or rule=tricolor」の行は今までと完全に同じ判定になる。
const TRIKOLOR_IMPOSSIBLE: &str =
    "(l.key NOT LIKE 'splatfest%' AND (r.key IS NULL OR r.key <> 'tricolor'))";

/// ステージ正式名 → コミュニティ通称（短縮名）。狭い viewer 画面で行が窮屈に
/// ならないよう、本体側で短縮名を解決して配信する（#368）。
///
/// 出典はフロントの `app/src/components/EnvAnalysis.tsx` の `STAGE_SHORT`。
/// **Phase 1 では TypeScript 側と同じ表を意図的に二重に持つ**（フロントを Rust 由来へ
/// 一本化するのは Phase 2 / 別 Issue）。値を変える場合は必ず両方揃えること。
const STAGE_SHORT: &[(&str, &str)] = &[
    ("ユノハナ大渓谷", "ユノハナ"),
    ("ゴンズイ地区", "ゴンズイ"),
    ("ヤガラ市場", "ヤガラ"),
    ("マテガイ放水路", "マテガイ"),
    ("ナメロウ金属", "ナメロウ"),
    ("マサバ海峡大橋", "マサバ"),
    ("キンメダイ美術館", "キンメ"),
    ("マヒマヒリゾート＆スパ", "マヒマヒ"),
    ("海女美術大学", "海女"),
    ("チョウザメ造船", "チョウザメ"),
    ("ザトウマーケット", "ザトウ"),
    ("スメーシーワールド", "スメーシー"),
    ("タラポートショッピングパーク", "タラポート"),
    ("コンブトラック", "コンブ"),
    ("マンタマリア号", "マンタ"),
    ("タカアシ経済特区", "タカアシ"),
    ("オヒョウ海運", "オヒョウ"),
    ("バイガイ亭", "バイガイ"),
    ("ネギトロ炭鉱", "ネギトロ"),
    ("カジキ空港", "カジキ"),
    ("リュウグウターミナル", "リュウグウ"),
    ("グランドバンカラアリーナ", "バンカラ"),
    ("ナンプラー遺跡", "ナンプラー"),
    ("クサヤ温泉", "クサヤ"),
    ("ヒラメが丘団地", "ヒラメ"),
    ("デカライン高架下", "デカライン"),
    ("タチウオパーキング", "タチウオ"),
];

/// ステージ正式名から短縮名を引く。**未知のステージは `None`**（空文字にしない）。
///
/// viewer 側は `null` を見て正式名（`stage_name`）へフォールバックする。新ステージ追加時に
/// 表の更新が漏れても、正式名で表示されるだけで壊れない。
fn stage_short_name(name: &str) -> Option<&'static str> {
    STAGE_SHORT
        .iter()
        .find(|(full, _)| *full == name)
        .map(|(_, short)| *short)
}

/// 直近バトルのサマリ行（viewer 表示用の軽量サブセット）。
/// `db_list_battles` の SELECT から重い列（raw_json / team / awards 等）を落としたもの。
#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct BattleExportRow {
    pub id: String,
    pub played_at: String,
    /// lobby の旧 slug（regular / bankara_open / x …）。
    pub mode: String,
    /// rule の旧 slug（area / hoko / yagura / turf_war …）。null は '' に畳む。
    pub rule: String,
    pub stage: String,
    /// ステージ正式名。**アイコン解決鍵（`sha256(表示名)`）に使うので絶対に落とさない**
    /// （splabo-viewer#35）。`stage_short_name` は置換ではなく追加。
    pub stage_name: Option<String>,
    /// ステージ短縮名（`ユノハナ大渓谷` → `ユノハナ`・#368）。
    /// SQL では引かず、取得後に `stage_name` から解決して詰める（`#[sqlx(default)]` で None 初期化）。
    /// 未知のステージ・`stage_name` が NULL の行はどちらも `null`。
    #[sqlx(default)]
    pub stage_short_name: Option<String>,
    pub weapon: String,
    /// アイコン解決鍵（`images/weapon/<sha256(name)>.gti`）に使うため name を必ず含める。
    pub weapon_name: Option<String>,
    pub result: String,
    pub knockout: Option<String>,
    pub kill: i64,
    pub assist: i64,
    pub death: i64,
    pub special: i64,
    pub inked: i64,
    pub duration: i64,
    pub x_power: Option<f64>,
    pub rank_before: Option<String>,
    pub rank_after: Option<String>,
    pub sub_weapon: Option<String>,
    pub special_weapon: Option<String>,
    /// 0 のバトルは avg_kill/avg_death 対象外（詳細未取得）。
    pub detail_fetched: i64,
}

#[derive(Debug, Serialize)]
pub struct BattleExportResult {
    pub path: String,
    pub battles: usize,
    pub generated_at: String,
}

/// PathBuf を Windows の \\?\ プレフィックスなし・スラッシュ区切りの文字列に変換。
fn path_to_slash(p: &std::path::Path) -> String {
    let s = p.to_string_lossy();
    let s = s.strip_prefix(r"\\?\").unwrap_or(&s);
    s.replace('\\', "/")
}

// ---------------------------------------------------------------------------
// 期間（#375 / #379）: シーズン境界とローリングウィンドウ
// ---------------------------------------------------------------------------

/// UTC の ISO8601（`generated_at` / `played_at` と同じ書式）に整形する。
fn iso_z(at: DateTime<Utc>) -> String {
    at.format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

/// `generated_at` 等の UTC ISO8601 をパースする（失敗時 None）。
fn parse_iso_z(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|d| d.with_timezone(&Utc))
}

/// `at` が属するスプラトゥーン3シーズンの開始時刻（UTC・inclusive）。
///
/// シーズンは **12月 / 3月 / 6月 / 9月 の各 1 日 09:00 JST** 開始の 3ヶ月区切り。
/// 09:00 JST = **00:00 UTC**（同日）なので、UTC で見ると境界はちょうど
/// 「開始月 1 日 00:00:00Z」になり、**UTC の年月だけで判定できる**（JST への変換が不要）。
///
/// 🔴 `battle` テーブルに `season` 列は無く、`env_battles.season`（stat.ink 由来）も
/// 自分のバトルには使えないため、`played_at` から計算する（#375）。
fn season_start_utc(at: DateTime<Utc>) -> DateTime<Utc> {
    // 1〜2 月は前年 12 月開始シーズンの続き（年跨ぎ）。
    let (year, month) = match at.month() {
        1 | 2 => (at.year() - 1, 12),
        3..=5 => (at.year(), 3),
        6..=8 => (at.year(), 6),
        9..=11 => (at.year(), 9),
        _ => (at.year(), 12),
    };
    Utc.with_ymd_and_hms(year, month, 1, 0, 0, 0).unwrap()
}

/// `at` が属するシーズンの終了時刻（= 次シーズンの開始時刻・UTC・**exclusive**）。
fn season_end_utc(at: DateTime<Utc>) -> DateTime<Utc> {
    let start = season_start_utc(at);
    let (year, month) = if start.month() == 12 {
        (start.year() + 1, 3)
    } else {
        (start.year(), start.month() + 3)
    };
    Utc.with_ymd_and_hms(year, month, 1, 0, 0, 0).unwrap()
}

/// ローリングウィンドウ（直近 N 日）の開始時刻 = `at` の N 日前（UTC・inclusive）。
///
/// 🔴 #375 の「今週」は**月曜起点の暦週**だったが、利用者の意図は
/// 「**直近 7 日**」だったので #379 でローリングウィンドウに変更した（#379）。
/// 暦の境界を持たないので**タイムゾーンに依存しない**（JST 換算が不要になった）。
///
/// `Days::new` は「日数」なので、うるう秒や DST ではなく素直に 24h × N 前になる
/// （UTC 固定なので DST の影響も無い）。
fn days_ago_utc(at: DateTime<Utc>, days: u64) -> DateTime<Utc> {
    at.checked_sub_days(Days::new(days))
        .expect("ローリングウィンドウの起点でオーバーフローすることは無い")
}

// ---------------------------------------------------------------------------
// 母集団スコープ
// ---------------------------------------------------------------------------

/// 期間下限の番兵（実データの `played_at` より必ず小さい ISO8601）。
/// NULL 判定の分岐を SQL から消すために使う（`played_at` は NOT NULL）。
const RANGE_MIN: &str = "0000-01-01T00:00:00Z";
/// 期間上限の番兵（実データの `played_at` より必ず大きい ISO8601）。
const RANGE_MAX: &str = "9999-12-31T23:59:59Z";

/// 集計対象になり得る全バトルの id（= トリカラ以外）を JSON 配列で保持する。
///
/// 🔴 **トリカラ判定は `raw_json` への `json_extract` で、1 行あたり平均 190KB を読む**。
/// 全期間の集計をそのまま SQL で回すとこのフルスキャンが期間 × 軸の回数だけ走り、
/// 実測で 2〜4 秒かかった（#375 の実測）。そこで **1 エクスポートにつき 1 回だけ**
/// 走査して id 集合を作り、以降の期間別クエリは `json_each()` でこの集合を使い回す
/// （`raw_json` に触らないので 1 クエリ数 ms）。
#[derive(Debug, Clone)]
struct Population(std::sync::Arc<String>);

/// トリカラ以外の全バトル id を 1 回だけ引く（`raw_json` を読むのは**ここだけ**）。
async fn population(pool: &sqlx::SqlitePool) -> Result<Population, String> {
    let sql = format!(
        "SELECT b.id AS id
         FROM battle b
         JOIN      lobby  l   ON l.id   = b.lobby_id
         JOIN      result res ON res.id = b.result_id
         JOIN      weapon w   ON w.id   = b.weapon_id
         JOIN      map    m   ON m.id   = b.map_id
         LEFT JOIN rule   r   ON r.id   = b.rule_id
         WHERE {TRIKOLOR_IMPOSSIBLE} OR {TRIKOLOR_EXCLUDE}"
    );
    let ids: Vec<String> = sqlx::query(&sql)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|r| r.try_get::<String, _>("id").unwrap_or_default())
        .collect();
    let json = serde_json::to_string(&ids).map_err(|e| e.to_string())?;
    Ok(Population(std::sync::Arc::new(json)))
}

/// 集計母集団の絞り込み条件（`scoped_cte()` の 4 バインドと 1:1）。
///
/// - 暦で切る期間（今シーズン）は `since`/`until` を実際の境界にし、`limit` は無制限。
/// - ローリング期間（直近 N 日）は `since` だけ実際の境界にし、上限は番兵。
/// - 件数で切る期間（直近 N 戦 = 既存 `aggregates`）は `since`/`until` を番兵にし、`limit` に N を入れる。
/// - 全期間は両方とも無制限。
#[derive(Debug, Clone)]
struct Scope {
    /// トリカラ除外済みの id 集合（期間をまたいで共有する）。
    pop: Population,
    /// 下限（inclusive・UTC ISO8601）。
    since: String,
    /// 上限（exclusive・UTC ISO8601）。
    until: String,
    /// 件数上限。**-1 は SQLite の `LIMIT -1` = 無制限**。
    limit: i64,
}

impl Scope {
    /// 直近 N 戦（従来の `aggregates` / `battles[]` の母集団・#361）。
    fn recent(pop: &Population, limit: i64) -> Self {
        Self {
            pop: pop.clone(),
            since: RANGE_MIN.to_string(),
            until: RANGE_MAX.to_string(),
            limit,
        }
    }

    /// 全期間（時間・件数とも無制限）。
    fn all_time(pop: &Population) -> Self {
        Self::recent(pop, -1)
    }

    /// 時間で切る期間（`since` 以上 `until` 未満・件数無制限）。
    fn range(pop: &Population, since: &str, until: &str) -> Self {
        Self {
            pop: pop.clone(),
            since: since.to_string(),
            until: until.to_string(),
            limit: -1,
        }
    }

    /// ローリング期間（直近 N 日・`since` 以降で**上限なし**・#379）。
    ///
    /// 🔴 SQL 上の上限を番兵（`RANGE_MAX`）にするのは、`generated_at` が**秒精度**に
    /// 丸められているため。`until = generated_at` の半開区間（`played_at < until`）に
    /// すると、ちょうど同じ秒に遊んだバトルが「全期間には入るのに直近 7 日には入らない」
    /// という不整合を起こす。未来のバトルは存在しないので上限を外しても結果は同じ。
    /// **配信する `until` には別途 `generated_at` を入れる**（`PeriodRange::Rolling`）。
    fn rolling(pop: &Population, since: &str) -> Self {
        Self::range(pop, since, RANGE_MAX)
    }
}

/// `battles[]` と各集計が共有する母集団（CTE）。
///
/// 抽出条件（トリカラ除外済み id 集合・必須 JOIN・期間・`played_at` 降順・件数上限）を
/// **ここ 1 箇所だけ**で定義する。集計側は独自に取り直さず、この CTE に JOIN するだけなので、
/// 一覧と集計、あるいは期間別集計どうしで母集団がズレようがない（#361 / #375）。
///
/// バインドは **ids → since → until → limit の 4 個**。この CTE を使う各クエリは
/// 先頭でこの順に 4 回 bind する（`bind_scope` を経由すること）。
fn scoped_cte() -> String {
    "WITH recent AS (
             SELECT b.id AS id
             FROM battle b
             JOIN lobby  l   ON l.id   = b.lobby_id
             JOIN result res ON res.id = b.result_id
             JOIN weapon w   ON w.id   = b.weapon_id
             JOIN map    m   ON m.id   = b.map_id
             WHERE b.id IN (SELECT value FROM json_each(?))
               AND b.played_at >= ?
               AND b.played_at <  ?
             ORDER BY b.played_at DESC
             LIMIT ?
         )"
    .to_string()
}

/// `scoped_cte()` の 4 バインドを正しい順で詰める（呼び出し側の bind 漏れ・順序違いを防ぐ）。
fn bind_scope<'q>(
    q: sqlx::query::Query<'q, sqlx::Sqlite, sqlx::sqlite::SqliteArguments<'q>>,
    scope: &'q Scope,
) -> sqlx::query::Query<'q, sqlx::Sqlite, sqlx::sqlite::SqliteArguments<'q>> {
    q.bind(scope.pop.0.as_str())
        .bind(&scope.since)
        .bind(&scope.until)
        .bind(scope.limit)
}

/// 直近 N 戦のサマリ行を引く SQL（`recent` CTE の集合そのもの）。
fn battles_sql() -> String {
    format!(
        "{cte}
         SELECT b.id AS id,
                b.played_at AS played_at,
                CASE WHEN l.key LIKE 'bankara%' THEN l.key
                     ELSE (CASE l.key WHEN 'xmatch' THEN 'x' ELSE l.key END) END AS mode,
                COALESCE(CASE r.key WHEN 'nawabari' THEN 'turf_war' ELSE r.key END, '') AS rule,
                m.key AS stage,
                m.name_ja AS stage_name,
                w.key AS weapon,
                w.name_ja AS weapon_name,
                res.key AS result,
                b.knockout AS knockout,
                b.kill AS kill,
                b.assist AS assist,
                b.death AS death,
                b.special AS special,
                b.inked AS inked,
                b.duration AS duration,
                b.x_power_after AS x_power,
                b.rank_before AS rank_before,
                b.rank_after AS rank_after,
                b.sub_weapon AS sub_weapon,
                b.special_weapon AS special_weapon,
                COALESCE(b.detail_fetched, 0) AS detail_fetched
         FROM battle b
         JOIN      recent rc  ON rc.id  = b.id
         JOIN      lobby  l   ON l.id   = b.lobby_id
         LEFT JOIN rule   r   ON r.id   = b.rule_id
         JOIN      result res ON res.id = b.result_id
         JOIN      weapon w   ON w.id   = b.weapon_id
         JOIN      map    m   ON m.id   = b.map_id
         ORDER BY b.played_at DESC",
        cte = scoped_cte()
    )
}

/// overall 集計 SQL（母集団は `recent`）。
fn overall_sql() -> String {
    format!(
        "{cte}
         SELECT COUNT(*) AS total,
                SUM(CASE WHEN res.key='win'  THEN 1 ELSE 0 END) AS wins,
                SUM(CASE WHEN res.key='draw' THEN 1 ELSE 0 END) AS draws,
                AVG(CASE WHEN b.detail_fetched=1 THEN b.kill  END) AS avg_kill,
                AVG(CASE WHEN b.detail_fetched=1 THEN b.death END) AS avg_death
         FROM battle b
         JOIN recent rc  ON rc.id  = b.id
         JOIN result res ON res.id = b.result_id",
        cte = scoped_cte()
    )
}

/// ルール別集計 SQL（母集団は `recent`）。
/// `battles[]` の `rule` 列と同じく LEFT JOIN + COALESCE なので、
/// rule 未設定のバトルも '' グループとして必ず数え上げられる（総和が overall と一致する）。
fn by_rule_sql() -> String {
    format!(
        "{cte}
         SELECT COALESCE(CASE r.key WHEN 'nawabari' THEN 'turf_war' ELSE r.key END, '') AS name,
                COUNT(*) AS total,
                SUM(CASE WHEN res.key='win'  THEN 1 ELSE 0 END) AS wins,
                SUM(CASE WHEN res.key='draw' THEN 1 ELSE 0 END) AS draws
         FROM battle b
         JOIN      recent rc  ON rc.id  = b.id
         LEFT JOIN rule   r   ON r.id   = b.rule_id
         JOIN      result res ON res.id = b.result_id
         GROUP BY name ORDER BY total DESC",
        cte = scoped_cte()
    )
}

/// ロビー別集計 SQL（母集団は `recent`）。
fn by_lobby_sql() -> String {
    format!(
        "{cte}
         SELECT (CASE WHEN l.key LIKE 'bankara%' THEN 'bankara'
                      WHEN l.key LIKE 'splatfest%' THEN 'splatfest'
                      ELSE (CASE l.key WHEN 'xmatch' THEN 'x' ELSE l.key END) END) AS name,
                COUNT(*) AS total,
                SUM(CASE WHEN res.key='win'  THEN 1 ELSE 0 END) AS wins,
                SUM(CASE WHEN res.key='draw' THEN 1 ELSE 0 END) AS draws
         FROM battle b
         JOIN recent rc  ON rc.id  = b.id
         JOIN lobby  l   ON l.id   = b.lobby_id
         JOIN result res ON res.id = b.result_id
         GROUP BY name ORDER BY total DESC",
        cte = scoped_cte()
    )
}

/// ブキ別集計 SQL（母集団は `recent`）。
///
/// `display_name`（`weapon.name_ja`）を必ず含める（#379）。viewer は
/// `battles[]`（直近 50 戦）から key → 表示名の対応表を作っていたため、
/// **50 戦に登場しないブキはアイコン（`sha256(表示名)`）を解決できなかった**。
/// `w.id` で GROUP BY しているので `w.name_ja` は関数従属（集約の曖昧さは無い）。
fn by_weapon_sql() -> String {
    format!(
        "{cte}
         SELECT w.key AS name,
                w.name_ja AS display_name,
                COUNT(*) AS total,
                SUM(CASE WHEN res.key='win'  THEN 1 ELSE 0 END) AS wins,
                SUM(CASE WHEN res.key='draw' THEN 1 ELSE 0 END) AS draws
         FROM battle b
         JOIN recent rc  ON rc.id  = b.id
         JOIN weapon w   ON w.id   = b.weapon_id
         JOIN result res ON res.id = b.result_id
         GROUP BY w.id ORDER BY total DESC",
        cte = scoped_cte()
    )
}

/// ステージ別集計 SQL（母集団は `recent`）。
///
/// `display_name`（`map.name_ja` = 正式名）を必ず含める（#379）。
/// 🔴 ブキと違い **`map.key` は数値 ID**（`1` / `10`）なので、key は表示にも
/// アイコン解決（`sha256(正式名)`）にも使えない。正式名が無いと viewer は
/// 全期間の集計でステージ名すら出せない。短縮名は取得後に Rust 側で解決する
/// （`fill_group_short_names`）。
fn by_stage_sql() -> String {
    format!(
        "{cte}
         SELECT m.key AS name,
                m.name_ja AS display_name,
                COUNT(*) AS total,
                SUM(CASE WHEN res.key='win'  THEN 1 ELSE 0 END) AS wins,
                SUM(CASE WHEN res.key='draw' THEN 1 ELSE 0 END) AS draws
         FROM battle b
         JOIN recent rc  ON rc.id  = b.id
         JOIN map    m   ON m.id   = b.map_id
         JOIN result res ON res.id = b.result_id
         GROUP BY m.id ORDER BY total DESC",
        cte = scoped_cte()
    )
}

/// 取得済みのサマリ行に短縮名を詰める（#368）。
///
/// `stage_name`（正式名）は**残したまま**の追加。`stage_name` が NULL の行、および
/// `STAGE_SHORT` に無いステージは `None` のままにする（viewer が正式名へフォールバックする）。
fn fill_stage_short_names(battles: &mut [BattleExportRow]) {
    for b in battles.iter_mut() {
        b.stage_short_name = b
            .stage_name
            .as_deref()
            .and_then(stage_short_name)
            .map(str::to_string);
    }
}

/// by_stage の各エントリに短縮名（`short_name`）を詰める（#379）。
///
/// `battles[]` 側の `fill_stage_short_names` と同じ方針:
/// **正式名（`display_name`）は残したままの追加**で、`STAGE_SHORT` に無いステージ・
/// `name_ja` が NULL のステージではフィールド自体を出さない
/// （viewer は欠落を見て正式名へフォールバックする）。
fn fill_group_short_names(groups: &mut [serde_json::Value]) {
    for g in groups.iter_mut() {
        let short = g
            .get("display_name")
            .and_then(serde_json::Value::as_str)
            .and_then(stage_short_name);
        if let (Some(short), Some(obj)) = (short, g.as_object_mut()) {
            obj.insert("short_name".into(), serde_json::json!(short));
        }
    }
}

/// グループ集計 SQL を実行し `[{key,total,wins,draws,win_rate}]` を返す。
/// SQL が `display_name` 列を返す軸（by_weapon / by_stage）では `display_name` も足す（#379）。
/// `scope` は `recent` CTE の 3 バインド（since / until / limit）に bind される。
async fn grouped(
    pool: &sqlx::SqlitePool,
    sql: &str,
    scope: &Scope,
) -> Result<Vec<serde_json::Value>, String> {
    let rows = bind_scope(sqlx::query(sql), scope)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|r| {
            let name: String = r.try_get("name").unwrap_or_default();
            let total: i64 = r.try_get("total").unwrap_or(0);
            let wins: i64 = r.try_get("wins").unwrap_or(0);
            let draws: i64 = r.try_get("draws").unwrap_or(0);
            let decisive = total - draws;
            let mut entry = serde_json::json!({
                "key": name,
                "total": total,
                "wins": wins,
                "draws": draws,
                "win_rate": if decisive > 0 { wins as f64 / decisive as f64 } else { 0.0 },
            });
            // #379: 表示名。**`display_name` 列を返す SQL（by_weapon / by_stage）だけ**が入る。
            // 列そのものが無い軸（by_rule / by_lobby）では try_get が Err、
            // `name_ja` が NULL の行では Ok(None) になり、どちらもフィールドを出さない
            // （viewer は欠落を「解決できない」と見て key へフォールバックする）。
            if let Some(display) = r.try_get::<Option<String>, _>("display_name").ok().flatten() {
                entry["display_name"] = serde_json::json!(display);
            }
            entry
        })
        .collect())
}

/// overall 集計を実行して `{total,wins,losses,draws,win_rate,avg_kill,avg_death}` を返す。
/// 0 件の期間でも `total=0 / win_rate=0.0 / avg_* = null` が返るだけで壊れない。
async fn overall(pool: &sqlx::SqlitePool, scope: &Scope) -> Result<serde_json::Value, String> {
    let row = bind_scope(sqlx::query(&overall_sql()), scope)
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;
    let total: i64 = row.try_get("total").unwrap_or(0);
    let wins: i64 = row.try_get("wins").unwrap_or(0);
    let draws: i64 = row.try_get("draws").unwrap_or(0);
    // #377: AVG() は対象行が 0 件のとき SQL の NULL を返す。
    // `try_get::<f64, _>` で受けると sqlx の f64 デコードが NULL を 0.0 に落としてしまい、
    // 「1 戦もしていない」と「本当に平均 0 キル」が区別できなくなる。
    // 明示的に `Option<f64>` としてデコードして NULL を null のまま配信する。
    // （detail_fetched=0 のバトルしか無い場合も AVG は NULL になるので同じ経路で救われる）
    let avg_kill: Option<f64> = row.try_get::<Option<f64>, _>("avg_kill").unwrap_or(None);
    let avg_death: Option<f64> = row.try_get::<Option<f64>, _>("avg_death").unwrap_or(None);
    let decisive = total - draws;
    Ok(serde_json::json!({
        "total": total,
        "wins": wins,
        "losses": decisive - wins,
        "draws": draws,
        "win_rate": if decisive > 0 { wins as f64 / decisive as f64 } else { 0.0 },
        "avg_kill": avg_kill,
        "avg_death": avg_death,
    }))
}

/// 1 期間分の集計（`overall` + 4 軸のグループ集計）を組み立てる。
/// 形は既存 `aggregates` と完全に同じ（viewer は同じ描画コードを使い回せる）。
async fn aggregates_for(
    pool: &sqlx::SqlitePool,
    scope: &Scope,
) -> Result<serde_json::Value, String> {
    // by_stage だけ短縮名を後段で詰める（#379・SQL では正式名まで）。
    let mut by_stage = grouped(pool, &by_stage_sql(), scope).await?;
    fill_group_short_names(&mut by_stage);
    Ok(serde_json::json!({
        "overall":   overall(pool, scope).await?,
        "by_rule":   grouped(pool, &by_rule_sql(),   scope).await?,
        "by_lobby":  grouped(pool, &by_lobby_sql(),  scope).await?,
        "by_weapon": grouped(pool, &by_weapon_sql(), scope).await?,
        "by_stage":  by_stage,
    }))
}

/// 母集団に含まれる最古の `played_at`（0 件なら None）。
/// 暦にもローリングにも由来しない期間（= 全期間）の `since` に使う。
async fn population_since(
    pool: &sqlx::SqlitePool,
    scope: &Scope,
) -> Result<Option<String>, String> {
    let sql = format!(
        "{cte}
         SELECT MIN(b.played_at) AS since
         FROM battle b
         JOIN recent rc ON rc.id = b.id",
        cte = scoped_cte()
    );
    let row = bind_scope(sqlx::query(&sql), scope)
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(row.try_get::<Option<String>, _>("since").unwrap_or(None))
}

/// 期間別集計 1 件分の「配信する絶対範囲」の決め方（#375 / #379）。
enum PeriodRange {
    /// 暦で決まる範囲（**今シーズンのみ**）。**スコープの境界をそのまま**配信する。
    /// `until` は未来時刻になり得る。viewer は `now >= until` を見て
    /// 「この集計はもう『今シーズン』ではない」と判定できる（#367 の再生成タイミング問題対策）。
    Calendar,
    /// ローリングウィンドウ（直近 7 日 / 直近 30 日・#379）。
    /// `since` = 生成時刻 − N 日、`until` = **生成時刻**。
    ///
    /// 🔴 暦の境界が無いため `until` は常に「今」であり、**`now >= until` は生成直後から
    /// 常に真**になる。つまり Calendar 期間で使えた陳腐化判定はローリング期間では
    /// 機能しない。本体は実際の絶対時刻を正しく入れるまでを担当し、
    /// 陳腐化の判定方法は viewer 側で決める（splabo-viewer#97 系）。
    Rolling,
    /// データで決まる範囲（**全期間のみ**）。暦の境界が無いので
    /// `since` = 母集団の最古 `played_at`（0 件なら null）、`until` = 生成時刻とする。
    Data,
}

/// ローリング期間の定義（配信キー, 日数）。#379 で「今週」「直近 N 戦」を置き換えたもの。
const ROLLING_PERIODS: &[(&str, u64)] = &[("last_30d", 30), ("last_7d", 7)];

/// 期間別集計（`aggregates_by_period`）を組み立てる。
///
/// 期間は **全期間 / 今シーズン / 直近 30 日 / 直近 7 日** の 4 つ（#379）。
/// 「直近 N 戦」は期間の選択肢から外れたが、**既存 `aggregates`（直近 N 戦）は
/// そのまま残す**（履歴リストとの整合・古い viewer のフォールバック先）。
async fn aggregates_by_period(
    pool: &sqlx::SqlitePool,
    pop: &Population,
    now: DateTime<Utc>,
    generated_at: &str,
) -> Result<serde_json::Value, String> {
    let mut specs: Vec<(&str, Scope, PeriodRange)> = vec![
        ("all_time", Scope::all_time(pop), PeriodRange::Data),
        (
            "season",
            Scope::range(
                pop,
                &iso_z(season_start_utc(now)),
                &iso_z(season_end_utc(now)),
            ),
            PeriodRange::Calendar,
        ),
    ];
    for (key, days) in ROLLING_PERIODS {
        specs.push((
            key,
            Scope::rolling(pop, &iso_z(days_ago_utc(now, *days))),
            PeriodRange::Rolling,
        ));
    }

    let mut out = serde_json::Map::new();
    for (key, scope, range) in specs {
        let stats = aggregates_for(pool, &scope).await?;
        let (since, until) = match range {
            PeriodRange::Calendar => (Some(scope.since.clone()), scope.until.clone()),
            PeriodRange::Rolling => (Some(scope.since.clone()), generated_at.to_string()),
            PeriodRange::Data => (
                population_since(pool, &scope).await?,
                generated_at.to_string(),
            ),
        };
        let mut entry = serde_json::Map::new();
        entry.insert("since".into(), serde_json::json!(since));
        entry.insert("until".into(), serde_json::json!(until));
        if let Some(obj) = stats.as_object() {
            for (k, v) in obj {
                entry.insert(k.clone(), v.clone());
            }
        }
        out.insert(key.to_string(), serde_json::Value::Object(entry));
    }
    Ok(serde_json::Value::Object(out))
}

/// 直近バトルのサマリ行 + 集計を暗号化して `battle_db.bin` に書き出す。
///
/// viewer は同期でこのファイルを引き、`gear_crypto` と同一方式で復号する。
#[tauri::command]
pub async fn export_battle_db(
    app: AppHandle,
    db: tauri::State<'_, DbPool>,
    limit: Option<i64>,
) -> Result<BattleExportResult, String> {
    let pool = db.as_ref();
    let limit = limit.unwrap_or(DEFAULT_LIMIT);

    // --- 母集団（トリカラ除外）を 1 回だけ確定させる ---
    // raw_json を読むのはここだけ。以降の一覧・集計は全期間ぶんでもこの id 集合を使い回す。
    let pop = population(pool).await?;
    let recent = Scope::recent(&pop, limit);

    // --- 直近サマリ行（母集団 = recent CTE。#375 でも件数は据え置き） ---
    let mut battles = sqlx::query_as::<_, BattleExportRow>(&battles_sql())
        .bind(recent.pop.0.as_str())
        .bind(&recent.since)
        .bind(&recent.until)
        .bind(recent.limit)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;

    fill_stage_short_names(&mut battles);

    // --- 集計（母集団は battles[] と同一の直近 N 戦・トリカラ除外） ---
    let aggregates = aggregates_for(pool, &recent).await?;

    // --- メタ（生成時刻 UTC ISO8601・スキーマバージョン） ---
    let generated_at: String = sqlx::query("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now') AS now")
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?
        .try_get("now")
        .unwrap_or_default();
    let user_version: i64 = sqlx::query("PRAGMA user_version")
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?
        .try_get(0)
        .unwrap_or(0);

    // --- 期間別集計（#375 / #379・全期間 / 今シーズン / 直近 30 日 / 直近 7 日） ---
    // 「今」は generated_at と同じ時刻を使う（配信する範囲とメタがズレないように）。
    let now = parse_iso_z(&generated_at).unwrap_or_else(Utc::now);
    let by_period = aggregates_by_period(pool, &pop, now, &generated_at).await?;

    // --- エンベロープ構築 → 暗号化 → 書き出し ---
    let envelope = serde_json::json!({
        "schema": SCHEMA,
        "version": SCHEMA_VERSION,
        "generated_at": generated_at,
        "source_db_user_version": user_version,
        "battles": battles,
        // 既存フィールド（直近 N 戦）。**後方互換のため母集団も形もそのまま維持する**
        //（#379 で by_weapon / by_stage に表示名が増えるのは追加のみ）。
        "aggregates": aggregates,
        // 追加フィールド（#375 / #379）。各期間に since / until（絶対時刻）を含む。
        "aggregates_by_period": by_period,
    });

    let json = serde_json::to_vec(&envelope).map_err(|e| e.to_string())?;
    let encrypted = gear_crypto::encrypt_db(&json)?;

    let out_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("アプリデータディレクトリ解決失敗: {e}"))?
        .join("data");
    std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
    let bin_path = out_dir.join("battle_db.bin");
    std::fs::write(&bin_path, &encrypted).map_err(|e| e.to_string())?;

    log::info!(
        "[battle_export] {} 戦を書き出し → {}",
        battles.len(),
        path_to_slash(&bin_path)
    );

    Ok(BattleExportResult {
        path: path_to_slash(&bin_path),
        battles: battles.len(),
        generated_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 1 期間分の集計（`aggregates` / 各 `aggregates_by_period.*` で共通の形）。
    ///
    /// フィクスチャの 2 戦はどの期間にも入るので、期間ごとの中身は同じで良い。
    /// **`by_weapon` / `by_stage` には表示名が入る**（#379）:
    /// - `display_name` … ブキ名 / ステージ正式名（アイコン解決鍵 `sha256(表示名)`）
    /// - `short_name`   … ステージ短縮名（by_stage のみ・未知ステージでは出ない）
    fn sample_stats() -> serde_json::Value {
        serde_json::json!({
            "overall": { "total": 2, "wins": 1, "losses": 1, "draws": 0,
                         "win_rate": 0.5, "avg_kill": 7.0, "avg_death": 6.0 },
            "by_rule": [
                { "key": "area", "total": 1, "wins": 1, "draws": 0, "win_rate": 1.0 },
                { "key": "turf_war", "total": 1, "wins": 0, "draws": 0, "win_rate": 0.0 }
            ],
            "by_lobby": [
                { "key": "bankara", "total": 1, "wins": 1, "draws": 0, "win_rate": 1.0 },
                { "key": "regular", "total": 1, "wins": 0, "draws": 0, "win_rate": 0.0 }
            ],
            "by_weapon": [
                { "key": "splattershot", "display_name": "スプラシューター",
                  "total": 1, "wins": 1, "draws": 0, "win_rate": 1.0 },
                { "key": "wakaba", "display_name": "わかばシューター",
                  "total": 1, "wins": 0, "draws": 0, "win_rate": 0.0 }
            ],
            "by_stage": [
                { "key": "yunohana", "display_name": "ユノハナ大渓谷", "short_name": "ユノハナ",
                  "total": 1, "wins": 1, "draws": 0, "win_rate": 1.0 },
                { "key": "gonzui", "display_name": "ゴンズイ地区", "short_name": "ゴンズイ",
                  "total": 1, "wins": 0, "draws": 0, "win_rate": 0.0 }
            ]
        })
    }

    /// 期間別集計 1 件分（`sample_stats()` + `since` / `until`）。
    fn sample_period(since: serde_json::Value, until: &str) -> serde_json::Value {
        let mut v = sample_stats();
        let obj = v.as_object_mut().unwrap();
        obj.insert("since".into(), since);
        obj.insert("until".into(), serde_json::json!(until));
        v
    }

    /// battle-export-v1 の代表的なエンベロープ（viewer 契約テスト用フィクスチャの元）。
    fn sample_envelope() -> serde_json::Value {
        serde_json::json!({
            "schema": SCHEMA,
            "version": SCHEMA_VERSION,
            "generated_at": "2026-07-15T12:00:00Z",
            "source_db_user_version": 19,
            "battles": [
                {
                    "id": "b1", "played_at": "2026-07-15T11:30:00Z", "mode": "bankara_challenge",
                    "rule": "area", "stage": "yunohana", "stage_name": "ユノハナ大渓谷",
                    "stage_short_name": "ユノハナ",
                    "weapon": "splattershot", "weapon_name": "スプラシューター", "result": "win",
                    "knockout": null, "kill": 9, "assist": 2, "death": 4, "special": 3,
                    "inked": 1200, "duration": 300, "x_power": null,
                    "rank_before": "S+0", "rank_after": "S+0",
                    "sub_weapon": "splat_bomb", "special_weapon": "trizooka", "detail_fetched": 1
                },
                {
                    "id": "b2", "played_at": "2026-07-15T11:10:00Z", "mode": "regular",
                    "rule": "turf_war", "stage": "gonzui", "stage_name": "ゴンズイ地区",
                    "stage_short_name": "ゴンズイ",
                    "weapon": "wakaba", "weapon_name": "わかばシューター", "result": "lose",
                    "knockout": null, "kill": 5, "assist": 1, "death": 8, "special": 2,
                    "inked": 900, "duration": 180, "x_power": null,
                    "rank_before": null, "rank_after": null,
                    "sub_weapon": "splash_wall", "special_weapon": "big_bubbler", "detail_fetched": 1
                }
            ],
            "aggregates": sample_stats(),
            // #375 / #379: 期間別集計。既存 `aggregates` と同じ形 + since/until（絶対時刻）。
            // - all_time          … since = 母集団の最古 played_at（0 件なら null）、until = generated_at
            // - season            … 暦上の境界（until は未来時刻になり得る）
            // - last_30d / last_7d … since = generated_at − N 日、until = generated_at（ローリング）
            "aggregates_by_period": {
                "all_time": sample_period(
                    serde_json::json!("2026-07-15T11:10:00Z"), "2026-07-15T12:00:00Z"),
                "season": sample_period(
                    serde_json::json!("2026-06-01T00:00:00Z"), "2026-09-01T00:00:00Z"),
                "last_30d": sample_period(
                    serde_json::json!("2026-06-15T12:00:00Z"), "2026-07-15T12:00:00Z"),
                "last_7d": sample_period(
                    serde_json::json!("2026-07-08T12:00:00Z"), "2026-07-15T12:00:00Z"),
            }
        })
    }

    /// gear_crypto を流用した暗号ラウンドトリップ + 契約スキーマの検証。
    /// あわせて viewer #30 が読む共有フィクスチャ（平文 JSON + 暗号 bin）を tests/fixtures に生成する。
    #[test]
    fn roundtrip_and_write_fixture() {
        let env = sample_envelope();
        let plaintext = serde_json::to_vec(&env).unwrap();
        let encrypted = gear_crypto::encrypt_db(&plaintext).unwrap();
        let decrypted = gear_crypto::decrypt_db(&encrypted).unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&decrypted).unwrap();

        assert_eq!(parsed["schema"], "battle-export-v1");
        assert_eq!(parsed["version"], 1);
        assert_eq!(parsed["battles"].as_array().unwrap().len(), 2);
        assert_eq!(parsed["battles"][0]["result"], "win");
        // #368: 短縮名は正式名と**併存**する（置換ではない）。
        assert_eq!(parsed["battles"][0]["stage_name"], "ユノハナ大渓谷");
        assert_eq!(parsed["battles"][0]["stage_short_name"], "ユノハナ");
        assert_eq!(parsed["aggregates"]["overall"]["win_rate"], 0.5);
        // by_stage は by_rule 等と同じ GroupStat 形（key/total/wins/draws/win_rate）で入る。
        let by_stage = parsed["aggregates"]["by_stage"].as_array().unwrap();
        assert_eq!(by_stage.len(), 2);
        assert_eq!(by_stage[0]["key"], "yunohana");
        assert_eq!(by_stage[0]["win_rate"], 1.0);
        assert_eq!(by_stage[1]["key"], "gonzui");
        assert_eq!(by_stage[1]["win_rate"], 0.0);
        // #379: 既存 aggregates 側の by_stage / by_weapon にも表示名が入る
        //（期間別だけに入れると viewer が期間を切り替えたとき名前が出たり消えたりする）。
        assert_eq!(by_stage[0]["display_name"], "ユノハナ大渓谷");
        assert_eq!(by_stage[0]["short_name"], "ユノハナ");
        let by_weapon = parsed["aggregates"]["by_weapon"].as_array().unwrap();
        assert_eq!(by_weapon[0]["display_name"], "スプラシューター");
        // by_rule / by_lobby は viewer が固有の表示名テーブルを持つので表示名を持たない。
        assert!(parsed["aggregates"]["by_rule"][0].get("display_name").is_none());

        // #375 / #379: 期間別集計。4 期間が揃い、各期間が既存 aggregates と同じ形 + since/until を持つ。
        let periods = parsed["aggregates_by_period"].as_object().unwrap();
        assert_eq!(periods.len(), 4);
        for key in ["all_time", "season", "last_30d", "last_7d"] {
            let p = &parsed["aggregates_by_period"][key];
            assert!(p["since"].is_string() || p["since"].is_null(), "{key}.since");
            assert!(p["until"].is_string(), "{key}.until は必ず入る");
            assert!(p["overall"]["total"].is_i64(), "{key}.overall");
            for axis in ["by_rule", "by_lobby", "by_weapon", "by_stage"] {
                assert!(p[axis].is_array(), "{key}.{axis}");
            }
            // #379: どの期間でも by_weapon / by_stage に表示名が入る。
            assert_eq!(p["by_weapon"][0]["display_name"], "スプラシューター", "{key}");
            assert_eq!(p["by_stage"][0]["display_name"], "ユノハナ大渓谷", "{key}");
        }
        // 暦で決まる期間（今シーズン）は境界そのもの。
        assert_eq!(
            parsed["aggregates_by_period"]["season"]["since"],
            "2026-06-01T00:00:00Z"
        );
        // ローリング期間の until は生成時刻（= 未来にならない・#379）。
        assert_eq!(
            parsed["aggregates_by_period"]["last_7d"]["until"],
            "2026-07-15T12:00:00Z"
        );
        assert_eq!(
            parsed["aggregates_by_period"]["last_7d"]["since"],
            "2026-07-08T12:00:00Z"
        );
        // 既存 aggregates は従来どおり since/until を持たない（後方互換）。
        assert!(parsed["aggregates"].get("since").is_none());

        // 共有フィクスチャ生成（平文は決定的なので毎回上書き・暗号は nonce が乱数なので未存在時のみ）。
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("battle_db_v1.json"),
            serde_json::to_vec_pretty(&env).unwrap(),
        )
        .unwrap();
        let bin = dir.join("battle_db_v1.bin");
        if !bin.exists() {
            std::fs::write(&bin, &encrypted).unwrap();
        }
    }

    /// 非トリカラの raw_json（json_extract('$.vsRule.rule') = NULL → 集計対象）。
    const NON_TRI: &str = "{}";
    /// トリカラの raw_json（TRIKOLOR_EXCLUDE で除外される）。
    const TRI: &str = r#"{"vsRule":{"rule":"TRI_COLOR"}}"#;

    /// 本番 SQL が参照する最小スキーマを持つ in-memory SQLite を用意する。
    async fn test_pool() -> sqlx::SqlitePool {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();

        sqlx::query(
            "CREATE TABLE map    (id INTEGER PRIMARY KEY, key TEXT, name_ja TEXT);
             CREATE TABLE result (id INTEGER PRIMARY KEY, key TEXT);
             CREATE TABLE lobby  (id INTEGER PRIMARY KEY, key TEXT);
             CREATE TABLE weapon (id INTEGER PRIMARY KEY, key TEXT, name_ja TEXT);
             CREATE TABLE rule   (id INTEGER PRIMARY KEY, key TEXT);
             CREATE TABLE battle (
                 id TEXT PRIMARY KEY, played_at TEXT,
                 map_id INTEGER, result_id INTEGER, lobby_id INTEGER,
                 weapon_id INTEGER, rule_id INTEGER,
                 kill INTEGER DEFAULT 0, death INTEGER DEFAULT 0,
                 assist INTEGER DEFAULT 0, special INTEGER DEFAULT 0,
                 inked INTEGER DEFAULT 0, duration INTEGER DEFAULT 0,
                 knockout TEXT, x_power_after REAL,
                 rank_before TEXT, rank_after TEXT,
                 sub_weapon TEXT, special_weapon TEXT,
                 detail_fetched INTEGER DEFAULT 1, raw_json TEXT);
             INSERT INTO map    (id, key, name_ja) VALUES (1,'yunohana','ユノハナ'), (2,'gonzui','ゴンズイ');
             INSERT INTO result (id, key) VALUES (1,'win'), (2,'lose'), (3,'draw');
             INSERT INTO lobby  (id, key) VALUES (1,'regular'), (2,'bankara_challenge'), (3,'splatfest_open');
             INSERT INTO weapon (id, key, name_ja) VALUES (1,'splattershot','スシ'), (2,'wakaba','わかば');
             INSERT INTO rule   (id, key) VALUES (1,'area'), (2,'nawabari'), (3,'tricolor');",
        )
        .execute(&pool)
        .await
        .unwrap();

        pool
    }

    /// バトルを 1 件挿入する。`played_at` は連番から生成（大きい seq ほど新しい）。
    #[allow(clippy::too_many_arguments)]
    async fn insert_battle(
        pool: &sqlx::SqlitePool,
        id: &str,
        seq: i64,
        map_id: i64,
        result_id: i64,
        lobby_id: i64,
        weapon_id: i64,
        rule_id: Option<i64>,
        raw: &str,
    ) {
        let played_at = format!("2026-07-15T{:02}:{:02}:00Z", seq / 60, seq % 60);
        insert_battle_at(
            pool, id, &played_at, map_id, result_id, lobby_id, weapon_id, rule_id, raw,
        )
        .await;
    }

    /// バトルを 1 件挿入する（`played_at` を明示・#375 の期間テスト用）。
    #[allow(clippy::too_many_arguments)]
    async fn insert_battle_at(
        pool: &sqlx::SqlitePool,
        id: &str,
        played_at: &str,
        map_id: i64,
        result_id: i64,
        lobby_id: i64,
        weapon_id: i64,
        rule_id: Option<i64>,
        raw: &str,
    ) {
        sqlx::query(
            "INSERT INTO battle (id, played_at, map_id, result_id, lobby_id, weapon_id, rule_id, kill, death, detail_fetched, raw_json)
             VALUES (?,?,?,?,?,?,?,3,2,1,?)",
        )
        .bind(id)
        .bind(played_at)
        .bind(map_id)
        .bind(result_id)
        .bind(lobby_id)
        .bind(weapon_id)
        .bind(rule_id)
        .bind(raw)
        .execute(pool)
        .await
        .unwrap();
    }

    /// 詳細未取得（`detail_fetched=0`）のバトルを 1 件挿入する（#377）。
    /// kill/death には値が入っているが AVG の母数からは除外される。
    async fn insert_battle_undetailed(pool: &sqlx::SqlitePool, id: &str, played_at: &str) {
        sqlx::query(
            "INSERT INTO battle (id, played_at, map_id, result_id, lobby_id, weapon_id, rule_id, kill, death, detail_fetched, raw_json)
             VALUES (?,?,1,1,1,1,1,9,9,0,?)",
        )
        .bind(id)
        .bind(played_at)
        .bind(NON_TRI)
        .execute(pool)
        .await
        .unwrap();
    }

    /// overall 集計を実行して (total, wins, draws) を返す。
    async fn overall_totals(pool: &sqlx::SqlitePool, limit: i64) -> (i64, i64, i64) {
        let pop = population(pool).await.unwrap();
        let v = overall(pool, &Scope::recent(&pop, limit)).await.unwrap();
        (
            v["total"].as_i64().unwrap(),
            v["wins"].as_i64().unwrap(),
            v["draws"].as_i64().unwrap(),
        )
    }

    /// グループ集計の total 合計。
    fn sum_total(groups: &[serde_json::Value]) -> i64 {
        groups.iter().map(|g| g["total"].as_i64().unwrap()).sum()
    }

    /// 合成データを in-memory SQLite に投入し、by_stage 集計 SQL が
    /// ステージ別の total / wins / draws / win_rate を正しく出すことを検証する。
    /// - win_rate の分母は decisive = total − draws（overall と揃える）。
    /// - TRI_COLOR のバトルは TRIKOLOR_EXCLUDE で除外されることも確認する。
    #[tokio::test]
    async fn by_stage_win_rates() {
        let pool = test_pool().await;

        // yunohana: win, win, lose        → total 3, wins 2, draws 0, decisive 3, win_rate 2/3
        // gonzui:   win, draw             → total 2, wins 1, draws 1, decisive 1, win_rate 1.0
        // yunohana の TRI_COLOR 1 件は除外され、上記の集計に影響しない。
        let rows: &[(&str, i64, i64, &str)] = &[
            ("y1", 1, 1, NON_TRI),
            ("y2", 1, 1, NON_TRI),
            ("y3", 1, 2, NON_TRI),
            ("g1", 2, 1, NON_TRI),
            ("g2", 2, 3, NON_TRI),
            ("t1", 1, 1, TRI),
        ];
        for (i, (id, map_id, result_id, raw)) in rows.iter().enumerate() {
            // トリカラは実データ同様フェスロビー（splatfest_open）に置く。
            let lobby = if *raw == TRI { 3 } else { 1 };
            insert_battle(&pool, id, i as i64, *map_id, *result_id, lobby, 1, Some(1), raw).await;
        }

        // 本番と同一の by_stage SQL（母集団は十分大きい limit なので全 5 件が対象）。
        let pop = population(&pool).await.unwrap();
        let by_stage = grouped(&pool, &by_stage_sql(), &Scope::recent(&pop, 100))
            .await
            .unwrap();

        assert_eq!(by_stage.len(), 2);

        let yunohana = &by_stage[0];
        assert_eq!(yunohana["key"], "yunohana");
        assert_eq!(yunohana["total"], 3);
        assert_eq!(yunohana["wins"], 2);
        assert_eq!(yunohana["draws"], 0);
        assert!((yunohana["win_rate"].as_f64().unwrap() - 2.0 / 3.0).abs() < 1e-9);

        let gonzui = &by_stage[1];
        assert_eq!(gonzui["key"], "gonzui");
        assert_eq!(gonzui["total"], 2);
        assert_eq!(gonzui["wins"], 1);
        assert_eq!(gonzui["draws"], 1);
        // 分母は decisive = total − draws = 1 なので win_rate = 1.0（引き分けを除外）。
        assert_eq!(gonzui["win_rate"], 1.0);
    }

    /// #361: 50 戦を超えるデータでも aggregates の母集団は直近 50 戦に収まる。
    /// - overall.total == 50（51 以上にならない）
    /// - by_rule / by_weapon / by_stage / by_lobby の total 合計が overall と一致する
    /// - battles[] の件数とも一致する（一覧と集計が同じ母集団）
    #[tokio::test]
    async fn aggregates_scoped_to_recent_limit() {
        let pool = test_pool().await;

        // 120 戦（+ トリカラ 5 戦）を投入。ステージ/ブキ/ルール/ロビーはばらけさせる。
        for i in 0..120i64 {
            insert_battle(
                &pool,
                &format!("b{i}"),
                i,
                (i % 2) + 1,
                (i % 3) + 1,
                (i % 2) + 1,
                (i % 2) + 1,
                Some((i % 2) + 1),
                NON_TRI,
            )
            .await;
        }
        for i in 0..5i64 {
            // played_at が最新側に来るトリカラ（除外されないと直近 50 に混入する）。
            insert_battle(&pool, &format!("t{i}"), 200 + i, 1, 1, 3, 1, Some(1), TRI).await;
        }

        let limit = DEFAULT_LIMIT;

        let battles = sqlx::query_as::<_, BattleExportRow>(&battles_sql())
            .bind(population(&pool).await.unwrap().0.as_str())
            .bind(RANGE_MIN)
            .bind(RANGE_MAX)
            .bind(limit)
            .fetch_all(&pool)
            .await
            .unwrap();
        assert_eq!(battles.len(), 50, "battles[] は直近 50 戦");

        let (total, _wins, _draws) = overall_totals(&pool, limit).await;
        assert_eq!(total, 50, "overall も直近 50 戦（全期間の 120 にならない）");

        for (label, sql) in [
            ("by_rule", by_rule_sql()),
            ("by_lobby", by_lobby_sql()),
            ("by_weapon", by_weapon_sql()),
            ("by_stage", by_stage_sql()),
        ] {
            let pop = population(&pool).await.unwrap();
            let groups = grouped(&pool, &sql, &Scope::recent(&pop, limit)).await.unwrap();
            assert_eq!(
                sum_total(&groups),
                total,
                "{label} の total 合計は overall と一致する（母集団が同一）"
            );
        }

        // 直近 50 戦なので、最新の非トリカラ b119..b70 が入っているはず。
        assert_eq!(battles[0].id, "b119");
        assert_eq!(battles[49].id, "b70");
    }

    /// #361: 50 戦未満でも壊れない（10 戦なら overall.total は 10）。
    #[tokio::test]
    async fn aggregates_with_fewer_than_limit() {
        let pool = test_pool().await;

        for i in 0..10i64 {
            insert_battle(
                &pool,
                &format!("b{i}"),
                i,
                (i % 2) + 1,
                (i % 3) + 1,
                (i % 2) + 1,
                (i % 2) + 1,
                Some((i % 2) + 1),
                NON_TRI,
            )
            .await;
        }

        let limit = DEFAULT_LIMIT;
        let (total, _wins, _draws) = overall_totals(&pool, limit).await;
        assert_eq!(total, 10);

        for (label, sql) in [
            ("by_rule", by_rule_sql()),
            ("by_lobby", by_lobby_sql()),
            ("by_weapon", by_weapon_sql()),
            ("by_stage", by_stage_sql()),
        ] {
            let pop = population(&pool).await.unwrap();
            let groups = grouped(&pool, &sql, &Scope::recent(&pop, limit)).await.unwrap();
            assert_eq!(sum_total(&groups), 10, "{label} の total 合計");
        }
    }

    /// #361: rule 未設定（rule_id NULL）のバトルも by_rule で '' グループとして数えられ、
    /// overall との総和一致が崩れないこと（battles[] の LEFT JOIN と揃える）。
    #[tokio::test]
    async fn by_rule_includes_null_rule() {
        let pool = test_pool().await;

        insert_battle(&pool, "r1", 1, 1, 1, 1, 1, Some(1), NON_TRI).await;
        insert_battle(&pool, "r2", 2, 1, 2, 1, 1, None, NON_TRI).await;

        let limit = DEFAULT_LIMIT;
        let (total, _, _) = overall_totals(&pool, limit).await;
        assert_eq!(total, 2);

        let pop = population(&pool).await.unwrap();
        let by_rule = grouped(&pool, &by_rule_sql(), &Scope::recent(&pop, limit))
            .await
            .unwrap();
        assert_eq!(sum_total(&by_rule), 2);
        assert!(
            by_rule.iter().any(|g| g["key"] == ""),
            "rule 未設定は '' グループになる"
        );
    }

    // -----------------------------------------------------------------------
    // #368: ステージ短縮名
    // -----------------------------------------------------------------------

    /// 既知のステージが正しく短縮名に写ること（代表数件）。
    #[test]
    fn stage_short_name_maps_known_stages() {
        assert_eq!(stage_short_name("ユノハナ大渓谷"), Some("ユノハナ"));
        assert_eq!(stage_short_name("マヒマヒリゾート＆スパ"), Some("マヒマヒ"));
        assert_eq!(stage_short_name("グランドバンカラアリーナ"), Some("バンカラ"));
        assert_eq!(stage_short_name("海女美術大学"), Some("海女"));
        assert_eq!(stage_short_name("タチウオパーキング"), Some("タチウオ"));
    }

    /// 未知のステージ名は `None`（panic もデフォルト文字列も返さない）。
    #[test]
    fn stage_short_name_unknown_is_none() {
        assert_eq!(stage_short_name("まだ無いステージ"), None);
        assert_eq!(stage_short_name(""), None);
        // 部分一致で誤ヒットしない（完全一致のみ）。
        assert_eq!(stage_short_name("ユノハナ"), None);
        assert_eq!(stage_short_name("ユノハナ大渓谷 "), None);
    }

    /// フロント（EnvAnalysis.tsx の STAGE_SHORT）から移植した 27 エントリが全て引けること。
    /// 移植漏れ・キー重複を検出する。
    #[test]
    fn stage_short_table_is_complete() {
        assert_eq!(STAGE_SHORT.len(), 27, "移植元 STAGE_SHORT は 27 エントリ");

        let keys: std::collections::HashSet<&str> = STAGE_SHORT.iter().map(|(k, _)| *k).collect();
        assert_eq!(keys.len(), 27, "正式名キーに重複が無い");

        for (full, short) in STAGE_SHORT {
            assert_eq!(stage_short_name(full), Some(*short), "{full} が引けない");
            assert!(!short.is_empty(), "{full} の短縮名が空");
        }
    }

    /// 実際の battles[] パイプラインで、
    /// - 既知ステージに短縮名が入る
    /// - 未知ステージは `stage_short_name` が None
    /// - **全行で `stage_name`（正式名）が従来どおり保持される**（アイコン解決の回帰防止）
    /// - `stage_name` が NULL の行でも壊れない
    #[tokio::test]
    async fn battles_carry_stage_short_name_without_losing_stage_name() {
        let pool = test_pool().await;

        // test_pool の map は短縮対象外の name_ja（'ユノハナ' 等）なので、
        // 正式名 / 未知名 / NULL の 3 パターンを足す。
        sqlx::query(
            "UPDATE map SET name_ja = 'ユノハナ大渓谷' WHERE id = 1;
             UPDATE map SET name_ja = 'マヒマヒリゾート＆スパ' WHERE id = 2;
             INSERT INTO map (id, key, name_ja) VALUES (3,'mirai','未来ステージ'), (4,'noname', NULL);",
        )
        .execute(&pool)
        .await
        .unwrap();

        for (i, map_id) in [1i64, 2, 3, 4].iter().enumerate() {
            insert_battle(
                &pool,
                &format!("s{i}"),
                i as i64,
                *map_id,
                1,
                1,
                1,
                Some(1),
                NON_TRI,
            )
            .await;
        }

        let mut battles = sqlx::query_as::<_, BattleExportRow>(&battles_sql())
            .bind(population(&pool).await.unwrap().0.as_str())
            .bind(RANGE_MIN)
            .bind(RANGE_MAX)
            .bind(DEFAULT_LIMIT)
            .fetch_all(&pool)
            .await
            .unwrap();
        // SQL 段階では未設定（#[sqlx(default)] で None）。
        assert!(battles.iter().all(|b| b.stage_short_name.is_none()));

        fill_stage_short_names(&mut battles);
        assert_eq!(battles.len(), 4);

        let by_id = |id: &str| battles.iter().find(|b| b.id == id).unwrap();

        // 既知ステージ → 短縮名が入り、正式名もそのまま残る。
        let s0 = by_id("s0");
        assert_eq!(s0.stage_name.as_deref(), Some("ユノハナ大渓谷"));
        assert_eq!(s0.stage_short_name.as_deref(), Some("ユノハナ"));

        let s1 = by_id("s1");
        assert_eq!(s1.stage_name.as_deref(), Some("マヒマヒリゾート＆スパ"));
        assert_eq!(s1.stage_short_name.as_deref(), Some("マヒマヒ"));

        // 未知ステージ → 短縮名は None。正式名は保持（viewer が正式名で表示できる）。
        let s2 = by_id("s2");
        assert_eq!(s2.stage_name.as_deref(), Some("未来ステージ"));
        assert_eq!(s2.stage_short_name, None, "未知ステージは null");

        // stage_name が NULL の行でも panic せず、短縮名も None。
        let s3 = by_id("s3");
        assert_eq!(s3.stage_name, None);
        assert_eq!(s3.stage_short_name, None);

        // アイコン解決（sha256(stage_name)）の回帰防止:
        // name_ja がある行では stage_name が必ず非 None かつ非空で残っていること。
        for b in battles.iter().filter(|b| b.id != "s3") {
            let name = b
                .stage_name
                .as_deref()
                .unwrap_or_else(|| panic!("{}: stage_name が落ちている", b.id));
            assert!(!name.is_empty(), "{}: stage_name が空", b.id);
        }
    }

    /// 短縮名の追加は JSON 上でも **`stage_name` の置換にならない**こと
    /// （viewer のアイコン解決は sha256(stage_name) に依存する・splabo-viewer#35）。
    #[test]
    fn serialized_row_keeps_both_stage_fields() {
        let mut battles = vec![BattleExportRow {
            id: "x".into(),
            played_at: "2026-07-15T00:00:00Z".into(),
            mode: "regular".into(),
            rule: "turf_war".into(),
            stage: "yunohana".into(),
            stage_name: Some("ユノハナ大渓谷".into()),
            stage_short_name: None,
            weapon: "splattershot".into(),
            weapon_name: Some("スプラシューター".into()),
            result: "win".into(),
            knockout: None,
            kill: 0,
            assist: 0,
            death: 0,
            special: 0,
            inked: 0,
            duration: 0,
            x_power: None,
            rank_before: None,
            rank_after: None,
            sub_weapon: None,
            special_weapon: None,
            detail_fetched: 1,
        }];
        fill_stage_short_names(&mut battles);

        let v = serde_json::to_value(&battles[0]).unwrap();
        assert_eq!(v["stage_name"], "ユノハナ大渓谷", "正式名は必ず残る");
        assert_eq!(v["stage_short_name"], "ユノハナ");
        assert_eq!(v["stage"], "yunohana", "slug も従来どおり");
    }

    // -----------------------------------------------------------------------
    // #375: 期間別集計（シーズン / 週の境界計算）
    // -----------------------------------------------------------------------

    /// #375: 母集団（`population`）は `TRIKOLOR_IMPOSSIBLE` の事前ゲートを挟んでも
    /// トリカラを取りこぼさない。
    /// - フェスロビー（SplatNet3 取り込みのトリカラ）→ 除外される
    /// - rule = tricolor（stat.ink 取り込みのトリカラ）→ 除外される
    /// - 非フェスロビーの通常バトルはゲートで `raw_json` を読まずに通す（従来どおり残る）
    #[tokio::test]
    async fn population_excludes_tricolor_through_the_fast_gate() {
        let pool = test_pool().await;

        // 通常バトル（ゲートで素通し）。
        insert_battle(&pool, "n1", 1, 1, 1, 1, 1, Some(1), NON_TRI).await;
        // フェスロビーのトリカラ（splatnet3.rs は lobby=splatfest_open で保存する）。
        insert_battle(&pool, "t_fest", 2, 1, 1, 3, 1, Some(1), TRI).await;
        // rule=tricolor のトリカラ（stat.ink 取り込み想定・ロビーはフェスでなくても拾う）。
        insert_battle(&pool, "t_rule", 3, 1, 1, 1, 1, Some(3), TRI).await;
        // フェスロビーだがトリカラではないバトル（ゲートは通るが除外されない）。
        insert_battle(&pool, "fest_open", 4, 1, 1, 3, 1, Some(1), NON_TRI).await;

        let pop = population(&pool).await.unwrap();
        let ids: Vec<String> = serde_json::from_str(&pop.0).unwrap();

        assert!(ids.contains(&"n1".to_string()));
        assert!(ids.contains(&"fest_open".to_string()), "フェスの通常戦は残る");
        assert!(!ids.contains(&"t_fest".to_string()), "フェスロビーのトリカラは除外");
        assert!(!ids.contains(&"t_rule".to_string()), "rule=tricolor も除外");
        assert_eq!(ids.len(), 2);
    }

    /// テスト用: UTC ISO8601 → DateTime<Utc>（不正な文字列は panic）。
    fn utc(s: &str) -> DateTime<Utc> {
        parse_iso_z(s).unwrap_or_else(|| panic!("パースできない: {s}"))
    }

    /// シーズン開始は 12/3/6/9 月 1 日 09:00 JST = **00:00 UTC**。
    /// 境界の直前・直後・ちょうどを固定する。
    #[test]
    fn season_start_boundaries() {
        // 6 月シーズン開始の 1 秒前（JST では 6/1 08:59:59 = まだ 3 月シーズン）。
        assert_eq!(
            season_start_utc(utc("2026-05-31T23:59:59Z")),
            utc("2026-03-01T00:00:00Z")
        );
        // 開始ちょうど（= 6/1 09:00 JST）から新シーズン。
        assert_eq!(
            season_start_utc(utc("2026-06-01T00:00:00Z")),
            utc("2026-06-01T00:00:00Z")
        );
        assert_eq!(
            season_start_utc(utc("2026-06-01T00:00:01Z")),
            utc("2026-06-01T00:00:00Z")
        );
        // 各シーズンの代表点。
        assert_eq!(
            season_start_utc(utc("2026-07-21T12:34:56Z")),
            utc("2026-06-01T00:00:00Z")
        );
        assert_eq!(
            season_start_utc(utc("2026-09-30T00:00:00Z")),
            utc("2026-09-01T00:00:00Z")
        );
        assert_eq!(
            season_start_utc(utc("2026-04-01T00:00:00Z")),
            utc("2026-03-01T00:00:00Z")
        );
    }

    /// 年跨ぎ（12 月開始シーズンは翌年 2 月末まで続く）。
    #[test]
    fn season_start_crosses_year_boundary() {
        assert_eq!(
            season_start_utc(utc("2025-12-01T00:00:00Z")),
            utc("2025-12-01T00:00:00Z")
        );
        // 12 月シーズン中の年末年始・翌年 1〜2 月は前年 12 月が起点。
        assert_eq!(
            season_start_utc(utc("2025-12-31T23:59:59Z")),
            utc("2025-12-01T00:00:00Z")
        );
        assert_eq!(
            season_start_utc(utc("2026-01-01T00:00:00Z")),
            utc("2025-12-01T00:00:00Z")
        );
        assert_eq!(
            season_start_utc(utc("2026-02-28T23:59:59Z")),
            utc("2025-12-01T00:00:00Z")
        );
        // 3/1 00:00Z（= 3/1 09:00 JST）で 3 月シーズンへ。
        assert_eq!(
            season_start_utc(utc("2026-03-01T00:00:00Z")),
            utc("2026-03-01T00:00:00Z")
        );
        // 12 月開始の 1 秒前は 9 月シーズン。
        assert_eq!(
            season_start_utc(utc("2025-11-30T23:59:59Z")),
            utc("2025-09-01T00:00:00Z")
        );
    }

    /// シーズン終了は「次シーズンの開始」と一致する（12 月 → 翌年 3 月の年跨ぎを含む）。
    #[test]
    fn season_end_is_next_season_start() {
        for (at, end) in [
            ("2026-06-15T00:00:00Z", "2026-09-01T00:00:00Z"),
            ("2026-09-15T00:00:00Z", "2026-12-01T00:00:00Z"),
            ("2025-12-15T00:00:00Z", "2026-03-01T00:00:00Z"),
            ("2026-01-15T00:00:00Z", "2026-03-01T00:00:00Z"),
            ("2026-03-15T00:00:00Z", "2026-06-01T00:00:00Z"),
        ] {
            assert_eq!(season_end_utc(utc(at)), utc(end), "{at} のシーズン終了");
            // 終了時刻ちょうどは次シーズンの開始（半開区間 [since, until)）。
            assert_eq!(season_start_utc(utc(end)), utc(end));
        }
    }

    /// #379: ローリングウィンドウの起点は「基準時刻ちょうど N 日前」。
    /// 暦の境界に丸めない（月曜起点だった #375 の `week_start_utc` との違い）。
    #[test]
    fn rolling_window_start_is_exactly_n_days_before() {
        let now = utc("2026-07-21T12:34:56Z");

        // 時刻はそのまま残る（00:00 や月曜に丸めない）。
        assert_eq!(days_ago_utc(now, 7), utc("2026-07-14T12:34:56Z"));
        assert_eq!(days_ago_utc(now, 30), utc("2026-06-21T12:34:56Z"));
        assert_eq!(days_ago_utc(now, 0), now);

        // 月跨ぎ・年跨ぎ・うるう年（2028-02-29）でもズレない。
        assert_eq!(
            days_ago_utc(utc("2026-01-05T00:00:00Z"), 30),
            utc("2025-12-06T00:00:00Z")
        );
        assert_eq!(
            days_ago_utc(utc("2028-03-01T09:00:00Z"), 1),
            utc("2028-02-29T09:00:00Z")
        );

        // 30 日 = 7 日 + 23 日（単純な日数差であることの確認）。
        assert_eq!(days_ago_utc(days_ago_utc(now, 7), 23), days_ago_utc(now, 30));
    }

    /// #379: 配信する期間は **全期間 / 今シーズン / 直近 30 日 / 直近 7 日** の 4 つ。
    /// 「今週」「直近 N 戦」は期間の選択肢から外れた。
    #[test]
    fn rolling_periods_are_30d_and_7d() {
        assert_eq!(ROLLING_PERIODS, &[("last_30d", 30u64), ("last_7d", 7u64)]);
    }

    /// 期間別集計の共通検証: 各グループ軸の total 合計が overall.total と一致すること（#364 の性質）。
    fn assert_group_totals_match_overall(period: &serde_json::Value, label: &str) {
        let total = period["overall"]["total"].as_i64().unwrap();
        for axis in ["by_rule", "by_lobby", "by_weapon", "by_stage"] {
            let groups = period[axis].as_array().unwrap();
            assert_eq!(
                sum_total(groups),
                total,
                "{label}.{axis} の total 合計は overall と一致する"
            );
        }
    }

    /// 期間別集計を組み立てるテスト用ヘルパ（本番と同じ経路）。
    async fn build_periods(
        pool: &sqlx::SqlitePool,
        now: &str,
        limit: i64,
    ) -> (serde_json::Value, serde_json::Value) {
        let pop = population(pool).await.unwrap();
        let recent = Scope::recent(&pop, limit);
        let aggregates = aggregates_for(pool, &recent).await.unwrap();
        let by_period = aggregates_by_period(pool, &pop, utc(now), now).await.unwrap();
        (aggregates, by_period)
    }

    /// 配信される期間キー（順序は問わない）。
    const PERIOD_KEYS: [&str; 4] = ["all_time", "season", "last_30d", "last_7d"];

    /// #375 / #379: 全期間 / 今シーズン / 直近 30 日 / 直近 7 日の 4 期間が
    /// 正しい母集団で計算されること。
    /// あわせて since/until と、既存 `aggregates`（直近 N 戦）の回帰防止を確認する。
    #[tokio::test]
    async fn aggregates_by_period_scopes_and_ranges() {
        let pool = test_pool().await;

        // now = 2026-07-21T12:00:00Z
        //   今シーズン: 2026-06-01T00:00:00Z 〜 2026-09-01T00:00:00Z（暦境界）
        //   直近 30 日: 2026-06-21T12:00:00Z 以降（ローリング）
        //   直近  7 日: 2026-07-14T12:00:00Z 以降（ローリング）
        let now = "2026-07-21T12:00:00Z";

        let rows: &[(&str, &str)] = &[
            // 前シーズン（3 月シーズン）: 全期間のみに入る
            ("o1", "2026-04-10T10:00:00Z"),
            ("o2", "2026-05-31T23:59:59Z"), // シーズン開始の 1 秒前 → 今シーズンに入らない
            // 今シーズンだが直近 30 日より前
            ("s1", "2026-06-01T00:00:00Z"), // シーズン開始ちょうど → 今シーズンに入る
            ("s2", "2026-06-21T11:59:59Z"), // 直近 30 日の 1 秒前 → 直近 30 日に入らない
            // 直近 30 日（直近 7 日には入らない）
            ("m1", "2026-06-21T12:00:00Z"), // 直近 30 日ちょうど → 入る
            ("m2", "2026-07-14T11:59:59Z"), // 直近 7 日の 1 秒前 → 直近 7 日に入らない
            // 直近 7 日
            ("w1", "2026-07-14T12:00:00Z"), // 直近 7 日ちょうど → 入る
            ("w2", "2026-07-21T09:00:00Z"),
        ];
        for (i, (id, played_at)) in rows.iter().enumerate() {
            insert_battle_at(
                &pool,
                id,
                played_at,
                (i as i64 % 2) + 1,
                (i as i64 % 3) + 1,
                (i as i64 % 2) + 1,
                (i as i64 % 2) + 1,
                Some((i as i64 % 2) + 1),
                NON_TRI,
            )
            .await;
        }
        // トリカラは全期間でも除外される。
        insert_battle_at(&pool, "t1", "2026-07-21T10:00:00Z", 1, 1, 3, 1, Some(1), TRI).await;

        let (aggregates, periods) = build_periods(&pool, now, DEFAULT_LIMIT).await;

        // --- 期間は 4 つだけ（「今週」「直近 N 戦」は消えた・#379） ---
        let keys: std::collections::HashSet<&str> = periods
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(keys, PERIOD_KEYS.into_iter().collect());

        // --- 母集団の件数 ---
        assert_eq!(
            periods["all_time"]["overall"]["total"], 8,
            "全期間（トリカラ除外）"
        );
        assert_eq!(
            periods["season"]["overall"]["total"], 6,
            "今シーズン（6/1 00:00Z 以降）"
        );
        assert_eq!(
            periods["last_30d"]["overall"]["total"], 4,
            "直近 30 日（now − 30 日 以降）"
        );
        assert_eq!(
            periods["last_7d"]["overall"]["total"], 2,
            "直近 7 日（now − 7 日 以降）"
        );

        // --- since / until ---
        // 暦で決まる期間（今シーズン）は境界そのもの。until は now より未来。
        assert_eq!(periods["season"]["since"], "2026-06-01T00:00:00Z");
        assert_eq!(periods["season"]["until"], "2026-09-01T00:00:00Z");
        assert!(
            periods["season"]["until"].as_str().unwrap() > now,
            "今シーズンの until は暦境界なので未来時刻になり得る"
        );
        // ローリング期間は since = now − N 日、until = 生成時刻（now）。
        assert_eq!(periods["last_30d"]["since"], "2026-06-21T12:00:00Z");
        assert_eq!(periods["last_30d"]["until"], now);
        assert_eq!(periods["last_7d"]["since"], "2026-07-14T12:00:00Z");
        assert_eq!(periods["last_7d"]["until"], now);
        // データで決まる期間（全期間）は最古の played_at と生成時刻。
        assert_eq!(periods["all_time"]["since"], "2026-04-10T10:00:00Z");
        assert_eq!(periods["all_time"]["until"], now);

        // --- グループ合計 == overall.total（全期間で成立） ---
        for key in PERIOD_KEYS {
            assert_group_totals_match_overall(&periods[key], key);
        }

        // --- 既存 aggregates（直近 N 戦）の回帰防止 ---
        // 8 戦しか無いので直近 50 戦 = 全期間と同じ母集団になり、値が一致する。
        for axis in ["overall", "by_rule", "by_lobby", "by_weapon", "by_stage"] {
            assert_eq!(
                aggregates[axis], periods["all_time"][axis],
                "既存 aggregates（8 戦 < 50）は全期間と一致する {axis}"
            );
        }
        // 既存 aggregates 側に since/until は生えない（形は従来どおり）。
        assert!(aggregates.get("since").is_none());
        assert!(aggregates.get("until").is_none());
    }

    /// #379: 期間別集計はどれも**件数で制限されない**（「直近 N 戦」は期間から外れた）。
    /// 一方で既存 `aggregates` は従来どおり直近 50 戦のまま（回帰防止）。
    #[tokio::test]
    async fn aggregates_by_period_is_never_count_limited() {
        let pool = test_pool().await;

        // 直近 7 日の中に 60 戦（now = 7/21 12:00Z に対して 7/20 は 1 日前）。
        for i in 0..60i64 {
            insert_battle_at(
                &pool,
                &format!("w{i}"),
                &format!("2026-07-20T{:02}:{:02}:00Z", i / 60, i % 60),
                (i % 2) + 1,
                (i % 3) + 1,
                (i % 2) + 1,
                (i % 2) + 1,
                Some((i % 2) + 1),
                NON_TRI,
            )
            .await;
        }

        let (aggregates, periods) = build_periods(&pool, "2026-07-21T12:00:00Z", DEFAULT_LIMIT).await;

        for key in PERIOD_KEYS {
            assert_eq!(
                periods[key]["overall"]["total"], 60,
                "{key} は 60 戦すべてを数える（件数制限なし）"
            );
            assert_group_totals_match_overall(&periods[key], key);
        }
        assert_eq!(
            aggregates["overall"]["total"], 50,
            "既存 aggregates は従来どおり直近 50 戦"
        );
    }

    /// #375 / #379: 該当バトルが 0 件の期間でも壊れない
    /// （直近 7 日はまだ遊んでいない / DB が空）。
    #[tokio::test]
    async fn aggregates_by_period_handles_empty_periods() {
        let pool = test_pool().await;

        // --- DB が完全に空 ---
        let (_, periods) = build_periods(&pool, "2026-07-21T12:00:00Z", DEFAULT_LIMIT).await;
        for key in PERIOD_KEYS {
            assert_eq!(periods[key]["overall"]["total"], 0, "{key} は 0 件");
            assert_eq!(periods[key]["overall"]["wins"], 0);
            assert_eq!(periods[key]["overall"]["losses"], 0);
            assert_eq!(periods[key]["overall"]["win_rate"], 0.0, "0 除算しない");
            // #377: 対象バトルが 0 件なら avg_* は 0.0 ではなく null
            //（「平均 0 キル」と「1 戦もしていない」を区別する）。
            assert_eq!(
                periods[key]["overall"]["avg_kill"],
                serde_json::Value::Null,
                "{key}.avg_kill は 0 件なら null"
            );
            assert_eq!(
                periods[key]["overall"]["avg_death"],
                serde_json::Value::Null,
                "{key}.avg_death は 0 件なら null"
            );
            for axis in ["by_rule", "by_lobby", "by_weapon", "by_stage"] {
                assert_eq!(periods[key][axis].as_array().unwrap().len(), 0);
            }
        }
        // データ由来の since は 0 件なら null（until は生成時刻のまま）。
        assert_eq!(periods["all_time"]["since"], serde_json::Value::Null);
        // 暦由来・ローリング由来の since/until は 0 件でも必ず入る（viewer が範囲を判定できる）。
        assert_eq!(periods["season"]["since"], "2026-06-01T00:00:00Z");
        assert_eq!(periods["season"]["until"], "2026-09-01T00:00:00Z");
        assert_eq!(periods["last_7d"]["since"], "2026-07-14T12:00:00Z");
        assert_eq!(periods["last_7d"]["until"], "2026-07-21T12:00:00Z");
        assert_eq!(periods["last_30d"]["since"], "2026-06-21T12:00:00Z");

        // --- 直近 7 日だけ 0 件（それ以前は遊んでいる） ---
        insert_battle_at(&pool, "p1", "2026-07-10T10:00:00Z", 1, 1, 1, 1, Some(1), NON_TRI).await;
        let (_, periods) = build_periods(&pool, "2026-07-21T12:00:00Z", DEFAULT_LIMIT).await;
        assert_eq!(periods["all_time"]["overall"]["total"], 1);
        assert_eq!(periods["season"]["overall"]["total"], 1);
        assert_eq!(periods["last_30d"]["overall"]["total"], 1);
        assert_eq!(periods["last_7d"]["overall"]["total"], 0, "直近 7 日は 0 件");
        assert_eq!(periods["last_7d"]["overall"]["win_rate"], 0.0);
        assert_group_totals_match_overall(&periods["last_7d"], "last_7d");
        assert_eq!(periods["all_time"]["since"], "2026-07-10T10:00:00Z");
        // #377: 0 件の期間だけ null になり、データのある期間は従来どおり数値が入る。
        assert_eq!(
            periods["last_7d"]["overall"]["avg_kill"],
            serde_json::Value::Null,
            "直近 7 日が 0 件なら avg_kill は null"
        );
        assert_eq!(
            periods["last_7d"]["overall"]["avg_death"],
            serde_json::Value::Null,
            "直近 7 日が 0 件なら avg_death は null"
        );
        assert_eq!(
            periods["all_time"]["overall"]["avg_kill"], 3.0,
            "データのある期間は従来どおり数値"
        );
        assert_eq!(periods["all_time"]["overall"]["avg_death"], 2.0);
    }

    /// #377: 既存 `aggregates`（直近 N 戦）でも、対象バトルが 0 件なら
    /// avg_kill / avg_death は 0.0 ではなく null になる。
    #[tokio::test]
    async fn overall_avg_is_null_when_no_battles() {
        let pool = test_pool().await;

        let pop = population(&pool).await.unwrap();
        let v = overall(&pool, &Scope::recent(&pop, DEFAULT_LIMIT))
            .await
            .unwrap();

        assert_eq!(v["total"], 0);
        assert_eq!(
            v["avg_kill"],
            serde_json::Value::Null,
            "0 件なら avg_kill は null"
        );
        assert_eq!(
            v["avg_death"],
            serde_json::Value::Null,
            "0 件なら avg_death は null"
        );
    }

    /// #377: `detail_fetched=0` のバトルしか無い場合も AVG の母数は 0 件なので null。
    /// （バトル自体は total に数えるが、平均は「データが無い」）
    #[tokio::test]
    async fn overall_avg_is_null_when_only_undetailed_battles() {
        let pool = test_pool().await;
        insert_battle_undetailed(&pool, "u1", "2026-07-20T10:00:00Z").await;
        insert_battle_undetailed(&pool, "u2", "2026-07-20T11:00:00Z").await;

        let pop = population(&pool).await.unwrap();
        let v = overall(&pool, &Scope::recent(&pop, DEFAULT_LIMIT))
            .await
            .unwrap();

        assert_eq!(v["total"], 2, "バトル自体は数える");
        assert_eq!(v["avg_kill"], serde_json::Value::Null);
        assert_eq!(v["avg_death"], serde_json::Value::Null);

        // 期間別集計（#375）側も同じ（detail_fetched=0 しか無い期間は null）。
        let (aggregates, periods) = build_periods(&pool, "2026-07-21T12:00:00Z", DEFAULT_LIMIT).await;
        assert_eq!(aggregates["overall"]["avg_kill"], serde_json::Value::Null);
        for key in PERIOD_KEYS {
            assert_eq!(
                periods[key]["overall"]["avg_kill"],
                serde_json::Value::Null,
                "{key}.avg_kill"
            );
            assert_eq!(
                periods[key]["overall"]["avg_death"],
                serde_json::Value::Null,
                "{key}.avg_death"
            );
        }
    }

    /// #377 回帰防止: データがある場合は従来どおり平均値が入る（null にしない）。
    /// `detail_fetched=0` のバトルが混ざっても平均の母数からは外れるだけ。
    #[tokio::test]
    async fn overall_avg_has_values_when_battles_exist() {
        let pool = test_pool().await;

        // insert_battle_at は kill=3 / death=2 / detail_fetched=1 で入る。
        insert_battle_at(&pool, "d1", "2026-07-20T10:00:00Z", 1, 1, 1, 1, Some(1), NON_TRI).await;
        insert_battle_at(&pool, "d2", "2026-07-20T11:00:00Z", 1, 2, 1, 1, Some(1), NON_TRI).await;
        // 詳細未取得（kill=9 / death=9）は平均に影響しない。
        insert_battle_undetailed(&pool, "u1", "2026-07-20T12:00:00Z").await;

        let pop = population(&pool).await.unwrap();
        let v = overall(&pool, &Scope::recent(&pop, DEFAULT_LIMIT))
            .await
            .unwrap();

        assert_eq!(v["total"], 3);
        assert_eq!(v["avg_kill"], 3.0, "detail_fetched=1 のみの平均");
        assert_eq!(v["avg_death"], 2.0);

        // 期間別集計側も同じ値（母集団が同じ期間はすべて 3.0 / 2.0）。
        let (aggregates, periods) = build_periods(&pool, "2026-07-21T12:00:00Z", DEFAULT_LIMIT).await;
        assert_eq!(aggregates["overall"]["avg_kill"], 3.0);
        assert_eq!(aggregates["overall"]["avg_death"], 2.0);
        for key in PERIOD_KEYS {
            assert_eq!(periods[key]["overall"]["avg_kill"], 3.0, "{key}.avg_kill");
            assert_eq!(periods[key]["overall"]["avg_death"], 2.0, "{key}.avg_death");
        }
    }

    /// #375: `battles[]` は期間別集計を足しても**従来どおり直近 N 戦のまま**（件数を増やさない）。
    #[tokio::test]
    async fn battles_list_is_unchanged_by_period_aggregates() {
        let pool = test_pool().await;

        for i in 0..70i64 {
            insert_battle_at(
                &pool,
                &format!("b{i}"),
                &format!("2026-07-20T{:02}:{:02}:00Z", i / 60, i % 60),
                (i % 2) + 1,
                (i % 3) + 1,
                (i % 2) + 1,
                (i % 2) + 1,
                Some((i % 2) + 1),
                NON_TRI,
            )
            .await;
        }

        let pop = population(&pool).await.unwrap();
        let recent = Scope::recent(&pop, DEFAULT_LIMIT);
        let battles = sqlx::query_as::<_, BattleExportRow>(&battles_sql())
            .bind(recent.pop.0.as_str())
            .bind(&recent.since)
            .bind(&recent.until)
            .bind(recent.limit)
            .fetch_all(&pool)
            .await
            .unwrap();
        assert_eq!(battles.len(), 50, "battles[] は直近 50 戦のまま");
    }

    // -----------------------------------------------------------------------
    // #379: by_weapon / by_stage の表示名
    // -----------------------------------------------------------------------

    /// key → エントリの索引（グループ集計は total 降順なので位置で引かない）。
    fn group_by_key<'a>(groups: &'a serde_json::Value, key: &str) -> &'a serde_json::Value {
        groups
            .as_array()
            .unwrap()
            .iter()
            .find(|g| g["key"] == key)
            .unwrap_or_else(|| panic!("key={key} のグループが無い"))
    }

    /// #379（このバグの本体）: **直近 50 戦に登場しないブキ・ステージ**でも
    /// 全期間の by_weapon / by_stage に表示名が入ること。
    ///
    /// viewer は `battles[]`（直近 50 戦）から key → 表示名の対応表を作っていたため、
    /// 全期間を選ぶと 50 戦に出てこないブキ・ステージのアイコンと名前が出せなかった。
    /// さらに **`map.key` は数値 ID** なので、ステージは key を表示にも使えない。
    #[tokio::test]
    async fn group_display_names_cover_entries_missing_from_recent_battles() {
        let pool = test_pool().await;

        // 実データに合わせて map.key は数値 ID にする（weapon.key は日本語名そのもの）。
        sqlx::query(
            "UPDATE map    SET key = '1',  name_ja = 'ユノハナ大渓谷' WHERE id = 1;
             UPDATE weapon SET key = 'スプラシューター', name_ja = 'スプラシューター' WHERE id = 1;
             INSERT INTO map    (id, key, name_ja) VALUES (10, '10', 'マサバ海峡大橋');
             INSERT INTO weapon (id, key, name_ja) VALUES (10, 'ノヴァブラスター', 'ノヴァブラスター');",
        )
        .execute(&pool)
        .await
        .unwrap();

        // 古い 1 戦だけが map=10 / weapon=10（直近 50 戦には絶対に入らない）。
        insert_battle_at(&pool, "old", "2026-01-02T10:00:00Z", 10, 1, 1, 10, Some(1), NON_TRI).await;
        // 直近 60 戦はすべて map=1 / weapon=1。
        for i in 0..60i64 {
            insert_battle_at(
                &pool,
                &format!("r{i}"),
                &format!("2026-07-20T{:02}:{:02}:00Z", i / 60, i % 60),
                1,
                (i % 3) + 1,
                1,
                1,
                Some(1),
                NON_TRI,
            )
            .await;
        }

        let (aggregates, periods) = build_periods(&pool, "2026-07-21T12:00:00Z", DEFAULT_LIMIT).await;

        // 前提: battles[]（= 既存 aggregates と同じ母集団）には old が入らない。
        let battles = sqlx::query_as::<_, BattleExportRow>(&battles_sql())
            .bind(population(&pool).await.unwrap().0.as_str())
            .bind(RANGE_MIN)
            .bind(RANGE_MAX)
            .bind(DEFAULT_LIMIT)
            .fetch_all(&pool)
            .await
            .unwrap();
        assert!(
            !battles.iter().any(|b| b.id == "old"),
            "直近 50 戦には old が入らない（viewer は battles[] から名前を引けない）"
        );

        // --- 全期間: 50 戦に出てこないブキ・ステージにも表示名が入る ---
        let all = &periods["all_time"];
        let old_weapon = group_by_key(&all["by_weapon"], "ノヴァブラスター");
        assert_eq!(old_weapon["display_name"], "ノヴァブラスター");
        assert_eq!(old_weapon["total"], 1);

        let old_stage = group_by_key(&all["by_stage"], "10");
        assert_eq!(
            old_stage["display_name"], "マサバ海峡大橋",
            "アイコン解決鍵（sha256(正式名)）になるので必須"
        );
        assert_eq!(
            old_stage["short_name"], "マサバ",
            "STAGE_SHORT が引ける正式名には短縮名も入る"
        );
        assert_ne!(
            old_stage["key"], old_stage["display_name"],
            "map.key は数値 ID なので表示には使えない"
        );

        // --- 期間を問わず入る（viewer が期間を切り替えても名前が消えない） ---
        for key in PERIOD_KEYS {
            let p = &periods[key];
            assert_eq!(
                group_by_key(&p["by_weapon"], "スプラシューター")["display_name"],
                "スプラシューター",
                "{key}.by_weapon"
            );
            let stage = group_by_key(&p["by_stage"], "1");
            assert_eq!(stage["display_name"], "ユノハナ大渓谷", "{key}.by_stage");
            assert_eq!(stage["short_name"], "ユノハナ", "{key}.by_stage");
        }

        // --- 既存 aggregates（直近 50 戦）にも同じく入る（期間別だけだと不整合） ---
        assert_eq!(
            group_by_key(&aggregates["by_weapon"], "スプラシューター")["display_name"],
            "スプラシューター"
        );
        assert_eq!(
            group_by_key(&aggregates["by_stage"], "1")["display_name"],
            "ユノハナ大渓谷"
        );
        assert_eq!(
            group_by_key(&aggregates["by_stage"], "1")["short_name"],
            "ユノハナ"
        );

        // --- by_rule / by_lobby には表示名を入れない（viewer が固有の表を持つ） ---
        for axis in ["by_rule", "by_lobby"] {
            for g in aggregates[axis].as_array().unwrap() {
                assert!(g.get("display_name").is_none(), "{axis} に表示名は不要");
                assert!(g.get("short_name").is_none(), "{axis} に短縮名は不要");
            }
        }
    }

    /// #379: `name_ja` が NULL / `STAGE_SHORT` に無いステージでもフィールドを捏造しない。
    /// - `name_ja` が NULL → `display_name` 自体を出さない（viewer は key へフォールバック）
    /// - 未知のステージ → `display_name` は入るが `short_name` は出さない（正式名で表示される）
    #[tokio::test]
    async fn group_display_names_are_omitted_when_unresolvable() {
        let pool = test_pool().await;

        sqlx::query(
            "INSERT INTO map    (id, key, name_ja) VALUES (3, '3', '未来ステージ'), (4, '4', NULL);
             INSERT INTO weapon (id, key, name_ja) VALUES (3, 'noname', NULL);",
        )
        .execute(&pool)
        .await
        .unwrap();

        insert_battle_at(&pool, "u1", "2026-07-20T10:00:00Z", 3, 1, 1, 3, Some(1), NON_TRI).await;
        insert_battle_at(&pool, "u2", "2026-07-20T11:00:00Z", 4, 1, 1, 3, Some(1), NON_TRI).await;

        let pop = population(&pool).await.unwrap();
        let stats = aggregates_for(&pool, &Scope::recent(&pop, DEFAULT_LIMIT))
            .await
            .unwrap();

        // 未知ステージ: 正式名は入るが短縮名は無い。
        let mirai = group_by_key(&stats["by_stage"], "3");
        assert_eq!(mirai["display_name"], "未来ステージ");
        assert!(
            mirai.get("short_name").is_none(),
            "STAGE_SHORT に無いステージの短縮名は出さない"
        );

        // name_ja が NULL: 表示名も短縮名も出さない（key だけ）。
        let noname = group_by_key(&stats["by_stage"], "4");
        assert!(noname.get("display_name").is_none());
        assert!(noname.get("short_name").is_none());
        assert_eq!(noname["total"], 1, "集計そのものは従来どおり成立する");

        let w = group_by_key(&stats["by_weapon"], "noname");
        assert!(w.get("display_name").is_none());
        assert_eq!(w["total"], 2);
    }
}
