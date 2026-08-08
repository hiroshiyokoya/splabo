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
//! # 環境（stat.ink）側
//!
//! `ai_env_slots` は 1 行 = バトル × 投稿者を除く 7 スロット。**投稿者（`a1`）は含めない**
//! （#501・stat.ink の全体統計と同じ数え方）。SQL は 7 way の UNION ALL になるが、
//! 手書きするとスロットの取り違え（`a2` の勝敗に `a3` の KDA を付ける等）が静かに起きるので
//! Rust 側で生成する。

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

/// 環境ビューが展開するスロットと、そのスロットが属するチーム。
///
/// 🔴 **投稿者（`a1`）を含めてはいけない。** stat.ink の全体統計は投稿者を母数から外して
/// おり（自分のバトルだけを上げる人が多く、投稿者のブキと勝敗に偏りが出る）、splabo も
/// それに倣っている（#501）。`db.rs` の `SELF_SLOTS` / `OPP_SLOTS` と同じ 7 スロット。
const ENV_SLOTS: &[(&str, &str)] = &[
    ("a2", "alpha"),
    ("a3", "alpha"),
    ("a4", "alpha"),
    ("b1", "bravo"),
    ("b2", "bravo"),
    ("b3", "bravo"),
    ("b4", "bravo"),
];

