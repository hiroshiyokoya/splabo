//! AI 用のビュー層（#572）。
//!
//! AI に分析コードを書かせるとき、**生スキーマを渡すと確実に間違える**。理由が3つある。
//!
//! 1. **同じ意味のテーブルが二重にある** — `battles` / `battle`、`battle_players` /
//!    `battle_player`、`weapons` / `weapon`。stat.ink 互換化（#90）の途中の状態で、
//!    集計は新スキーマ側に移っているが、スキーマを見ただけでは分からない
//! 2. **スキーマから読めない集計規約が多い** — 投稿者除外 7 人、KDA の母数差、9 時境界、
//!    味方ブキの重複畳み込みと自分除外
//! 3. **マイグレーションで生成コードが壊れる** — スキーマは v22 まで動いている
//!
//! そこで **AI が触るのはこのビューだけ**にする。ビューを契約として固定すれば、内部
//! スキーマが変わってもビューを保つ限り生成コードは生き残る。
//!
//! # 「構造で防ぐ」のがこのモジュールの役目
//!
//! 焼き込めるものはビューの形にする。
//!
//! - 引き分けは `won = NULL` → SQLite の集約が NULL を無視するので、`AVG(won)` が勝率に
//!   なり、`corr(won, death)` が引き分けを自動で除外する（#573 の統計関数と対）
//! - 0 除算になる比率は NULL → `∞` を作らない
//! - 時系列列は計算済み → **`played_at` は UTC 保存で、シフトせずに 9 時境界のスプラ日に
//!   なる**。この性質はスキーマから読めず、親切心で `-9 hours` すると 1 日ずれる
//! - 味方ブキは重複を畳み、自分を除く（`ai_battle_weapon_presence`）
//! - 詳細未取得のバトルが黙って落ちないよう `has_players` を出す
//!
//! 焼き込めない「意味」（ナワバリだけ塗り率で決まる、ギアの AP 重み、合計がバトル数を
//! 超えるのは正常、など）は #575 のドメイン知識パックで言葉として渡す。
//!
//! # 環境（stat.ink）側のビューは別 PR
//!
//! `ai_env_slots`（1 行 = バトル × 投稿者を除く 7 スロット）は 7 way の UNION ALL で
//! 独自の注意点があるため分けた。

use crate::db::DbPool;

/// ビューの定義。**毎起動で drop → create する。**
///
/// 版管理しないのは、ビューが「コードが正」の派生物だからで、常にコードと一致させたい。
/// 実体はテーブルなので作り直しのコストはほぼゼロ。
///
/// 🔴 `rule` は **LEFT JOIN** でなければならない。migration v11 で `battle.rule_id` が
/// nullable になっており（詳細未取得のバトルは NULL）、INNER JOIN にすると
/// **黙って母数が減る**。「相手ブキ別の勝率」が詳細取得済みだけの数字になり、画面上は
/// そう見えない、という壊れ方をする。
pub const AI_VIEWS_SQL: &str = r#"
DROP VIEW IF EXISTS ai_battles;
DROP VIEW IF EXISTS ai_battle_players;
DROP VIEW IF EXISTS ai_battle_weapon_presence;

CREATE VIEW ai_battles AS
SELECT
    b.id                                            AS battle_id,
    b.played_at                                     AS played_at,
    strftime('%Y-%m-%d', b.played_at)               AS day,
    strftime('%Y-W%W',   b.played_at)               AS week,
    strftime('%Y-%m',    b.played_at)               AS month,
    l.key                                           AS lobby,
    r.key                                           AS rule,
    COALESCE(m.name_ja, m.key)                      AS stage,
    COALESCE(w.name_ja, w.key)                      AS weapon,
    COALESCE(NULLIF(w.category_key, ''), '(未分類)') AS weapon_category,
    COALESCE(w.sub_key,     '(不明)')                AS sub_weapon,
    COALESCE(w.special_key, '(不明)')                AS special_weapon,
    res.key                                         AS result,
    CASE res.key WHEN 'win' THEN 1 WHEN 'lose' THEN 0 END AS won,
    b.is_knockout                                   AS is_knockout,
    b.kill                                          AS kill,
    b.assist                                        AS assist,
    b.kill_or_assist                                AS kill_or_assist,
    b.death                                         AS death,
    b.special                                       AS special,
    b.inked                                         AS inked,
    b.duration                                      AS duration,
    CASE WHEN b.death > 0 THEN CAST(b.kill AS REAL) / b.death END              AS kill_ratio,
    CASE WHEN b.death > 0 THEN CAST(b.kill + b.assist AS REAL) / b.death END   AS contrib_kill_ratio,
    b.our_team_percent                              AS our_team_percent,
    b.their_team_percent                            AS their_team_percent,
    b.rank_before                                   AS rank_before,
    b.rank_after                                    AS rank_after,
    b.x_power_before                                AS x_power_before,
    b.x_power_after                                 AS x_power_after,
    CASE WHEN EXISTS (SELECT 1 FROM battle_player bp WHERE bp.battle_id = b.id)
         THEN 1 ELSE 0 END                          AS has_players
