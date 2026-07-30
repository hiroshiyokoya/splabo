//! AI が決めた「見せ方」を適用して表の形を作る（#566 第 1 段 B）。
//!
//! # なぜアプリ側でやるか
//!
//! 第 1 段 A では「行はパワー帯、列は順位 1〜5」のような**形の指定を SQL に書かせた**が、
//! 実機で守られなかった。SQL は通るのに縦長の一覧が返る。プロンプトに実例と注意を
//! 足しても安定しない。
//!
//! そこで役割を分けた。
//!
//! | 担当 | 決めること | 保証のしかた |
//! |---|---|---|
//! | AI①（SQL） | 何を集計するか | SQLite が計算する |
//! | AI②（本モジュールの `PresentationSpec`） | 行・列・セルの中身 | **形はこのコードが作る** |
//!
//! AI② は**どの列を行に置くか**を指定するだけで、**数値には触れない**。ピボットとセルの
//! 組み立てはここで行うので、「セルに勝率を入れ忘れる」「順位が列にならない」といった
//! 崩れ方が原理的に起きない。
//!
//! # 検証は先に行う
//!
//! 指定された列が結果に無ければ**適用せずにエラーを返す**。エラー文には実際の列名を
//! 添える（AI が読んで直せる形にする。`ai_sql::classify_error` と同じ考え方）。

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 列見出しにできる値の上限。
///
/// AI が `column_key` に `battle_id` のような一意の列を指定すると数千列になる。
/// ブラウザを固まらせるより、はっきり断って書き直させる。
const MAX_PIVOT_COLUMNS: usize = 40;

/// 表の形。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Shape {
    /// SQL の結果をそのまま出す（列の選択と表示名の付け替えだけ）。
    Table,
    /// 1 列を行見出し、1 列を列見出しにして組み替える。
    Pivot,
}

/// 出す列と、その見出し。
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ColumnSpec {
    /// 結果の列名。
    pub field: String,
    /// 表の見出し。省略すると `field` をそのまま使う。
    #[serde(default)]
    pub label: Option<String>,
}

/// AI② が返す「見せ方」の指定。**数値は含まない。**
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PresentationSpec {
    pub shape: Shape,

    /// 表の見出し（省略可）。
    #[serde(default)]
    pub title: Option<String>,

    // --- shape = table ---
    /// 出す列。省略すると全列をそのまま出す。
    #[serde(default)]
    pub columns: Option<Vec<ColumnSpec>>,

    // --- shape = pivot ---
    /// 行見出しにする列。
    #[serde(default)]
    pub row_key: Option<String>,
    /// 行見出しの列名（表の左上に出る）。省略すると `row_key` をそのまま使う。
    #[serde(default)]
    pub row_label: Option<String>,
    /// 列見出しにする列。
    #[serde(default)]
    pub column_key: Option<String>,
    /// 列の並び。省略すると値で並べる（全部数値なら数値順、そうでなければ文字列順）。
    #[serde(default)]
    pub column_order: Option<Vec<String>>,
    /// 列見出しに付ける接尾辞（`順位` に対する `位` など）。
    #[serde(default)]
    pub column_suffix: Option<String>,
    /// セルの中身。`{列名}` が値に置き換わる。例: `{ブキ} {勝率}%`
    #[serde(default)]
    pub cell_template: Option<String>,
}

/// 適用した結果。フロントはこれをそのまま描く。
#[derive(Debug, Clone, Serialize)]
pub struct ShapedTable {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
    /// 出せなかったもの・切ったものの説明。**黙って捨てない**ための欄。
    pub warnings: Vec<String>,
}

/// `PresentationSpec` を結果に適用する。
///
/// 指定が結果と合っていなければ `Err`。エラー文には実際の列名を添える。
pub fn apply(
    columns: &[String],
    rows: &[Vec<Value>],
    spec: &PresentationSpec,
) -> Result<ShapedTable, String> {
    match spec.shape {
        Shape::Table => apply_table(columns, rows, spec),
        Shape::Pivot => apply_pivot(columns, rows, spec),
    }
}