/// `ai_env_slots` の DDL を組む。
///
/// 7 way の UNION ALL を手書きすると、スロット名を 1 か所書き間違えただけで
/// 「あるブキの行に別スロットの KDA が付く」という**気づけない壊れ方**をする。
/// スロット定義を 1 つ持って生成する。
///
/// 🔴 `lobby` / `rule` / `map` は **LEFT JOIN**。`env_battles` のこれらは NOT NULL 制約が
/// 無く、取り込み時に解決できなければ NULL になる。INNER JOIN にすると黙って母数が減る。
fn env_view_sql() -> String {
    let selects: Vec<String> = ENV_SLOTS
        .iter()
        .map(|(slot, team)| {
            format!(
                "SELECT
    eb.id                                           AS battle_id,
    eb.source_date                                  AS source_date,
    eb.season                                       AS season,
    eb.game_ver                                     AS game_ver,
    l.key                                           AS lobby,
    r.key                                           AS rule,
    COALESCE(m.name_ja, m.key)                      AS stage,
    eb.poster_rank                                  AS poster_rank,
    eb.poster_power                                 AS poster_power,
    '{slot}'                                        AS slot,
    {is_poster_team}                                AS is_poster_team,
    COALESCE(w.name_ja, w.key)                      AS weapon,
    COALESCE(NULLIF(w.category_key, ''), '(未分類)') AS weapon_category,
    COALESCE(w.sub_key,     '(不明)')                AS sub_weapon,
    COALESCE(w.special_key, '(不明)')                AS special_weapon,
    CASE eb.win_team WHEN '{team}' THEN 1 WHEN 'alpha' THEN 0 WHEN 'bravo' THEN 0 END AS won,
    eb.knockout                                     AS is_knockout,
    eb.{slot}_kill                                  AS kill,
    eb.{slot}_death                                 AS death,
    eb.{slot}_assist                                AS assist,
    eb.{slot}_inked                                 AS inked,
    CASE WHEN eb.{slot}_kill IS NOT NULL THEN 1 ELSE 0 END AS has_kda
FROM env_battles eb
JOIN      weapon w ON w.id = eb.{slot}_weapon_id
LEFT JOIN lobby  l ON l.id = eb.lobby_id
LEFT JOIN rule   r ON r.id = eb.rule_id
LEFT JOIN map    m ON m.id = eb.map_id",
                slot = slot,
                team = team,
                // 投稿者チーム = alpha 側。`a*` なら 1。
                is_poster_team = if team == &"alpha" { 1 } else { 0 },
            )
        })
        .collect();

    format!(
        "DROP VIEW IF EXISTS ai_env_slots;\nCREATE VIEW ai_env_slots AS\n{};\n",
        selects.join("\nUNION ALL\n")
    )
}

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
        row_meaning: "1 行 = 自分が遊んだバトル 1 件。\
                      battle_id は一意なので GROUP BY battle_id は意味を持たない（グループが 1 行ずつになる）。\
                      勝率は AVG(won)、バトル数は COUNT(*) で出す",
        columns: &[
            ("battle_id", "バトルの ID。他のビューと結合するキー。**一意なので集計の単位には使わない**"),
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
        name: "ai_env_slots",
        row_meaning: "1 行 = 環境データ（stat.ink の全世界のバトル）1 件 × スロット 1 つ。\
                      スロットは投稿者本人を除く 7 人分（味方 3 + 相手 4）。\
                      投稿者は母数に入っていない（stat.ink の全体統計と同じ数え方）",
        columns: &[
            ("battle_id", "環境バトルの ID"),
            ("source_date", "stat.ink 上の日付"),
            ("season", "シーズン"),
            ("game_ver", "ゲームのバージョン。バランス調整で環境が変わるので、期間を跨ぐ比較では絞ること"),
            ("lobby", "regular / bankara_open / bankara_challenge / xmatch など。解決できなければ NULL"),
            ("rule", "nawabari / area / yagura / hoko / asari。解決できなければ NULL"),
            ("stage", "ステージ名（和名）"),
            ("poster_rank", "**投稿者本人**のウデマエ。この行のプレイヤーのものではない。\
                             環境をウデマエで分けるときはこの列を使う（このビューに rank_before は無い）"),
            ("poster_power", "**投稿者本人**の X パワー。この行のプレイヤーのものではない\
                              （このビューに x_power_before は無い）"),
            ("slot", "a2 / a3 / a4 / b1 / b2 / b3 / b4。投稿者の a1 は含まれない"),
            ("is_poster_team", "投稿者と同じチーム（a 側）なら 1"),
            ("weapon", "そのスロットのブキ（和名）"),
            ("weapon_category", "ブキのカテゴリ"),
            ("sub_weapon", "サブウェポン"),
            ("special_weapon", "スペシャルウェポン"),
            ("won", "このスロットのチームが勝ったら 1、負けたら 0、判定不能なら NULL。AVG(won) が勝率になる"),
            ("is_knockout", "ノックアウト決着なら 1"),
            ("kill", "そのスロットのキル数。記録が無ければ NULL"),
            ("death", "デス数。記録が無ければ NULL"),
            ("assist", "アシスト数。記録が無ければ NULL"),
            ("inked", "塗りポイント。記録が無ければ NULL"),
            ("has_kda", "KDA が記録されている行なら 1。再取得前のデータは 1 人分しか記録が無いので、KDA を見る集計では WHERE has_kda で絞る"),
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
    sqlx::raw_sql(&env_view_sql())
        .execute(pool.as_ref())
        .await
        .map_err(|e| format!("AI 用ビュー(環境)の作成に失敗: {e}"))?;
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

/// AI が踏みやすい間違い。実機で実際に出たものを足していく。
const COMMON_MISTAKES: &[&str] = &[
    "各ビューの「1 行が何か」を必ず確認する。ai_battles の battle_id は一意なので、\
     GROUP BY battle_id はグループが 1 行ずつになるだけで意味がない",
    "足切りはグループごとの件数に対して行う。グループが 1 行しかない集計に \
     HAVING COUNT(*) >= 5 を付けると、全部消えて 0 件になる",
    "相関を聞かれたら平均を並べず corr() を使う。平均を見比べても相関は分からない",
    "🔴 **相関を取る列で GROUP BY しない。** `corr(won, kill)` を出すのに `GROUP BY won` と\
     書くと、群の中で `won` が定数になって分散 0 になり、**必ず NULL が返る**。\
     相関は群の中で両方の値が動いている必要がある",
    "🔴 **複数の指標の相関は 1 回のスキャンで取る。** 指標ごとに `UNION ALL` で分けると\
     同じ行を何度も読む（4 指標で 4 回）。まず `SELECT corr(won, kill) AS キル, \
     corr(won, death) AS デス, ... FROM ... WHERE ...` と**横に並べて 1 行で取り**、\
     その結果を `UNION ALL` で縦に展開する。実測で 5.0 秒 → 0.59 秒",
    "🔴 **`UNION ALL` の各ブランチに絞り込みを書く。** CTE や 1 つのブランチに \
     `WHERE` を書いても他のブランチには効かない。書き忘れたブランチが全件スキャンする",
    "SQLite の日付修飾子は `start of day` / `start of month` / `start of year` だけ。\
     **`start of season` は存在しない**（式全体が NULL になり 1 行も一致しなくなる）。\
     シーズンで絞るときは「データの規模」に載っている**シーズンの開始日**を使う",
    "🔴 **シーズンで絞る（WHERE）ときは `season` 列を使わず `source_date` の範囲で絞る。**\
     `season` にはインデックスが無く、実測で 15 倍遅い（8.7 秒 → 0.59 秒）。\
     シーズン名と日付の対応は「データの規模」に載っている。\
     ただし**シーズンごとに集計する（GROUP BY）なら `season` 列を使ってよい**。\
     `strftime('%Y-%m', source_date)` で月に丸めるのは**シーズンではない**（シーズンは 3 か月）",
    "シーズンごとの集計は重い（実測: 全期間 30 秒 / 直近 2 年 9.6 秒 / 直近 4 シーズン 4.7 秒）。\
     ただし**「シーズンごと」と言われたら期間を絞らない**。\
     勝手に絞ると出るシーズンが減って質問に答えたことにならない。\
     「最近の」「直近の」と限定されたときだけ `source_date` で絞る",
    "🔴 **シーズン名は時系列順に並ばない。** `Chill` < `Drizzle` < `Fresh` < `Sizzle` の\
     辞書順になるので、`ORDER BY season` では新しい順にならない\
     （Sizzle 2026 → Sizzle 2025 → Fresh 2026 のように混ざる）。\
     並べ替えは**日付で**行う。集計時に `MIN(source_date)` を残しておき、それで並べる。\
     `CASE WHEN シーズン = 'Sizzle Season 2026' THEN 1 ...` のように**順序を手で書かない**\
     （シーズンは 3 か月ごとに増えるので、書いた瞬間から古くなる）。\
     また `ORDER BY` に集計関数は書けない（`misuse of aggregate` になる）",
    "🔴 **上位 N を出す前に、群 × 対象で 1 行にまとめる。**\
     `GROUP BY season, weapon` を先にやらずに順位を振ると、\
     **同じブキが 1 位と 3 位に並ぶ**（1 行 = 1 スロットのまま数えている）",
    "**ピック率の分母はその群の全スロット数**。\
     `COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (PARTITION BY season)` のように、\
     群ごとの合計で割る。分母を取り違えると 100% や 50% ばかりが並ぶ\
     （ブキは 100 種類以上あるので、上位でも数 % にしかならない）",
    "UNION ALL で並べた結果を並べ替えるときは、**全体を副問い合わせで包む**。\
     複合 SELECT の ORDER BY には式を書けず、列名か位置しか使えない",
    "🔴 **表の形は考えなくてよい。縦長（long format）で返す。**\
     質問が「行は〜、列は〜」と形を指定していても、**ピボットは後段のアプリが行う**。\
     1 行 = 1 つの組み合わせにして、必要な値をそれぞれ別の列に出す。\
     `MAX(CASE WHEN 順位 = 1 THEN ... END)` のような列方向への展開は書かない",
    "🔴 **値を文字列に連結しない。** `ブキ || ' ' || 勝率` ではなく、\
     `weapon AS ブキ` と `ROUND(AVG(won) * 100, 1) AS 勝率` を**別の列**で返す。\
     セルに何を並べるかは後段が決めるので、連結すると後段が数値を扱えなくなる",
    "**群ごとの上位 N** は `ROW_NUMBER() OVER (PARTITION BY 群 ORDER BY 指標 DESC)` で\
     順位を振ってから `WHERE 順位 <= N` で絞る。\
     全体の `LIMIT N` や `ORDER BY 群, 指標` だけでは**群ごとの上位にならない**。\
     **順位の列も結果に出す**（後段が列見出しに使う）",
    "複数指標の相関を比べるときは、横に corr 列を並べた行から ROW_NUMBER するのではなく、\
     **UNION ALL で縦に並べてから** `PARTITION BY 群` で順位を振る",
    "数値を帯に区切るときは `CAST(x / 500 AS INT) * 500` のように**数値のまま**作り、\
     並べ替えもその数値で行う。`'500-999'` のような文字列で ORDER BY すると\
     辞書順になり `'3000+'` より後に来る。表示用の文字列は最後に組み立てる",
    "🔴 `ai_env_slots` を使うときは **`source_date` で期間を必ず絞る**。\
     環境データは 500 万バトル超（1 バトル 7 行なので数千万行）あり、\
     **全期間の集計は 70 秒以上かかって必ず中断される**。直近 30 日なら 1 秒未満。\
     質問が期間を指定していないなら `source_date >= date('now', '-30 days')` を付け、\
     どの期間で集計したかを explanation に書く",
    "期間の最新日を `ai_env_slots` から取らない。\
     `SELECT MAX(source_date) FROM ai_env_slots` は 100 秒以上かかる。\
     データがある期間は「データの規模」に書いてあるのでそれを使う",
    "群ごとの合計に対する**割合**は、必ず**ウィンドウ関数**で出す。\
     `COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (PARTITION BY poster_rank)`。\
     `(SELECT COUNT(*) FROM ai_env_slots WHERE poster_rank = es.poster_rank)` のように\
     **大きいビューを 1 行ごとに数え直す副問い合わせは必ずタイムアウトする**\
     （`battle_id` で 1 件を引くだけの副問い合わせは軽いので問題ない）",
    "ビューごとに列が違う。列を他のビューから借りてこないこと。\
     とくに**ウデマエ**は、自分の戦績（ai_battles）では rank_before / rank_after、\
     環境（ai_env_slots）では poster_rank。名前が違うだけでなく、\
     ai_env_slots に rank_before は存在しない",
];

/// AI に見せる書き方の実例（few-shot）。
///
/// 🔴 **ここの SQL は実際に実行できることをテストで検証している。**
/// 関数の一覧だけ渡しても使いどころが伝わらないので実例が要るが、**壊れた例を渡すと
/// AI はそれを忠実に真似する**（複合 SELECT の ORDER BY で実際に踏んだ）。
pub const SQL_EXAMPLES: &[(&str, &str)] = &[
    (
        "勝率と最も相関の高いバトル指標は？",
        // 複合 SELECT の ORDER BY に ABS(...) は書けないので、副問い合わせで包む。
        "SELECT * FROM (\n\
         \x20 SELECT '平均キル' AS 指標, corr(won, kill) AS 相関係数, COUNT(won) AS 件数 FROM ai_battles\n\
         \x20 UNION ALL SELECT '平均デス',     corr(won, death),  COUNT(won) FROM ai_battles\n\
         \x20 UNION ALL SELECT '平均アシスト', corr(won, assist), COUNT(won) FROM ai_battles\n\
         \x20 UNION ALL SELECT '平均塗り',     corr(won, inked),  COUNT(won) FROM ai_battles\n\
         ) ORDER BY ABS(相関係数) DESC",
    ),
    (
        // 実機で踏んだ。横に corr 列を並べて GREATEST + ROW_NUMBER すると壊れる。
        // 縦に UNION ALL → PARTITION BY ルール で順位を振る。
        // 🔴 ピボットはしない。指標名・相関係数・順位を**別々の列**で返し、表の形は後段が作る。
        "ルールごとに勝率と相関が高い指標の上位5つ。ルール×相関係数の表で、セルには指標と相関係数を並べて",
        "WITH 指標 AS (\n\
         \x20 SELECT rule AS ルール, 'キル' AS 指標, corr(won, kill) AS 相関係数 FROM ai_battles\n\
         \x20   WHERE rule IS NOT NULL GROUP BY rule HAVING COUNT(*) >= 30\n\
         \x20 UNION ALL SELECT rule, 'デス', corr(won, death) FROM ai_battles\n\
         \x20   WHERE rule IS NOT NULL GROUP BY rule HAVING COUNT(*) >= 30\n\
         \x20 UNION ALL SELECT rule, 'アシスト', corr(won, assist) FROM ai_battles\n\
         \x20   WHERE rule IS NOT NULL GROUP BY rule HAVING COUNT(*) >= 30\n\
         \x20 UNION ALL SELECT rule, '塗り', corr(won, inked) FROM ai_battles\n\
         \x20   WHERE rule IS NOT NULL GROUP BY rule HAVING COUNT(*) >= 30\n\
         \x20 UNION ALL SELECT rule, '貢献キル', corr(won, kill_or_assist) FROM ai_battles\n\
         \x20   WHERE rule IS NOT NULL GROUP BY rule HAVING COUNT(*) >= 30\n\
         ), 順位付き AS (\n\
         \x20 SELECT *, ROW_NUMBER() OVER (PARTITION BY ルール ORDER BY ABS(相関係数) DESC) AS 順位\n\
         \x20 FROM 指標 WHERE 相関係数 IS NOT NULL\n\
         )\n\
         SELECT ルール, 順位, 指標, ROUND(相関係数, 3) AS 相関係数\n\
         FROM 順位付き WHERE 順位 <= 5\n\
         ORDER BY ルール, 順位",
    ),
    (
        // 実機で踏んだ。4 分岐の UNION ALL は 3900 万行を 4 回スキャンして 5 秒（season で
        // 絞ると 36 秒）。**1 回スキャンして横に取り、それを縦に展開**すれば 0.59 秒。
        // シーズンは season 列ではなく **source_date の範囲**で絞る（season にインデックスが無い）。
        "今シーズンのXマッチで、勝率と最も相関の高いバトル指標は？",
        "WITH 相関 AS (\n\
         \x20 -- 🔴 スキャンは 1 回だけ。指標ごとに UNION ALL で分けると同じ行を何度も読む。\n\
         \x20 SELECT corr(won, kill) AS キル, corr(won, death) AS デス,\n\
         \x20        corr(won, assist) AS アシスト, corr(won, inked) AS 塗り,\n\
         \x20        COUNT(won) AS 件数\n\
         \x20 FROM ai_env_slots\n\
         \x20 WHERE lobby = 'xmatch'\n\
         \x20   -- シーズンの開始日は「データの規模」の一覧から選ぶ（season 列では絞らない）。\n\
         \x20   AND source_date >= '2026-06-01'\n\
         )\n\
         SELECT * FROM (\n\
         \x20 SELECT '平均キル' AS 指標, キル AS 相関係数, 件数 FROM 相関\n\
         \x20 UNION ALL SELECT '平均デス',     デス,     件数 FROM 相関\n\
         \x20 UNION ALL SELECT '平均アシスト', アシスト, 件数 FROM 相関\n\
         \x20 UNION ALL SELECT '平均塗り',     塗り,     件数 FROM 相関\n\
         ) WHERE 相関係数 IS NOT NULL ORDER BY ABS(相関係数) DESC",
    ),
    (
        // 実機で踏んだ。月に丸められ、同じブキが 1 位と 3 位に並び、ピック率が 100% になった。
        // ① シーズンは season 列で GROUP BY（月ではない）
        // ② 上位 N の前に GROUP BY season, weapon で 1 行にまとめる（重複を出さない）
        // ③ ピック率の分母はそのシーズンの全スロット
        // ④ 全期間は 44 秒かかるので、直近数シーズンに絞る（4 シーズンで 6.4 秒）
        "シーズンごとのXマッチのピック率上位 5 ブキ（新しい順）",
        // 🔴 ⑤ 並べ替えは**シーズン名ではなく開始日**で行う。
        // 名前は辞書順で Chill < Drizzle < Fresh < Sizzle になり、時系列にならない。
        "WITH 集計 AS (\n\
         \x20 SELECT season AS シーズン, MIN(source_date) AS 開始日,\n\
         \x20        weapon AS ブキ, COUNT(*) AS 出現数,\n\
         \x20        ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (PARTITION BY season), 2) AS ピック率\n\
         \x20 FROM ai_env_slots\n\
         \x20 -- 「シーズンごと」と言われたら**期間を絞らない**（全シーズンを出す）。\n\
         \x20 -- 直近だけでよいと言われたときだけ source_date >= '...' を足す。\n\
         \x20 WHERE lobby = 'xmatch' AND season IS NOT NULL\n\
         \x20 GROUP BY season, weapon\n\
         ), 順位付き AS (\n\
         \x20 SELECT *, MIN(開始日) OVER (PARTITION BY シーズン) AS シーズン開始,\n\
         \x20        ROW_NUMBER() OVER (PARTITION BY シーズン ORDER BY ピック率 DESC) AS 順位\n\
         \x20 FROM 集計\n\
         )\n\
         SELECT シーズン, 順位, ブキ, ピック率, 出現数 FROM 順位付き\n\
         WHERE 順位 <= 5 ORDER BY シーズン開始 DESC, 順位",
    ),
    (
        "ステージ別の勝率を 20 戦以上で",
        "SELECT stage AS ステージ, ROUND(AVG(won) * 100, 1) AS 勝率, COUNT(won) AS 件数\n\
         FROM ai_battles GROUP BY stage HAVING COUNT(won) >= 20 ORDER BY 勝率 DESC",
    ),
    (
        "ウデマエ帯ごとの武器使用率を上位 10 件",
        // 🔴 source_date の絞り込みは**必須**。実データ（550 万バトル = 3900 万行）では
        // 全期間の集計に 77 秒かかり、必ずタイムアウトする。直近 30 日なら 0.7 秒。
        "SELECT poster_rank AS ウデマエ, weapon AS ブキ, COUNT(*) AS 出現数,\n\
         \x20      ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (PARTITION BY poster_rank), 2) AS 使用率\n\
         FROM ai_env_slots\n\
         WHERE poster_rank IS NOT NULL AND source_date >= date('now', '-30 days')\n\
         GROUP BY poster_rank, weapon ORDER BY 使用率 DESC LIMIT 10",
    ),
    (
        // 実機で踏んだ 3 点をまとめて示す例。
        // ① 群ごとの上位 N は ROW_NUMBER、② 数値の帯は数値で作って数値で並べる、
        // ③ 🔴 **形を指定されてもピボットしない**（後段が組み替える）。
        // 帯・順位・ブキ・勝率を別々の列で返せば、後段が行 = 帯・列 = 順位の表にできる。
        "Xパワーを 500 ごとに区切って、パワー帯ごとの勝率上位 5 ブキを、行 = 帯・列 = 順位で",
        "WITH 帯 AS (\n\
         \x20 SELECT CAST(poster_power / 500 AS INT) * 500 AS 下限, weapon, won\n\
         \x20 FROM ai_env_slots\n\
         \x20 WHERE poster_power IS NOT NULL AND source_date >= date('now', '-30 days')\n\
         ), 集計 AS (\n\
         \x20 SELECT 下限, weapon AS ブキ, ROUND(AVG(won) * 100, 1) AS 勝率, COUNT(won) AS 件数\n\
         \x20 FROM 帯 GROUP BY 下限, weapon HAVING COUNT(won) >= 50\n\
         ), 順位付き AS (\n\
         \x20 SELECT *, ROW_NUMBER() OVER (PARTITION BY 下限 ORDER BY 勝率 DESC) AS 順位 FROM 集計\n\
         )\n\
         SELECT 下限 || '〜' || (下限 + 499) AS Xパワー帯, 順位, ブキ, 勝率, 件数\n\
         FROM 順位付き WHERE 順位 <= 5\n\
         ORDER BY 下限, 順位",
    ),
    (
        "相手にイカ速を積んでいる人が多いと勝ちにくい？",
        "SELECT CASE WHEN 積み人数 = 0 THEN '0 人' WHEN 積み人数 <= 2 THEN '1〜2 人' ELSE '3 人以上' END AS 相手の人数,\n\
         \x20      ROUND(AVG(won) * 100, 1) AS 勝率, COUNT(won) AS 件数\n\
         FROM (\n\
         \x20 SELECT b.battle_id, b.won,\n\
         \x20        (SELECT COUNT(*) FROM ai_battle_players p\n\
         \x20          WHERE p.battle_id = b.battle_id AND p.is_our_team = 0\n\
         \x20            AND 'run_speed_up' IN (p.head_primary, p.clothing_primary, p.shoes_primary)) AS 積み人数\n\
         \x20 FROM ai_battles b WHERE b.has_players = 1\n\
         ) GROUP BY 相手の人数 ORDER BY 相手の人数",
    ),
];

/// プロンプトに載せるデータの規模。
///
/// **期間の絞り方を AI に決めさせるために要る。** 環境データは全期間で数千万行あり、
/// 絞らないと必ずタイムアウトする。一方 `date('now', '-30 days')` と書かせるには、
/// **そこにデータがある**ことが分かっていないといけない（取り込みが古いと 0 件になる）。
///
/// バトルの中身は含まない。件数と日付の範囲だけ。
pub struct DataScale {
    pub env_battles: i64,
    pub env_min_date: Option<String>,
    pub env_max_date: Option<String>,
    pub my_battles: i64,
    /// `lobby` 列に実際に入っている値。推測させないために載せる。
    pub lobbies: Vec<String>,
    /// `rule` 列に実際に入っている値。
    pub rules: Vec<String>,
}

/// プロンプトに載せるシーズンの件数。全部並べても読まれない。
const SEASONS_IN_PROMPT: usize = 6;

impl DataScale {
    fn to_prompt(&self) -> String {
        let mut s = String::from("---\n\n## データの規模\n\n");
        s.push_str(&format!("- 自分のバトル（`ai_battles`）: {} 件\n", self.my_battles));
        match (&self.env_min_date, &self.env_max_date) {
            (Some(min), Some(max)) => s.push_str(&format!(
                "- 環境データ（`ai_env_slots`）: {} バトル、{min} 〜 {max}\n\
                 \x20 - 1 バトルが 7 行になるので **{} 行** あります。\
                 **`source_date` で絞らない集計は中断されます**\n",
                self.env_battles,
                self.env_battles * 7,
            )),
            _ => s.push_str(
                "- 環境データ（`ai_env_slots`）: **まだ取り込まれていません**。\
                 環境の質問には答えられないので、そう伝える SQL ではなく\
                 自分のバトルで答えられる形に読み替えてください\n",
            ),
        }

        if !self.lobbies.is_empty() {
            s.push_str(&format!(
                "\n`lobby` に入っている値: {}\n",
                self.lobbies.iter().map(|v| format!("`{v}`")).collect::<Vec<_>>().join(", ")
            ));
        }
        if !self.rules.is_empty() {
            s.push_str(&format!(
                "`rule` に入っている値: {}\n",
                self.rules.iter().map(|v| format!("`{v}`")).collect::<Vec<_>>().join(", ")
            ));
        }

        // 「今シーズン」を日付で表現できるようにする。
        // 🔴 season 列で絞らせない（インデックスが無く 15 倍遅い）。
        if let (Some(min), Some(max)) = (&self.env_min_date, &self.env_max_date) {
            let seasons = crate::season::seasons_in(min, max, SEASONS_IN_PROMPT);
            if !seasons.is_empty() {
                s.push_str(
                    "\n### シーズン\n\n\
                     **絞り込み（WHERE）に `season` 列を使わないでください**（インデックスが無く 15 倍遅い）。\
                     下の開始日・終了日を `source_date` の条件に使ってください。\n\n\
                     **シーズンごとに集計する（GROUP BY）ときは `season` 列を使ってください。**\
                     月に丸めるとシーズンになりません（シーズンは 3 か月）。\
                     全期間だと重いので、期間を直近数シーズンに絞ってから集計してください。\n\n",
                );
                for (i, sea) in seasons.iter().enumerate() {
                    // 最新シーズンの終端はまだ未来なので、データの最終日で止める。
                    let until = if i == 0 && sea.until.as_str() > max.as_str() {
                        format!("{max}（データの最終日）")
                    } else {
                        sea.until.clone()
                    };
                    s.push_str(&format!(
                        "- {}{} — `source_date >= '{}' AND source_date <= '{}'`\n",
                        sea.name,
                        if i == 0 { "（**今シーズン**）" } else { "" },
                        sea.since,
                        until,
                    ));
                }
            }
        }
        s.push('\n');
        s
    }
}

/// AI に渡すプロンプトの土台。
///
/// **ビューの一覧 + データの規模 + 使える関数 + よくある間違い + ドメイン知識 + 実例。**
/// バトルの中身は含まない。載るのは「どんな列があるか」「その意味」「件数と期間の範囲」だけ。
///
/// フロント側に散らさないのは、**プロンプトの中身をテストできる場所に置く**ため。
/// 実例の SQL は実際に実行して検証している（壊れた例を渡すと AI が真似する）。
pub fn analysis_prompt(scale: Option<&DataScale>) -> String {
    let mut s = schema_prompt();

    if let Some(scale) = scale {
        s.push_str(&scale.to_prompt());
    }

    s.push_str("---\n\n## 使える統計関数\n\nこのアプリが SQLite に足したものです。\
                いずれも引数に NULL がある行は母数から外れ、件数不足や分散 0 では NULL を返します。\n\n");
    for (sig, desc) in crate::sql_functions::FUNCTION_DOCS {
        s.push_str(&format!("- `{sig}` — {desc}\n"));
    }

    s.push_str("\n## よくある間違い\n\n");
    for m in COMMON_MISTAKES {
        s.push_str(&format!("- {m}\n"));
    }

    s.push_str("---\n\n");
    s.push_str(DOMAIN_KNOWLEDGE);

    // 🔴 実例は**最後**に置く。実機で「ウデマエ帯ごとの武器使用率」（実例とほぼ同じ質問）に
    // 別のビューを選ばれた。長いドメイン知識を後ろに積むと実例が埋もれるので、末尾に移した。
    s.push_str("\n---\n\n## 書き方の例\n\n\
                質問が下のどれかに近いときは、**その SQL をそのまま土台にしてください。**\n\n");
    for (q, sql) in SQL_EXAMPLES {
        s.push_str(&format!("質問「{q}」\n\n```sql\n{sql}\n```\n\n"));
    }
    s
}

/// どのビューを使うかの案内。**列の説明より前に読ませる。**
///
/// 実機で「ウデマエ帯ごとのブキ使用率」に `ai_battle_players`（自分のバトルの同卓者）を
/// 選ばれた。列を並べるだけでは、**そもそも母集団の選択を間違える**。
const VIEW_CHOICE: &str = "\
まず**どのビューを使うか**を決めてください。母集団が違います。

| 聞かれていること | 使うビュー |
|---|---|
| 自分の勝率・成績・その推移 | `ai_battles` |
| 自分のバトルに居た人（味方・相手）のブキやギア | `ai_battle_players` |
| **世界全体の環境**（流行りのブキ、ブキの強さ、ウデマエ帯ごとの傾向） | `ai_env_slots` |
| 自分のバトルで「その陣営にそのブキが居たか」 | `ai_battle_weapon_presence` |

判断の目安:

- 「**環境**」「流行」「使用率」「ピック率」「world」「みんな」「一般に」\
——**自分の記録ではなく世界の話**なので `ai_env_slots`
- 「**ウデマエ帯ごと**」「Xパワー帯ごと」に世界の傾向を見るなら \
`ai_env_slots` の `poster_rank` / `poster_power` で分ける
- 「自分の」「私が」と付いていれば `ai_battles`（同卓者の話なら `ai_battle_players`）

`ai_battle_players` は**自分が遊んだバトルの参加者だけ**で、世界の使用率にはなりません。

";

/// AI に渡すスキーマ説明を組む。**ここが唯一の出力元**で、手書きの一覧を別に持たない。
pub fn schema_prompt() -> String {
    let mut s = String::from(VIEW_CHOICE);
    s.push_str(
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
            // 本番（init_db）と同じく統計関数を登録する。入れないとプロンプトの実例に
            // 出てくる corr() が「no such function」になり、実例の検証ができない。
            .after_connect(|conn, _meta| {
                Box::pin(async move {
                    let mut handle = conn.lock_handle().await?;
                    let failed = unsafe {
                        crate::sql_functions::register_all(handle.as_raw_handle().as_ptr())
                    };
                    assert!(failed.is_empty(), "統計関数の登録に失敗: {failed:?}");
                    Ok(())
                })
            })
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

    /// 環境バトル 1 件を入れる。8 スロット全員に武器を置き、KDA は `kda_slots` のみ埋める。
    async fn insert_env_battle(pool: &DbPool, id: i64, win_team: &str, kda_slots: &[&str]) {
        sqlx::query("INSERT OR IGNORE INTO lobby (id, key) VALUES (1, 'bankara_open')")
            .execute(pool.as_ref()).await.unwrap();
        sqlx::query("INSERT OR IGNORE INTO rule (id, key) VALUES (2, 'area')")
            .execute(pool.as_ref()).await.unwrap();
        sqlx::query("INSERT OR IGNORE INTO map (id, key, name_ja) VALUES (1, 'yunohana', 'ユノハナ大渓谷')")
            .execute(pool.as_ref()).await.unwrap();
        sqlx::query(
            "INSERT OR IGNORE INTO weapon (id, key, name_ja, category_key, sub_key, special_key)
             VALUES (1, 'splattershot', 'スプラシューター', 'shooter', 'kyubanbomb', 'kanibuki')",
        ).execute(pool.as_ref()).await.unwrap();

        sqlx::query(
            "INSERT INTO env_battles
               (id, source_date, lobby_id, rule_id, map_id, period, season, game_ver,
                win_team, knockout, poster_rank, poster_power,
                a1_weapon_id, a2_weapon_id, a3_weapon_id, a4_weapon_id,
                b1_weapon_id, b2_weapon_id, b3_weapon_id, b4_weapon_id)
             VALUES (?, '2026-07-30', 1, 2, 1, 'p', 'S9', '900',
                     ?, 1, 'splus', 2500.0,
                     1, 1, 1, 1, 1, 1, 1, 1)",
        )
        .bind(id).bind(win_team)
        .execute(pool.as_ref()).await.unwrap();

        for slot in kda_slots {
            sqlx::query(&format!(
                "UPDATE env_battles SET {slot}_kill = 5, {slot}_death = 3,
                                        {slot}_assist = 1, {slot}_inked = 900 WHERE id = ?"
            ))
            .bind(id)
            .execute(pool.as_ref()).await.unwrap();
        }
    }

    #[tokio::test]
    async fn 環境ビューは投稿者を除く7スロットを展開する() {
        let pool = setup().await;
        insert_env_battle(&pool, 1, "alpha", &[]).await;

        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ai_env_slots")
            .fetch_one(pool.as_ref()).await.unwrap();
        assert_eq!(n, 7, "1 バトルから 7 行（投稿者 a1 を除く）出るべき");

        let slots: Vec<String> = sqlx::query_scalar("SELECT slot FROM ai_env_slots ORDER BY slot")
            .fetch_all(pool.as_ref()).await.unwrap();
        assert_eq!(slots, vec!["a2", "a3", "a4", "b1", "b2", "b3", "b4"]);
        assert!(!slots.contains(&"a1".to_string()), "投稿者 a1 が混ざっている(#501)");
    }

    #[tokio::test]
    async fn 環境ビューの勝敗がチームごとに正しい() {
        let pool = setup().await;
        insert_env_battle(&pool, 1, "alpha", &[]).await;

        // alpha 勝ち → a* は won=1、b* は won=0
        let alpha_won: Vec<i64> = sqlx::query_scalar(
            "SELECT won FROM ai_env_slots WHERE is_poster_team = 1",
        ).fetch_all(pool.as_ref()).await.unwrap();
        assert_eq!(alpha_won, vec![1, 1, 1]);

        let bravo_won: Vec<i64> = sqlx::query_scalar(
            "SELECT won FROM ai_env_slots WHERE is_poster_team = 0",
        ).fetch_all(pool.as_ref()).await.unwrap();
        assert_eq!(bravo_won, vec![0, 0, 0, 0]);

        // 全 7 スロットの勝率は 3/7
        let rate: f64 = sqlx::query_scalar("SELECT AVG(won) FROM ai_env_slots")
            .fetch_one(pool.as_ref()).await.unwrap();
        assert!((rate - 3.0 / 7.0).abs() < 1e-12, "勝率 = {rate}");
    }

    #[tokio::test]
    async fn 環境ビューの_has_kda_で記録済みだけ絞れる() {
        let pool = setup().await;
        // 再取得前のデータを模して b1 だけ KDA を持たせる
        insert_env_battle(&pool, 1, "bravo", &["b1"]).await;

        let with: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ai_env_slots WHERE has_kda = 1")
            .fetch_one(pool.as_ref()).await.unwrap();
        assert_eq!(with, 1, "KDA があるのは b1 だけ");

        let without: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ai_env_slots WHERE has_kda = 0")
            .fetch_one(pool.as_ref()).await.unwrap();
        assert_eq!(without, 6);

        // has_kda で絞れば平均キルが母数の違いに引きずられない
        let avg: f64 = sqlx::query_scalar(
            "SELECT AVG(kill) FROM ai_env_slots WHERE has_kda = 1",
        ).fetch_one(pool.as_ref()).await.unwrap();
        assert!((avg - 5.0).abs() < 1e-12, "平均キル = {avg}");
    }

    /// スロット定義そのものの回帰防止。投稿者を足すと環境の全数字が変わる。
    #[test]
    fn 環境スロットは投稿者を除く7つ() {
        assert_eq!(ENV_SLOTS.len(), 7);
        assert!(!ENV_SLOTS.iter().any(|(s, _)| *s == "a1"), "投稿者 a1 は母数外(#501)");
        let alpha = ENV_SLOTS.iter().filter(|(_, t)| *t == "alpha").count();
        let bravo = ENV_SLOTS.iter().filter(|(_, t)| *t == "bravo").count();
        assert_eq!((alpha, bravo), (3, 4), "味方 3 人 + 相手 4 人");
    }

    /// 生成 SQL でスロット名が取り違えられていないか。
    /// 「a2 の行に a3 の KDA が付く」類は実データでは気づけないので、SQL の形で確かめる。
    #[test]
    fn 環境ビューの各スロットが自分の列だけを参照する() {
        let sql = env_view_sql();
        for (slot, _) in ENV_SLOTS {
            let block = sql
                .split("UNION ALL")
                .find(|b| b.contains(&format!("'{slot}'                                        AS slot")))
                .unwrap_or_else(|| panic!("{slot} のブロックが見つからない"));
            for (other, _) in ENV_SLOTS {
                if other == slot {
                    continue;
                }
                assert!(
                    !block.contains(&format!("eb.{other}_")),
                    "{slot} のブロックが {other} の列を参照している"
                );
            }
        }
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

    /// 🔴 **プロンプトに載せている実例が、実際に実行できるか。**
    ///
    /// 初版では相関の例に `UNION ALL ... ORDER BY ABS(相関係数)` を書いていて、
    /// SQLite の複合 SELECT では ORDER BY に式が使えないため実行できなかった。
    /// **AI は壊れた例を忠実に真似する**ので、例そのものを検証する。
    ///
    /// データは空でよい（構文と列名の妥当性を見る）。
    #[tokio::test]
    async fn プロンプトの実例がすべて実行できる() {
        let pool = setup().await;
        for (question, sql) in SQL_EXAMPLES {
            let r = sqlx::query(sql).fetch_all(pool.as_ref()).await;
            assert!(
                r.is_ok(),
                "実例が実行できない（質問「{question}」）: {}\n{sql}",
                r.err().map(|e| e.to_string()).unwrap_or_default()
            );
        }
    }

    #[test]
    fn プロンプトに関数と実例とよくある間違いが載る() {
        let p = analysis_prompt(None);
        for (sig, _) in crate::sql_functions::FUNCTION_DOCS {
            assert!(p.contains(sig), "{sig} がプロンプトに無い");
        }
        for (q, _) in SQL_EXAMPLES {
            assert!(p.contains(q), "実例「{q}」がプロンプトに無い");
        }
        assert!(p.contains("GROUP BY battle_id"), "粒度の注意がプロンプトに無い");
        assert!(p.contains("複合 SELECT"), "複合 SELECT の注意がプロンプトに無い");
    }

    /// **どのビューを使うか**の案内が、列の説明より前に出ているか。
    ///
    /// 実機で「ウデマエ帯ごとのブキ使用率」に `ai_battle_players`（自分のバトルの同卓者）を
    /// 選ばれた。列を並べるだけでは母集団の選択を間違える。
    #[test]
    fn ビューの選び方が列の説明より前に出る() {
        let p = analysis_prompt(None);
        let choice = p.find("どのビューを使うか").expect("ビューの選び方が無い");
        let columns = p.find("- `battle_id`").expect("列の説明が無い");
        assert!(choice < columns, "ビューの選び方が列の説明より後ろにある");
        // 環境の質問を自分の記録のビューへ流さないための言い換え。
        assert!(p.contains("使用率"), "「使用率」の行き先が案内されていない");
        assert!(p.contains("世界"), "環境が世界の話だと書かれていない");
    }

    /// 実例が**縦長（long format）**を守っているか。
    ///
    /// 🔴 表の形は AI②（`ai_present`）とアプリが作る。実例にピボットが残っていると
    /// AI① がそれを真似して列方向へ展開し、後段が組み替えられなくなる。
    /// 実機で「形は SQL では守られない」と分かって役割を分けたので、境界をテストで守る。
    #[test]
    fn 実例はピボットしない() {
        for (q, sql) in SQL_EXAMPLES {
            assert!(
                !sql.contains("CASE WHEN 順位"),
                "実例「{q}」が列方向に展開している（ピボットは後段の仕事）: {sql}"
            );
            assert!(
                !sql.contains("|| ' ' ||"),
                "実例「{q}」が値を文字列に連結している（セルの組み立ては後段の仕事）: {sql}"
            );
        }
        let p = analysis_prompt(None);
        assert!(p.contains("縦長"), "縦長で返す指示がプロンプトに無い");
        assert!(p.contains("ピボットは後段"), "役割分担がプロンプトに書かれていない");
    }

    /// 群ごとの上位 N の実例が、**順位の列を結果に出している**か。
    ///
    /// 後段が列見出しに使うので、`WHERE 順位 <= 5` で絞るだけで列に出さないと
    /// ピボットできない。
    #[test]
    fn 順位で絞る実例は順位を列に出す() {
        for (q, sql) in SQL_EXAMPLES {
            if !sql.contains("ROW_NUMBER") {
                continue;
            }
            let select = sql.rsplit("SELECT").next().unwrap_or("");
            assert!(
                select.contains("順位"),
                "実例「{q}」が順位を結果に出していない: {select}"
            );
        }
    }

    /// プロンプトの内訳を見る（普段は走らせない）。
    ///
    /// 項目を足し続けると**後ろのものが埋もれる**（実例が埋もれて無視された前科がある）。
    /// 何がどれだけ場所を取っているかを、増やす前に確かめられるようにしておく。
    #[test]
    #[ignore]
    fn プロンプト計測() {
        let scale = DataScale {
            env_battles: 5_541_963,
            env_min_date: Some("2022-09-26".into()),
            env_max_date: Some("2026-07-29".into()),
            my_battles: 1_382,
            lobbies: vec!["xmatch".into()],
            rules: vec!["area".into()],
        };
        let full = analysis_prompt(Some(&scale));
        println!("--- プロンプトの内訳（文字数）---");
        println!("  全体              : {}", full.chars().count());
        println!("  ビュー定義        : {}", schema_prompt().chars().count());
        println!("  ドメイン知識      : {}", DOMAIN_KNOWLEDGE.chars().count());
        println!("  よくある間違い    : {} 項目 / {} 文字",
                 COMMON_MISTAKES.len(),
                 COMMON_MISTAKES.iter().map(|m| m.chars().count()).sum::<usize>());
        println!("  実例              : {} 件 / {} 文字",
                 SQL_EXAMPLES.len(),
                 SQL_EXAMPLES.iter().map(|(q, s)| q.chars().count() + s.chars().count()).sum::<usize>());
        println!("  データの規模      : {}", scale.to_prompt().chars().count());
        println!("--- よくある間違いの一覧 ---");
        for (i, m) in COMMON_MISTAKES.iter().enumerate() {
            let head: String = m.chars().take(40).collect();
            println!("  {:2}. {head}…", i + 1);
        }
    }

    /// 実例が**シーズン名で並べ替えていない**か。
    ///
    /// 🔴 実機で 2 度目の「実例が壊れていた」事故。`ORDER BY シーズン DESC` と書いていたので
    /// AI が忠実に真似し、Sizzle 2026 → Sizzle 2025 → Fresh 2026 の順に並んだ。
    /// シーズン名は辞書順（Chill < Drizzle < Fresh < Sizzle）で時系列にならない。
    ///
    /// 実行できることを見るテストでは通ってしまう（**並び順は意味の問題**）ので別に見る。
    #[test]
    fn 実例はシーズン名で並べ替えない() {
        for (q, sql) in SQL_EXAMPLES {
            for bad in ["ORDER BY シーズン ", "ORDER BY シーズン,", "ORDER BY season"] {
                assert!(
                    !sql.contains(bad),
                    "実例「{q}」がシーズン名で並べ替えている（辞書順になる）: {sql}"
                );
            }
        }
        let p = analysis_prompt(None);
        assert!(p.contains("時系列順に並ばない"), "並び順の注意がプロンプトに無い");
    }

    /// 環境データを使う実例が、**必ず期間で絞っている**か。
    ///
    /// 🔴 実データで計測した結果、全期間の集計は **77 秒**（10 秒で中断される）、
    /// 直近 30 日なら 0.7 秒。実例に絞り込みが無いと AI はそれを真似して必ず失敗する。
    /// 「実行できる」だけのテストでは、テスト DB が小さいので通ってしまい気付けない。
    #[test]
    fn 環境データの実例は期間で絞っている() {
        for (q, sql) in SQL_EXAMPLES {
            if sql.contains("ai_env_slots") {
                assert!(sql.contains("source_date"), "実例「{q}」が期間を絞っていない: {sql}");
            }
        }
        // 注意書きの側にも残っているか（実例だけ直して注意が消える事故を防ぐ）。
        let p = analysis_prompt(None);
        assert!(p.contains("source_date"), "期間を絞る注意がプロンプトに無い");
    }

    /// データの規模が、AI が期間を書けるだけの情報になっているか。
    #[test]
    fn データの規模に件数と期間が出る() {
        let scale = DataScale {
            env_battles: 5_541_963,
            env_min_date: Some("2022-09-26".into()),
            env_max_date: Some("2026-07-29".into()),
            my_battles: 1_382,
            lobbies: vec!["xmatch".into(), "bankara_open".into()],
            rules: vec!["area".into(), "hoko".into()],
        };
        let p = analysis_prompt(Some(&scale));
        assert!(p.contains("5541963"), "環境データの件数が無い");
        assert!(p.contains("2026-07-29"), "最新日が無い（date('now') で 0 件になる恐れ）");
        assert!(p.contains("1382"), "自分のバトル数が無い");
        // 1 バトル 7 行という増え方まで伝える。
        assert!(p.contains("38793741"), "行数が示されていない");
    }

    /// ロビーとルールの**実際の値**が載るか。
    ///
    /// 実機で AI が `lobby = 'xmatch'` を推測で当てた。外れれば 0 件になるので、
    /// 推測させずに一覧を渡す。
    #[test]
    fn ロビーとルールの値が載る() {
        let scale = DataScale {
            env_battles: 100,
            env_min_date: Some("2026-06-01".into()),
            env_max_date: Some("2026-07-29".into()),
            my_battles: 10,
            lobbies: vec!["xmatch".into(), "bankara_open".into()],
            rules: vec!["area".into(), "hoko".into()],
        };
        let p = analysis_prompt(Some(&scale));
        assert!(p.contains("`xmatch`"), "lobby の値が無い");
        assert!(p.contains("`area`"), "rule の値が無い");
    }

    /// シーズンが**日付範囲つき**で載るか。
    ///
    /// 実機で AI が `date('now', 'start of season')`（存在しない修飾子）を書いて
    /// タイムアウトした。「今シーズン」を日付で表現できる材料を渡す。
    #[test]
    fn シーズンが日付範囲つきで載る() {
        let scale = DataScale {
            env_battles: 5_541_963,
            env_min_date: Some("2022-09-26".into()),
            env_max_date: Some("2026-07-29".into()),
            my_battles: 1_382,
            lobbies: vec![],
            rules: vec![],
        };
        let p = analysis_prompt(Some(&scale));

        assert!(p.contains("Sizzle Season 2026"), "今シーズンの名前が無い");
        assert!(p.contains("今シーズン"), "どれが今シーズンか分からない");
        assert!(p.contains("source_date >= '2026-06-01'"), "日付での絞り方が示されていない");
        assert!(p.contains("Fresh Season 2026"), "過去のシーズンが無い");
        // 最新シーズンの終端は未来なので、データの最終日で止める。
        assert!(p.contains("2026-07-29（データの最終日）"), "終端が未来のままになっている");
        // 絞り込みには season 列を使わせない（インデックスが無く 15 倍遅い）。
        assert!(p.contains("`season` 列を使わないでください"), "season 列の注意が無い");
        // 🔴 一方で**集計の軸としては使わせる**。実機で「絞るな」だけ読んで月に丸められ、
        // シーズンごとのはずの表が 2026-03 のような月別になった。
        assert!(p.contains("GROUP BY"), "集計軸として使ってよいことが書かれていない");
        assert!(p.contains("月に丸める"), "月に丸めるなという注意が無い");
    }

    /// 環境データが無いときに、環境の質問へ空振りの SQL を書かせないか。
    #[test]
    fn 環境データが無いときはそう書く() {
        let scale = DataScale {
            env_battles: 0,
            env_min_date: None,
            env_max_date: None,
            my_battles: 10,
            lobbies: vec![],
            rules: vec![],
        };
        let p = analysis_prompt(Some(&scale));
        assert!(p.contains("まだ取り込まれていません"), "未取り込みが伝わらない");
    }

    /// 実例が**プロンプトの末尾**にあるか。
    ///
    /// 実例とほぼ同じ質問で別のビューを選ばれた。長いドメイン知識を後ろに積むと
    /// 実例が埋もれるので末尾へ移した。並び替えで元に戻らないよう固定する。
    #[test]
    fn 実例はドメイン知識より後ろにある() {
        let p = analysis_prompt(None);
        let domain = p.find("9 時境界").expect("ドメイン知識が無い");
        let examples = p.find("## 書き方の例").expect("実例の節が無い");
        assert!(examples > domain, "実例がドメイン知識より前にあり埋もれる");
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
        let p = analysis_prompt(None);
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