FROM battle b
JOIN      lobby  l   ON l.id   = b.lobby_id
LEFT JOIN rule   r   ON r.id   = b.rule_id
JOIN      map    m   ON m.id   = b.map_id
JOIN      result res ON res.id = b.result_id
JOIN      weapon w   ON w.id   = b.weapon_id;

CREATE VIEW ai_battle_players AS
SELECT
    bp.battle_id                                    AS battle_id,
    bp.is_our_team                                  AS is_our_team,
    bp.is_me                                        AS is_me,
    COALESCE(w.name_ja, w.key)                      AS weapon,
    COALESCE(NULLIF(w.category_key, ''), '(未分類)') AS weapon_category,
    COALESCE(w.sub_key,     '(不明)')                AS sub_weapon,
    COALESCE(w.special_key, '(不明)')                AS special_weapon,
    bp.kill                                         AS kill,
    bp.assist                                       AS assist,
    bp.kill_or_assist                               AS kill_or_assist,
    bp.death                                        AS death,
    bp.special                                      AS special,
    bp.inked                                        AS inked,
    hp.key   AS head_primary,
    hs1.key  AS head_sub1,
    hs2.key  AS head_sub2,
    hs3.key  AS head_sub3,
    cp.key   AS clothing_primary,
    cs1.key  AS clothing_sub1,
    cs2.key  AS clothing_sub2,
    cs3.key  AS clothing_sub3,
    sp.key   AS shoes_primary,
    ss1.key  AS shoes_sub1,
    ss2.key  AS shoes_sub2,
    ss3.key  AS shoes_sub3
FROM battle_player bp
JOIN      weapon w  ON w.id  = bp.weapon_id
LEFT JOIN gear_configuration hg ON hg.id  = bp.headgear_id
LEFT JOIN ability hp  ON hp.id  = hg.primary_ability_id
LEFT JOIN ability hs1 ON hs1.id = hg.sub1_ability_id
LEFT JOIN ability hs2 ON hs2.id = hg.sub2_ability_id
LEFT JOIN ability hs3 ON hs3.id = hg.sub3_ability_id
LEFT JOIN gear_configuration cg ON cg.id  = bp.clothing_id
LEFT JOIN ability cp  ON cp.id  = cg.primary_ability_id
LEFT JOIN ability cs1 ON cs1.id = cg.sub1_ability_id
LEFT JOIN ability cs2 ON cs2.id = cg.sub2_ability_id
LEFT JOIN ability cs3 ON cs3.id = cg.sub3_ability_id
LEFT JOIN gear_configuration sg ON sg.id  = bp.shoes_id
LEFT JOIN ability sp  ON sp.id  = sg.primary_ability_id
LEFT JOIN ability ss1 ON ss1.id = sg.sub1_ability_id
LEFT JOIN ability ss2 ON ss2.id = sg.sub2_ability_id
LEFT JOIN ability ss3 ON ss3.id = sg.sub3_ability_id;

CREATE VIEW ai_battle_weapon_presence AS
SELECT DISTINCT
    bp.battle_id                                    AS battle_id,
    CASE WHEN bp.is_our_team = 1 THEN 'ally' ELSE 'enemy' END AS side,
    COALESCE(w.name_ja, w.key)                      AS weapon,
    COALESCE(NULLIF(w.category_key, ''), '(未分類)') AS weapon_category,
    COALESCE(w.sub_key,     '(不明)')                AS sub_weapon,
    COALESCE(w.special_key, '(不明)')                AS special_weapon