fn apply_table(
    columns: &[String],
    rows: &[Vec<Value>],
    spec: &PresentationSpec,
) -> Result<ShapedTable, String> {
    let Some(wanted) = &spec.columns else {
        // 指定が無ければそのまま。
        return Ok(ShapedTable {
            title: spec.title.clone(),
            columns: columns.to_vec(),
            rows: rows.to_vec(),
            warnings: Vec::new(),
        });
    };
    if wanted.is_empty() {
        return Err(missing("columns が空です", columns));
    }

    let idx: Vec<usize> = wanted
        .iter()
        .map(|c| index_of(columns, &c.field))
        .collect::<Result<_, _>>()?;

    let out_rows = rows
        .iter()
        .map(|r| idx.iter().map(|&i| r.get(i).cloned().unwrap_or(Value::Null)).collect())
        .collect();

    Ok(ShapedTable {
        title: spec.title.clone(),
        columns: wanted
            .iter()
            .map(|c| c.label.clone().unwrap_or_else(|| c.field.clone()))
            .collect(),
        rows: out_rows,
        warnings: Vec::new(),
    })
}

fn apply_pivot(
    columns: &[String],
    rows: &[Vec<Value>],
    spec: &PresentationSpec,
) -> Result<ShapedTable, String> {
    let row_key = spec
        .row_key
        .as_deref()
        .ok_or_else(|| missing("shape が pivot のときは row_key が必要です", columns))?;
    let column_key = spec
        .column_key
        .as_deref()
        .ok_or_else(|| missing("shape が pivot のときは column_key が必要です", columns))?;
    let template = spec
        .cell_template
        .as_deref()
        .ok_or_else(|| missing("shape が pivot のときは cell_template が必要です", columns))?;

    let row_i = index_of(columns, row_key)?;
    let col_i = index_of(columns, column_key)?;
    // テンプレートが参照する列も先に確かめる。1 セルでも崩れると表全体が読めなくなる。
    for field in template_fields(template) {
        index_of(columns, &field)?;
    }

    let mut warnings = Vec::new();

    // 行・列の見出しは**出てきた順**を基本にする。AI① の ORDER BY を尊重するため。
    let mut row_labels: Vec<String> = Vec::new();
    let mut col_labels: Vec<String> = Vec::new();
    // (行, 列) → セル。
    let mut cells: std::collections::HashMap<(String, String), String> =
        std::collections::HashMap::new();

    for r in rows {
        let rk = to_label(r.get(row_i).unwrap_or(&Value::Null));
        let ck = to_label(r.get(col_i).unwrap_or(&Value::Null));
        if !row_labels.contains(&rk) {
            row_labels.push(rk.clone());
        }
        if !col_labels.contains(&ck) {
            col_labels.push(ck.clone());
        }
        let cell = render_template(template, columns, r);
        // 同じマスに 2 つ来るのは、行と列の選び方では 1 行に定まっていないということ。
        // 黙って上書きすると「なぜか 1 件だけ表示される」表になるので必ず知らせる。
        if cells.insert((rk.clone(), ck.clone()), cell).is_some() {
            let w = format!(
                "{row_key} = {rk} / {column_key} = {ck} に複数の行があります。\
                 最後の 1 件だけを表示しています"
            );
            if !warnings.contains(&w) {
                warnings.push(w);
            }
        }
    }

    order_columns(&mut col_labels, spec.column_order.as_deref());

    if col_labels.len() > MAX_PIVOT_COLUMNS {
        return Err(format!(
            "列見出しが {} 種類になります（上限 {MAX_PIVOT_COLUMNS}）。\
             column_key に指定した `{column_key}` は種類が多すぎます。\
             値の種類が少ない列を選ぶか、shape を table にしてください",
            col_labels.len()
        ));
    }

    let suffix = spec.column_suffix.as_deref().unwrap_or("");
    let mut out_columns = vec![spec
        .row_label
        .clone()
        .unwrap_or_else(|| row_key.to_string())];
    out_columns.extend(col_labels.iter().map(|c| format!("{c}{suffix}")));

    let out_rows = row_labels
        .iter()
        .map(|rk| {
            let mut row = vec![Value::String(rk.clone())];
            for ck in &col_labels {
                row.push(match cells.get(&(rk.clone(), ck.clone())) {
                    Some(s) => Value::String(s.clone()),
                    None => Value::Null,
                });
            }
            row
        })
        .collect();

    Ok(ShapedTable {
        title: spec.title.clone(),
        columns: out_columns,
        rows: out_rows,
        warnings,
    })
}