FROM battle_player bp
JOIN weapon w ON w.id = bp.weapon_id
WHERE NOT (bp.is_our_team = 1 AND bp.is_me = 1);
"#;

/// ビュー 1 つの説明。**列は実ビューと一致していなければならない**（テストで検証する）。
pub struct ViewDoc {
    pub name: &'static str,
    /// 1 行が何を表すか。ここを外すと AI の集計が丸ごとずれるので最初に書く。
    pub row_meaning: &'static str,
    pub columns: &'static [(&'static str, &'static str)],
}

pub const AI_VIEWS: &[ViewDoc] = &[
    ViewDoc {
        name: "ai_battles",
        row_meaning: "1 行 = 自分が遊んだバトル 1 件",
        columns: &[
            ("battle_id", "バトルの ID。他のビューと結合するキー"),
            ("played_at", "遊んだ時刻（UTC の ISO8601）"),
            ("day", "スプラ日（9 時境界）。YYYY-MM-DD。計算済みなので時刻をずらさないこと"),
            ("week", "週（月曜始まり）。YYYY-Www"),
            ("month", "月。YYYY-MM"),
            ("lobby", "regular / bankara_open / bankara_challenge / xmatch / splatfest_open / splatfest_challenge / event / private"),
            ("rule", "nawabari / area / yagura / hoko / asari / tricolor。詳細未取得のバトルは NULL"),
            ("stage", "ステージ名（和名）"),
            ("weapon", "自分が使ったブキ（和名）"),
            ("weapon_category", "ブキのカテゴリ（シューター等）。不明は (未分類)"),
            ("sub_weapon", "サブウェポン。不明は (不明)"),
            ("special_weapon", "スペシャルウェポン。不明は (不明)"),
            ("result", "win / lose / draw"),
            ("won", "勝ち 1 / 負け 0 / 引き分け NULL。AVG(won) が勝率になり、集約は引き分けを自動で除外する"),
            ("is_knockout", "ノックアウト決着なら 1、時間切れなら 0、不明は NULL"),
            ("kill", "自分のキル数"),
            ("assist", "自分のアシスト数"),
            ("kill_or_assist", "キル + アシスト（貢献キル）"),
            ("death", "自分のデス数"),
            ("special", "スペシャル発動回数"),
            ("inked", "自分の塗りポイント"),
            ("duration", "バトルの長さ（秒）"),
            ("kill_ratio", "キルレ = kill / death。death が 0 のときは NULL"),
            ("contrib_kill_ratio", "貢献キルレ = (kill + assist) / death。death が 0 のときは NULL"),
            ("our_team_percent", "自チームの塗り率（ナワバリのみ意味を持つ）"),
            ("their_team_percent", "相手チームの塗り率（ナワバリのみ意味を持つ）"),
            ("rank_before", "バトル前のウデマエ"),
            ("rank_after", "バトル後のウデマエ"),
            ("x_power_before", "バトル前の X パワー"),
            ("x_power_after", "バトル後の X パワー"),
            ("has_players", "このバトルにプレイヤー行があるか（1/0）。0 のバトルは ai_battle_players / ai_battle_weapon_presence に出てこない"),
        ],
    },
    ViewDoc {
        name: "ai_battle_players",
        row_meaning: "1 行 = バトル 1 件 × プレイヤー 1 人（最大 8 人）。そのプレイヤー自身の成績とギア",
        columns: &[
            ("battle_id", "ai_battles と結合するキー"),
            ("is_our_team", "自分と同じチームなら 1"),
            ("is_me", "自分自身の行なら 1"),
            ("weapon", "そのプレイヤーのブキ（和名）"),
            ("weapon_category", "ブキのカテゴリ"),
            ("sub_weapon", "サブウェポン"),
            ("special_weapon", "スペシャルウェポン"),
            ("kill", "そのプレイヤーのキル数"),
            ("assist", "そのプレイヤーのアシスト数"),
            ("kill_or_assist", "キル + アシスト"),
            ("death", "デス数"),
            ("special", "スペシャル発動回数"),
            ("inked", "塗りポイント"),
            ("head_primary", "アタマのメインギアパワー。付いていなければ NULL"),
            ("head_sub1", "アタマのサブ 1"),
            ("head_sub2", "アタマのサブ 2"),
            ("head_sub3", "アタマのサブ 3"),
            ("clothing_primary", "フクのメインギアパワー"),
            ("clothing_sub1", "フクのサブ 1"),
            ("clothing_sub2", "フクのサブ 2"),
            ("clothing_sub3", "フクのサブ 3"),
            ("shoes_primary", "クツのメインギアパワー"),
            ("shoes_sub1", "クツのサブ 1"),
            ("shoes_sub2", "クツのサブ 2"),
            ("shoes_sub3", "クツのサブ 3"),
        ],
    },
    ViewDoc {
        name: "ai_battle_weapon_presence",
        row_meaning: "1 行 = 「そのバトルのその陣営に、そのブキが居た」という事実。\
                      同一バトル内の同じブキは 1 行に畳んであり、ally からは自分を除いてある。\
                      味方ブキ / 相手ブキ別の集計はこのビューを使う",
        columns: &[
            ("battle_id", "ai_battles と結合するキー"),
            ("side", "ally（自分を除く味方）/ enemy（相手）"),
            ("weapon", "そのブキ（和名）"),
            ("weapon_category", "ブキのカテゴリ"),
            ("sub_weapon", "サブウェポン"),
            ("special_weapon", "スペシャルウェポン"),
        ],
    },
];

/// ビューを作り直す。
///
/// **マイグレーション（`migrate_battle_ids`）より後に呼ぶこと。** `rule_id` の nullable 化
/// （v11）や環境の KDA 列追加（v21）を前提にしているため。
pub async fn create_views(pool: &DbPool) -> Result<(), String> {
    // 🔴 `sqlx::query()` は 1 文しか実行しない（プリペアドステートメント）。
    // 複数文のスクリプトは `raw_sql` を使うこと。
    sqlx::raw_sql(AI_VIEWS_SQL)
        .execute(pool.as_ref())
        .await
        .map_err(|e| format!("AI 用ビューの作成に失敗: {e}"))?;
    Ok(())
}

/// AI に渡すドメイン知識（#575）。
///
/// ビューの形では焼き込めない「意味」を言葉で渡す部分。ナワバリだけ塗り率で決まる、
/// ギアの AP 重み、味方ブキの合計がバトル数を超えるのは正常、といった内容。
///
/// `include_str!` で埋め込むので、ファイルを消すとコンパイルが通らない。
/// 実行時にファイルを探さないため、配布物に同梱する必要もない。
pub const DOMAIN_KNOWLEDGE: &str = include_str!("../../../docs/ai-domain-knowledge.md");

/// AI に渡すプロンプトの土台。**ビューの一覧 + ドメイン知識**。
///
/// データは 1 行も含まない。ここに載っているのは「どんな列があるか」と「その意味」だけ。
pub fn analysis_prompt() -> String {
    format!("{}\n---\n\n{}", schema_prompt(), DOMAIN_KNOWLEDGE)
}