/// 列の並びを決める。
///
/// 明示された順があればそれに従い、無ければ**数値として読めるなら数値順**にする。
/// 順位や帯の下限のような数値の列見出しが `1, 10, 2` の順に並ぶのを防ぐ。
fn order_columns(labels: &mut Vec<String>, explicit: Option<&[String]>) {
    if let Some(order) = explicit {
        // 指定された順を先に、指定漏れは後ろへ（黙って落とさない）。
        let mut sorted: Vec<String> = order
            .iter()
            .filter(|o| labels.contains(o))
            .cloned()
            .collect();
        for l in labels.iter() {
            if !sorted.contains(l) {
                sorted.push(l.clone());
            }
        }
        *labels = sorted;
        return;
    }
    if labels.iter().all(|l| l.parse::<f64>().is_ok()) {
        labels.sort_by(|a, b| {
            a.parse::<f64>()
                .unwrap()
                .partial_cmp(&b.parse::<f64>().unwrap())
                .unwrap_or(std::cmp::Ordering::Equal)
        });
    }
}

/// `{列名}` を値に置き換える。
fn render_template(template: &str, columns: &[String], row: &[Value]) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find('{') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('}') {
            Some(end) => {
                let name = &after[..end];
                match columns.iter().position(|c| c == name) {
                    Some(i) => out.push_str(&format_value(row.get(i).unwrap_or(&Value::Null))),
                    // 検証を通っているので基本ここには来ない。来ても表記を壊さない。
                    None => {
                        out.push('{');
                        out.push_str(name);
                        out.push('}');
                    }
                }
                rest = &after[end + 1..];
            }
            None => {
                out.push('{');
                rest = after;
                break;
            }
        }
    }
    out.push_str(rest);
    out
}

/// テンプレートが参照している列名。
fn template_fields(template: &str) -> Vec<String> {
    let mut fields = Vec::new();
    let mut rest = template;
    while let Some(start) = rest.find('{') {
        let after = &rest[start + 1..];
        match after.find('}') {
            Some(end) => {
                let name = after[..end].to_string();
                if !name.is_empty() && !fields.contains(&name) {
                    fields.push(name);
                }
                rest = &after[end + 1..];
            }
            None => break,
        }
    }
    fields
}

/// 表示用の文字列にする。整数はそのまま、小数は 3 桁まで（フロントの表示と揃える）。
fn format_value(v: &Value) -> String {
    match v {
        Value::Null => "-".to_string(),
        Value::String(s) => s.clone(),
        Value::Number(n) => match n.as_f64() {
            Some(f) if f.fract() == 0.0 => format!("{}", f as i64),
            Some(f) => {
                let s = format!("{f:.3}");
                // 末尾の 0 は落とす（0.500 → 0.5）。
                s.trim_end_matches('0').trim_end_matches('.').to_string()
            }
            None => n.to_string(),
        },
        other => other.to_string(),
    }
}

/// 行・列の見出しに使う文字列。
fn to_label(v: &Value) -> String {
    match v {
        Value::Null => "(なし)".to_string(),
        other => format_value(other),
    }
}

fn index_of(columns: &[String], field: &str) -> Result<usize, String> {
    columns
        .iter()
        .position(|c| c == field)
        .ok_or_else(|| missing(&format!("結果に `{field}` という列がありません"), columns))
}