/// AI に渡すスキーマ説明を組む。**ここが唯一の出力元**で、手書きの一覧を別に持たない。
pub fn schema_prompt() -> String {
    let mut s = String::from(
        "分析に使えるビューは以下だけです。他のテーブルは参照できません。\n\n",
    );
    for v in AI_VIEWS {
        s.push_str(&format!("## {}\n{}\n\n", v.name, v.row_meaning));
        for (col, desc) in v.columns {
            s.push_str(&format!("- `{col}` — {desc}\n"));
        }
        s.push('\n');
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::Row;
    use std::sync::Arc;

    /// 本番と**同じ順序**で土台を組む: `SCHEMA` → `LEGACY_ALTERS` → マイグレーション → ビュー。
    ///
    /// マイグレーションを実際に走らせるのが要点。`SCHEMA_V6` を直に流すだけでは
    /// **v11 の「`battle.rule_id` を nullable 化」が当たらず**、詳細未取得のバトルを
    /// 再現できない。土台の SQL をテスト側に写すとそこがズレるので、本物を通す。
    ///
    /// 🔴 メモリ DB は接続ごとに別物になるので接続を 1 本に固定する。
    async fn setup() -> DbPool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        // 複数文なので raw_sql（query は 1 文しか実行しない）。
        sqlx::raw_sql(crate::db::SCHEMA).execute(&pool).await.unwrap();
        for sql in crate::db::LEGACY_ALTERS {
            let _ = sqlx::query(*sql).execute(&pool).await;
        }
        let pool: DbPool = Arc::new(pool);
        crate::db::migrate_battle_ids(&pool).await.unwrap();
        create_views(&pool).await.unwrap();
        pool
    }

    /// マスターと 1 バトルを入れる。`result_key` で勝敗を変える。
    async fn insert_battle(pool: &DbPool, id: &str, result_key: &str, rule_id: Option<i64>) {
        sqlx::query("INSERT OR IGNORE INTO lobby (id, key) VALUES (1, 'bankara_open')")
            .execute(pool.as_ref()).await.unwrap();
        sqlx::query("INSERT OR IGNORE INTO rule (id, key) VALUES (2, 'area')")
            .execute(pool.as_ref()).await.unwrap();
        sqlx::query("INSERT OR IGNORE INTO map (id, key, name_ja) VALUES (1, 'yunohana', 'ユノハナ大渓谷')")
            .execute(pool.as_ref()).await.unwrap();
        for (rid, key) in [(1, "win"), (2, "lose"), (3, "draw")] {
            sqlx::query("INSERT OR IGNORE INTO result (id, key) VALUES (?, ?)")
                .bind(rid).bind(key).execute(pool.as_ref()).await.unwrap();
        }
        sqlx::query(
            "INSERT OR IGNORE INTO weapon (id, key, name_ja, category_key, sub_key, special_key)
             VALUES (1, 'splattershot', 'スプラシューター', 'shooter', 'kyubanbomb', 'kanibuki')",
        ).execute(pool.as_ref()).await.unwrap();
        sqlx::query(
            "INSERT OR IGNORE INTO weapon (id, key, name_ja, category_key, sub_key, special_key)
             VALUES (2, 'nzap85', 'N-ZAP85', 'shooter', 'kyubanbomb', 'energystand')",
        ).execute(pool.as_ref()).await.unwrap();

        let result_id: i64 = match result_key { "win" => 1, "lose" => 2, _ => 3 };
        sqlx::query(
            "INSERT INTO battle
               (id, played_at, lobby_id, rule_id, map_id, result_id, weapon_id,
                kill, assist, kill_or_assist, death, special, inked, duration)
             VALUES (?, '2026-07-30T01:23:45Z', 1, ?, 1, ?, 1, 6, 2, 8, 4, 3, 1200, 300)",
        )
        .bind(id).bind(rule_id).bind(result_id)
        .execute(pool.as_ref()).await.unwrap();
    }

    async fn insert_player(pool: &DbPool, battle_id: &str, our: i64, slot: i64, me: i64, weapon_id: i64) {
        sqlx::query(
            "INSERT INTO battle_player
               (battle_id, is_our_team, rank_in_team, is_me, weapon_id,
                kill, assist, kill_or_assist, death, special, inked)
             VALUES (?, ?, ?, ?, ?, 1, 1, 2, 1, 1, 100)",
        )
        .bind(battle_id).bind(our).bind(slot).bind(me).bind(weapon_id)
        .execute(pool.as_ref()).await.unwrap();
    }

    /// **説明と実ビューの列がズレていないか。** これが drift 検出の本体。
    /// 列を足して説明を書き忘れる / 名前を変えるとここで落ちる。
    #[tokio::test]
    async fn 説明の列が実ビューと一致する() {
        let pool = setup().await;
        for v in AI_VIEWS {
            let rows = sqlx::query(&format!("PRAGMA table_info({})", v.name))
                .fetch_all(pool.as_ref()).await.unwrap();
            let actual: Vec<String> = rows.iter().map(|r| r.get::<String, _>("name")).collect();
            let documented: Vec<String> = v.columns.iter().map(|(c, _)| c.to_string()).collect();
            assert_eq!(
                actual, documented,
                "{} の列と説明がズレている。実ビュー: {actual:?} / 説明: {documented:?}",
                v.name
            );
        }
    }

    #[tokio::test]
    async fn 引き分けは_won_が_null_になり勝率の母数から外れる() {
        let pool = setup().await;
        insert_battle(&pool, "b1", "win", Some(2)).await;
        insert_battle(&pool, "b2", "lose", Some(2)).await;
        insert_battle(&pool, "b3", "draw", Some(2)).await;

        // 3 件あるが、引き分けは母数外なので勝率は 1/2 = 0.5
        let rate: f64 = sqlx::query_scalar("SELECT AVG(won) FROM ai_battles")
            .fetch_one(pool.as_ref()).await.unwrap();
        assert!((rate - 0.5).abs() < 1e-12, "勝率 = {rate}");

        let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ai_battles")
            .fetch_one(pool.as_ref()).await.unwrap();
        assert_eq!(total, 3, "行そのものは 3 件あるべき");
    }

    #[tokio::test]
    async fn 詳細未取得でルールが_null_のバトルも落ちない() {
        let pool = setup().await;
        insert_battle(&pool, "b1", "win", Some(2)).await;
        // rule_id = NULL（list クエリ取り込み直後の状態・migration v11）
        insert_battle(&pool, "b2", "win", None).await;

        let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ai_battles")
            .fetch_one(pool.as_ref()).await.unwrap();
        assert_eq!(total, 2, "rule が NULL のバトルが INNER JOIN で落ちている");

        let null_rule: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ai_battles WHERE rule IS NULL")
            .fetch_one(pool.as_ref()).await.unwrap();
        assert_eq!(null_rule, 1);
    }

    #[tokio::test]
    async fn 時系列列が9時境界のスプラ日になる() {
        let pool = setup().await;
        // UTC 01:23 = JST 10:23 → スプラ日は 7/30（9 時境界を過ぎている）
        insert_battle(&pool, "b1", "win", Some(2)).await;
        let day: String = sqlx::query_scalar("SELECT day FROM ai_battles")
            .fetch_one(pool.as_ref()).await.unwrap();
        assert_eq!(day, "2026-07-30", "UTC の日付そのままが 9 時境界のスプラ日になる");
    }

    #[tokio::test]
    async fn ゼロ除算の比率は_null_になる() {
        let pool = setup().await;
        insert_battle(&pool, "b1", "win", Some(2)).await;
        sqlx::query("UPDATE battle SET death = 0").execute(pool.as_ref()).await.unwrap();
        let kr: Option<f64> = sqlx::query_scalar("SELECT kill_ratio FROM ai_battles")
            .fetch_one(pool.as_ref()).await.unwrap();
        assert!(kr.is_none(), "death=0 で ∞ を作ってはいけない: {kr:?}");
    }

    #[tokio::test]
    async fn presence_は同一ブキを畳み自分を除く() {
        let pool = setup().await;
        insert_battle(&pool, "b1", "win", Some(2)).await;
        // 味方: 自分(スプラシューター) + 同じスプラシューター 2 人 + N-ZAP
        insert_player(&pool, "b1", 1, 1, 1, 1).await; // 自分
        insert_player(&pool, "b1", 1, 2, 0, 1).await; // 味方・同じブキ
        insert_player(&pool, "b1", 1, 3, 0, 1).await; // 味方・同じブキ（重複）
        insert_player(&pool, "b1", 1, 4, 0, 2).await; // 味方・別ブキ
        // 相手: スプラシューター 2 人
        insert_player(&pool, "b1", 0, 1, 0, 1).await;
        insert_player(&pool, "b1", 0, 2, 0, 1).await;

        // ally は「自分を除く」「同じブキは 1」なので スプラ + N-ZAP の 2 行
        let ally: Vec<String> = sqlx::query_scalar(
            "SELECT weapon FROM ai_battle_weapon_presence WHERE side='ally' ORDER BY weapon",
        ).fetch_all(pool.as_ref()).await.unwrap();
        assert_eq!(ally, vec!["N-ZAP85".to_string(), "スプラシューター".to_string()]);

        // enemy は同じブキ 2 人が 1 行に畳まれる
        let enemy: Vec<String> = sqlx::query_scalar(
            "SELECT weapon FROM ai_battle_weapon_presence WHERE side='enemy'",
        ).fetch_all(pool.as_ref()).await.unwrap();
        assert_eq!(enemy, vec!["スプラシューター".to_string()]);
    }

    #[tokio::test]
    async fn has_players_で母数を揃えられる() {
        let pool = setup().await;
        insert_battle(&pool, "b1", "win", Some(2)).await;
        insert_battle(&pool, "b2", "win", Some(2)).await; // プレイヤー行なし
        insert_player(&pool, "b1", 0, 1, 0, 1).await;

        let with: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ai_battles WHERE has_players = 1")
            .fetch_one(pool.as_ref()).await.unwrap();
        let without: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ai_battles WHERE has_players = 0")
            .fetch_one(pool.as_ref()).await.unwrap();
        assert_eq!((with, without), (1, 1));
    }

    #[tokio::test]
    async fn ギアが8人分取れる() {
        let pool = setup().await;
        insert_battle(&pool, "b1", "win", Some(2)).await;
        // マイグレーション v6 が ability を seed 済みなので、衝突しない ID を使う。
        sqlx::query("INSERT INTO ability (id, key) VALUES (9001, 'test_main'), (9002, 'test_sub')")
            .execute(pool.as_ref()).await.unwrap();
        sqlx::query(
            "INSERT INTO gear_configuration (id, primary_ability_id, sub1_ability_id)
             VALUES (9001, 9001, 9002)",
        ).execute(pool.as_ref()).await.unwrap();
        // 相手のギアも読める（自分だけではない）
        sqlx::query(
            "INSERT INTO battle_player
               (battle_id, is_our_team, rank_in_team, is_me, weapon_id, headgear_id,
                kill, assist, kill_or_assist, death, special, inked)
             VALUES ('b1', 0, 1, 0, 1, 9001, 1, 1, 2, 1, 1, 100)",
        ).execute(pool.as_ref()).await.unwrap();

        let row = sqlx::query(
            "SELECT head_primary, head_sub1, head_sub2, clothing_primary
             FROM ai_battle_players WHERE is_our_team = 0",
        ).fetch_one(pool.as_ref()).await.unwrap();
        assert_eq!(row.get::<String, _>("head_primary"), "test_main");
        assert_eq!(row.get::<String, _>("head_sub1"), "test_sub");
        assert!(row.get::<Option<String>, _>("head_sub2").is_none(), "空きスロットは NULL");
        assert!(row.get::<Option<String>, _>("clothing_primary").is_none(), "未設定の部位は NULL");
    }

    /// `rule` を INNER JOIN に「直して」しまう回帰を防ぐ。
    /// 上の `詳細未取得で…` テストが本体だが、意図をコード上にも残す。
    #[test]
    fn rule_は_left_join_でなければならない() {
        assert!(
            AI_VIEWS_SQL.contains("LEFT JOIN rule"),
            "battle.rule_id は nullable(v11)。INNER JOIN にすると詳細未取得のバトルが黙って落ちる"
        );
    }

    /// ドメイン知識から**落ちてはいけない事実**が残っているか。
    ///
    /// 文書なので細かい表現は変わってよいが、ここに挙げた規約が消えると
    /// AI が「動くけれど意味の違う集計」を書くようになる。節ごと削除する事故を防ぐ。
    #[test]
    fn ドメイン知識に要となる規約が残っている() {
        let doc = DOMAIN_KNOWLEDGE;
        for must in [
            // 日付をずらすと 1 日ずれる
            "9 時境界",
            // KDA と勝率で母数が違う
            "has_kda",
            // 投稿者は母数外
            "投稿者",
            // ナワバリは塗り率で決まるので指標の意味が違う
            "ナワバリ",
            // ギアの AP 重み
            "10AP",
            // 味方ブキの合計はバトル数を超える
            "3〜4 倍",
            // 足切りしないと 5 戦のブキが 1 位になる
            "足切り",
            // 相関を因果と書かせない
            "相関",
        ] {
            assert!(doc.contains(must), "ドメイン知識から「{must}」が消えている");
        }
    }

    /// プロンプトはビュー一覧とドメイン知識の両方を含み、トークンが暴れない大きさに収まるか。
    #[test]
    fn プロンプトが両方を含み大きさが妥当() {
        let p = analysis_prompt();
        assert!(p.contains("ai_battles"), "ビュー一覧が入っていない");
        assert!(p.contains("9 時境界"), "ドメイン知識が入っていない");
        // 目安。データは 1 行も入らない前提なので、これを大きく超えたら何か混ざっている。
        assert!(
            p.chars().count() < 20_000,
            "プロンプトが大きすぎる: {} 文字",
            p.chars().count()
        );
    }

    #[test]
    fn プロンプトに全ビューと全列が出る() {
        let s = schema_prompt();
        for v in AI_VIEWS {
            assert!(s.contains(v.name), "{} がプロンプトに出ていない", v.name);
            for (col, _) in v.columns {
                assert!(s.contains(col), "{}.{} がプロンプトに出ていない", v.name, col);
            }
        }
    }
}