/// AI が読んで直せるエラー文にする。**実際の列名を必ず添える。**
fn missing(msg: &str, columns: &[String]) -> String {
    format!(
        "{msg}\n\n結果にある列は次のとおりです: {}",
        columns
            .iter()
            .map(|c| format!("`{c}`"))
            .collect::<Vec<_>>()
            .join(", ")
    )
}

/// AI② に渡す指示。**ビュー定義もドメイン知識も要らない**（形しか決めないので）。
///
/// フロントに置かず Rust から出すのは、`PresentationSpec` の定義と説明を
/// 1 つの出力元に保つため。欄を増やしたら説明も一緒に動く。
pub fn presentation_prompt() -> String {
    format!(
        "あなたは分析結果の**見せ方**だけを決めます。集計はすでに終わっています。\n\
         \n\
         **数値を書き直してはいけません。** どの列を行に置き、どの列を列に置き、\n\
         セルに何を並べるかを指定するだけです。表はアプリが組み立てます。\n\
         \n\
         ## 返す JSON\n\
         \n\
         ```json\n\
         {{\n\
         \x20 \"shape\": \"table\" | \"pivot\",\n\
         \x20 \"title\": \"表の見出し（省略可）\",\n\
         \n\
         \x20 // shape = \"table\" のとき（結果をそのまま縦に出す）\n\
         \x20 \"columns\": [{{ \"field\": \"結果の列名\", \"label\": \"見出し（省略可）\" }}],\n\
         \n\
         \x20 // shape = \"pivot\" のとき（行と列に組み替える）\n\
         \x20 \"row_key\": \"行見出しにする列名\",\n\
         \x20 \"row_label\": \"行見出しの名前（省略可）\",\n\
         \x20 \"column_key\": \"列見出しにする列名\",\n\
         \x20 \"column_suffix\": \"列見出しに付ける接尾辞（省略可。順位なら \\\"位\\\"）\",\n\
         \x20 \"column_order\": [\"列の並び（省略可。省略時は数値順・文字列順）\"],\n\
         \x20 \"cell_template\": \"{{列名}} を値に置き換える文字列。例: {{ブキ}} {{勝率}}%\"\n\
         }}\n\
         ```\n\
         \n\
         ## 決め方\n\
         \n\
         - 質問が「行は〇〇、列は〇〇」と**形を指定していたらそれに従う**（`shape` は `pivot`）\n\
         - 「〇〇ごとの上位 N を表で」のように**同じ群の中で順位が付いている**なら `pivot` にし、\n\
         \x20 `column_key` に順位の列、`cell_template` に**中身と数値の両方**を入れる\n\
         \x20 （`{{ブキ}}` だけにすると勝率が消えて比較できない）\n\
         - それ以外は `table`。列が多すぎるときだけ `columns` で絞る\n\
         - `column_key` には**値の種類が少ない列**を選ぶ（{MAX_PIVOT_COLUMNS} 種類まで）。\n\
         \x20 `battle_id` のような一意の列は選べません\n\
         - **列名は結果にあるものだけ**を使う。無い列を書くとエラーになります\n\
         \n\
         JSON だけを返してください。前後に説明を付けないでください。"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// AI② の指示に、`PresentationSpec` の欄が全部出ているか。
    ///
    /// 欄を増やしたのに説明を書き忘れると、AI はその欄を永久に使わない。
    #[test]
    fn 指示に全部の欄が出ている() {
        let p = presentation_prompt();
        for field in [
            "shape", "title", "columns", "field", "label", "row_key", "row_label",
            "column_key", "column_suffix", "column_order", "cell_template",
        ] {
            assert!(p.contains(field), "`{field}` が AI② の指示に無い");
        }
        // 上限は定数から出す（数字を二重に書かない）。
        assert!(p.contains(&MAX_PIVOT_COLUMNS.to_string()), "列数の上限が書かれていない");
        // 数値を触らせないことは最重要。
        assert!(p.contains("数値を書き直してはいけません"), "数値の禁止が抜けている");
    }

    /// 指示の JSON 例が、実際に `PresentationSpec` として読めるか。
    ///
    /// 🔴 AI は例を忠実に真似する。**壊れた例を渡すと壊れた JSON が返る**
    /// （AI① の実例で実際に踏んだ）。例だけは形を検証しておく。
    #[test]
    fn 指示の例が実際に読める() {
        let pivot = r#"{"shape":"pivot","title":"t","row_key":"帯","row_label":"Xパワー帯",
                        "column_key":"順位","column_suffix":"位","column_order":["1","2"],
                        "cell_template":"{ブキ} {勝率}%"}"#;
        let spec: PresentationSpec = serde_json::from_str(pivot).expect("pivot の例が読めない");
        assert_eq!(spec.shape, Shape::Pivot);

        let table = r#"{"shape":"table","columns":[{"field":"stage","label":"ステージ"}]}"#;
        let spec: PresentationSpec = serde_json::from_str(table).expect("table の例が読めない");
        assert_eq!(spec.shape, Shape::Table);
    }

    fn cols(names: &[&str]) -> Vec<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    /// 実機で守られなかった指定「行はパワー帯、列は順位 1〜5、セルはブキと勝率」。
    ///
    /// AI① には縦長で出させ、**形はここで作る**。これが第 1 段 B の要。
    #[test]
    fn 縦長の結果を行と列に組み替える() {
        let columns = cols(&["帯", "順位", "ブキ", "勝率"]);
        let rows = vec![
            vec![json!(2000), json!(1), json!("シャープマーカー"), json!(56.3)],
            vec![json!(2000), json!(2), json!("わかばシューター"), json!(55.1)],
            vec![json!(2500), json!(1), json!("スプラローラー"), json!(54.8)],
            vec![json!(2500), json!(2), json!("ボトルガイザー"), json!(53.2)],
        ];
        let spec = PresentationSpec {
            shape: Shape::Pivot,
            title: Some("パワー帯ごとの勝率上位ブキ".into()),
            columns: None,
            row_key: Some("帯".into()),
            row_label: Some("Xパワー帯".into()),
            column_key: Some("順位".into()),
            column_order: None,
            column_suffix: Some("位".into()),
            cell_template: Some("{ブキ} {勝率}%".into()),
        };

        let t = apply(&columns, &rows, &spec).unwrap();

        assert_eq!(t.columns, cols(&["Xパワー帯", "1位", "2位"]));
        assert_eq!(t.rows.len(), 2);
        assert_eq!(t.rows[0][0], json!("2000"));
        assert_eq!(t.rows[0][1], json!("シャープマーカー 56.3%"));
        assert_eq!(t.rows[1][2], json!("ボトルガイザー 53.2%"));
        assert!(t.warnings.is_empty());
        assert_eq!(t.title.as_deref(), Some("パワー帯ごとの勝率上位ブキ"));
    }

    /// 埋まらないマスは空にする。**別のマスの値をずらして詰めない。**
    #[test]
    fn 足りないマスは空になる() {
        let columns = cols(&["帯", "順位", "ブキ"]);
        let rows = vec![
            vec![json!(2000), json!(1), json!("A")],
            vec![json!(2000), json!(2), json!("B")],
            // 2500 は 1 位しかない
            vec![json!(2500), json!(1), json!("C")],
        ];
        let spec = pivot("帯", "順位", "{ブキ}");
        let t = apply(&columns, &rows, &spec).unwrap();

        assert_eq!(t.rows[1][1], json!("C"));
        assert_eq!(t.rows[1][2], Value::Null, "2 位が空になっていない");
    }

    /// 列見出しが数値なら数値順。`1, 10, 2` の順に並ばせない。
    #[test]
    fn 数値の列見出しは数値順に並ぶ() {
        let columns = cols(&["群", "順位", "値"]);
        let rows = (1..=10)
            .map(|i| vec![json!("A"), json!(i), json!(format!("v{i}"))])
            .collect::<Vec<_>>();
        let t = apply(&columns, &rows, &pivot("群", "順位", "{値}")).unwrap();

        assert_eq!(t.columns[1], "1");
        assert_eq!(t.columns[2], "2");
        assert_eq!(t.columns[10], "10", "辞書順で並んでいる: {:?}", t.columns);
    }

    /// 行の順は SQL の ORDER BY を尊重する（勝手に並べ替えない）。
    #[test]
    fn 行の順は結果の出現順を保つ() {
        let columns = cols(&["帯", "順位", "値"]);
        let rows = vec![
            vec![json!(3000), json!(1), json!("x")],
            vec![json!(1000), json!(1), json!("y")],
            vec![json!(2000), json!(1), json!("z")],
        ];
        let t = apply(&columns, &rows, &pivot("帯", "順位", "{値}")).unwrap();
        assert_eq!(
            t.rows.iter().map(|r| r[0].clone()).collect::<Vec<_>>(),
            vec![json!("3000"), json!("1000"), json!("2000")]
        );
    }

    /// 同じマスに 2 件来たら**黙って捨てない**。
    #[test]
    fn 同じマスが重なったら警告する() {
        let columns = cols(&["帯", "順位", "値"]);
        let rows = vec![
            vec![json!(2000), json!(1), json!("先")],
            vec![json!(2000), json!(1), json!("後")],
        ];
        let t = apply(&columns, &rows, &pivot("帯", "順位", "{値}")).unwrap();

        assert_eq!(t.rows[0][1], json!("後"));
        assert_eq!(t.warnings.len(), 1, "警告が出ていない");
        assert!(t.warnings[0].contains("複数の行があります"), "{:?}", t.warnings);
    }

    /// 無い列を指定されたら**適用せずに**エラー。エラー文に実際の列名を添える。
    #[test]
    fn 無い列を指定されたら列名を添えて断る() {
        let columns = cols(&["帯", "順位", "ブキ"]);
        let rows = vec![vec![json!(2000), json!(1), json!("A")]];

        let e = apply(&columns, &rows, &pivot("ウデマエ", "順位", "{ブキ}")).unwrap_err();
        assert!(e.contains("ウデマエ"), "{e}");
        assert!(e.contains("`帯`"), "実際の列名が無い: {e}");

        // セルのテンプレートが参照する列も検証する。
        let e = apply(&columns, &rows, &pivot("帯", "順位", "{勝率}")).unwrap_err();
        assert!(e.contains("勝率"), "{e}");
        assert!(e.contains("`ブキ`"), "実際の列名が無い: {e}");
    }

    /// `column_key` に一意の列を指定されたら断る（数千列でフロントを固めない）。
    #[test]
    fn 列が多すぎるときは断る() {
        let columns = cols(&["群", "battle_id", "値"]);
        let rows = (0..MAX_PIVOT_COLUMNS + 1)
            .map(|i| vec![json!("A"), json!(format!("b{i}")), json!(i)])
            .collect::<Vec<_>>();

        let e = apply(&columns, &rows, &pivot("群", "battle_id", "{値}")).unwrap_err();
        assert!(e.contains("上限"), "{e}");
        assert!(e.contains("battle_id"), "どの列が悪いか分からない: {e}");
    }

    /// pivot に必要な指定が欠けていたら、何が足りないかを言う。
    #[test]
    fn 指定が欠けていたら何が足りないか言う() {
        let columns = cols(&["a", "b"]);
        let rows = vec![vec![json!(1), json!(2)]];
        let mut spec = pivot("a", "b", "{a}");

        spec.row_key = None;
        assert!(apply(&columns, &rows, &spec).unwrap_err().contains("row_key"));

        spec = pivot("a", "b", "{a}");
        spec.cell_template = None;
        assert!(apply(&columns, &rows, &spec)
            .unwrap_err()
            .contains("cell_template"));
    }

    #[test]
    fn table_は列の選択と名前の付け替えだけ() {
        let columns = cols(&["stage", "勝率", "件数"]);
        let rows = vec![vec![json!("ユノハナ"), json!(55.5), json!(120)]];
        let spec = PresentationSpec {
            shape: Shape::Table,
            title: None,
            columns: Some(vec![
                ColumnSpec { field: "stage".into(), label: Some("ステージ".into()) },
                ColumnSpec { field: "勝率".into(), label: None },
            ]),
            row_key: None,
            row_label: None,
            column_key: None,
            column_order: None,
            column_suffix: None,
            cell_template: None,
        };

        let t = apply(&columns, &rows, &spec).unwrap();
        assert_eq!(t.columns, cols(&["ステージ", "勝率"]));
        assert_eq!(t.rows[0], vec![json!("ユノハナ"), json!(55.5)]);
    }

    /// 列指定が無い table は素通し。AI② が形を決めきれなかったときの安全側。
    #[test]
    fn 列指定の無い_table_は素通し() {
        let columns = cols(&["a", "b"]);
        let rows = vec![vec![json!(1), json!(2)]];
        let spec = PresentationSpec {
            shape: Shape::Table,
            title: None,
            columns: None,
            row_key: None,
            row_label: None,
            column_key: None,
            column_order: None,
            column_suffix: None,
            cell_template: None,
        };
        let t = apply(&columns, &rows, &spec).unwrap();
        assert_eq!(t.columns, columns);
        assert_eq!(t.rows, rows);
    }

    /// 明示された列の並びに従う。指定漏れは落とさず後ろに付ける。
    #[test]
    fn 明示された列の並びに従う() {
        let columns = cols(&["群", "区分", "値"]);
        let rows = vec![
            vec![json!("A"), json!("下位"), json!(1)],
            vec![json!("A"), json!("上位"), json!(2)],
            vec![json!("A"), json!("中位"), json!(3)],
        ];
        let mut spec = pivot("群", "区分", "{値}");
        spec.column_order = Some(vec!["上位".into(), "中位".into()]);

        let t = apply(&columns, &rows, &spec).unwrap();
        assert_eq!(t.columns, cols(&["群", "上位", "中位", "下位"]));
    }

    /// 数値の表示はフロントと揃える（整数はそのまま、小数は 3 桁まで、末尾 0 は落とす）。
    #[test]
    fn 数値の表示を整える() {
        assert_eq!(format_value(&json!(120)), "120");
        assert_eq!(format_value(&json!(55.5)), "55.5");
        assert_eq!(format_value(&json!(0.123456)), "0.123");
        assert_eq!(format_value(&json!(-0.5)), "-0.5");
        assert_eq!(format_value(&Value::Null), "-");
        assert_eq!(format_value(&json!("わかば")), "わかば");
    }

    /// テンプレートの壊れた書き方でパニックしない。
    #[test]
    fn 壊れたテンプレートでも落ちない() {
        let columns = cols(&["a"]);
        let row = vec![json!(1)];
        assert_eq!(render_template("{a", &columns, &row), "{a");
        assert_eq!(render_template("{}", &columns, &row), "{}");
        assert_eq!(render_template("値なし", &columns, &row), "値なし");
        assert_eq!(render_template("{a}{a}", &columns, &row), "11");
    }

    /// AI② の返答は JSON なので、素直な形が読めることを確かめる。
    #[test]
    fn 返答_json_を読める() {
        let spec: PresentationSpec = serde_json::from_str(
            r#"{"shape":"pivot","row_key":"帯","column_key":"順位",
                "column_suffix":"位","cell_template":"{ブキ} {勝率}%"}"#,
        )
        .unwrap();
        assert_eq!(spec.shape, Shape::Pivot);
        assert_eq!(spec.row_key.as_deref(), Some("帯"));
        // 省略された欄は None で受かる（AI が全部埋めてこない前提）。
        assert!(spec.columns.is_none());
    }

    fn pivot(row: &str, col: &str, template: &str) -> PresentationSpec {
        PresentationSpec {
            shape: Shape::Pivot,
            title: None,
            columns: None,
            row_key: Some(row.into()),
            row_label: None,
            column_key: Some(col.into()),
            column_order: None,
            column_suffix: None,
            cell_template: Some(template.into()),
        }
    }
}
