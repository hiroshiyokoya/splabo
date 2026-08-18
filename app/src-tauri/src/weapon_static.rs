//! Splatoon 3 ブキ属性の静的マスター。
//!
//! stat.ink /api/v3/weapon のレスポンス（2026-07 時点）から生成。
//! Splatoon 3 のブキ追加は終了しているため、このデータが陳腐化することはない。
//! 形式: (statink slug, カテゴリ, サブ, スペシャル) いずれも日本語名。
//!
//! カテゴリは **SplatNet / ゲーム内のブキ種別** に揃える（#523）。
//! stat.ink は L3/H3 を `リールガン` と分けるが、公式はシューター扱いのため統合する。

pub const WEAPON_STATIC_ATTRS: &[(&str, &str, &str, &str)] = &[
    ("52gal", "シューター", "スプラッシュシールド", "メガホンレーザー5.1ch"),
    ("52gal_deco", "シューター", "カーリングボム", "スミナガシート"),
    ("96gal", "シューター", "スプリンクラー", "キューインキ"),
    ("96gal_deco", "シューター", "スプラッシュシールド", "テイオウイカ"),
    ("96gal_sou", "シューター", "ラインマーカー", "エナジースタンド"),
    ("bamboo14mk1", "チャージャー", "ロボットボム", "メガホンレーザー5.1ch"),
    ("bamboo14mk2", "チャージャー", "タンサンボム", "デコイチラシ"),
    ("barrelspinner", "スピナー", "スプリンクラー", "ホップソナー"),
    ("barrelspinner_deco", "スピナー", "ポイントセンサー", "テイオウイカ"),
    ("bold", "シューター", "カーリングボム", "ウルトラハンコ"),
    ("bold_neo", "シューター", "ジャンプビーコン", "メガホンレーザー5.1ch"),
    ("bottlegeyser", "シューター", "スプラッシュシールド", "ウルトラショット"),
    ("bottlegeyser_foil", "シューター", "ロボットボム", "スミナガシート"),
    ("brella24mk1", "シェルター", "ラインマーカー", "グレートバリア"),
    ("brella24mk2", "シェルター", "ポイズンミスト", "ウルトラチャクチ"),
    ("bucketslosher", "スロッシャー", "スプラッシュボム", "トリプルトルネード"),
    ("bucketslosher_deco", "スロッシャー", "ラインマーカー", "ショクワンダー"),
    ("campingshelter", "シェルター", "ジャンプビーコン", "キューインキ"),
    ("campingshelter_crem", "シェルター", "ポイズンミスト", "デコイチラシ"),
    ("campingshelter_sorella", "シェルター", "トラップ", "ウルトラショット"),
    ("carbon", "ローラー", "ロボットボム", "ショクワンダー"),
    ("carbon_angl", "ローラー", "タンサンボム", "デコイチラシ"),
    ("carbon_deco", "ローラー", "クイックボム", "ウルトラショット"),
    ("clashblaster", "ブラスター", "スプラッシュボム", "ウルトラショット"),
    ("clashblaster_neo", "ブラスター", "カーリングボム", "デコイチラシ"),
    ("dentalwiper_mint", "ワイパー", "キューバンボム", "グレートバリア"),
    ("dentalwiper_sumi", "ワイパー", "スプラッシュシールド", "ジェットパック"),
    ("drivewiper", "ワイパー", "トーピード", "ウルトラハンコ"),
    ("drivewiper_deco", "ワイパー", "ジャンプビーコン", "マルチミサイル"),
    ("drivewiper_rust", "ワイパー", "カーリングボム", "ウルトラショット"),
    ("dualsweeper", "マニューバー", "スプラッシュボム", "ホップソナー"),
    ("dualsweeper_custom", "マニューバー", "ジャンプビーコン", "デコイチラシ"),
    ("dualsweeper_tei", "マニューバー", "ポイントセンサー", "スミナガシート"),
    ("dynamo", "ローラー", "スプリンクラー", "エナジースタンド"),
    ("dynamo_mei", "ローラー", "ポイントセンサー", "メガホンレーザー5.1ch"),
    ("dynamo_tesla", "ローラー", "スプラッシュボム", "デコイチラシ"),
    ("examiner", "スピナー", "カーリングボム", "エナジースタンド"),
    ("examiner_hue", "スピナー", "スプラッシュボム", "カニタンク"),
    ("explosher", "スロッシャー", "ポイントセンサー", "アメフラシ"),
    ("explosher_custom", "スロッシャー", "スプラッシュシールド", "ウルトラチャクチ"),
    ("fincent", "フデ", "カーリングボム", "ホップソナー"),
    ("fincent_brnz", "フデ", "スプラッシュシールド", "ウルトラショット"),
    ("fincent_hue", "フデ", "ポイントセンサー", "マルチミサイル"),
    ("furo", "スロッシャー", "スプリンクラー", "アメフラシ"),
    ("furo_deco", "スロッシャー", "ラインマーカー", "テイオウイカ"),
    ("furuido", "ストリンガー", "ロボットボム", "ウルトラハンコ"),
    ("furuido_custom", "ストリンガー", "ポイントセンサー", "ホップソナー"),
    ("gaen_ff", "マニューバー", "トラップ", "メガホンレーザー5.1ch"),
    ("gaen_ff_custom", "マニューバー", "クイックボム", "トリプルトルネード"),
    ("h3reelgun", "シューター", "ポイントセンサー", "エナジースタンド"),
    ("h3reelgun_d", "シューター", "スプラッシュシールド", "グレートバリア"),
    ("h3reelgun_snak", "シューター", "キューバンボム", "トリプルトルネード"),
    ("heroshooter_replica", "シューター", "キューバンボム", "ウルトラショット"),
    ("hissen", "スロッシャー", "ポイズンミスト", "ジェットパック"),
    ("hissen_ash", "スロッシャー", "スプラッシュボム", "スミナガシート"),
    ("hissen_hue", "スロッシャー", "タンサンボム", "エナジースタンド"),
    ("hokusai", "フデ", "キューバンボム", "ショクワンダー"),
    ("hokusai_hue", "フデ", "ジャンプビーコン", "アメフラシ"),
    ("hokusai_sui", "フデ", "ロボットボム", "テイオウイカ"),
    ("hotblaster", "ブラスター", "ロボットボム", "グレートバリア"),
    ("hotblaster_custom", "ブラスター", "ポイントセンサー", "ウルトラチャクチ"),
    ("hotblaster_en", "ブラスター", "ジャンプビーコン", "カニタンク"),
    ("hydra", "スピナー", "ロボットボム", "ナイスダマ"),
    ("hydra_atsu", "スピナー", "スプリンクラー", "グレートバリア"),
    ("hydra_custom", "スピナー", "トラップ", "スミナガシート"),
    ("jetsweeper", "シューター", "ラインマーカー", "キューインキ"),
    ("jetsweeper_cobr", "シューター", "クイックボム", "ウルトラチャクチ"),
    ("jetsweeper_custom", "シューター", "ポイズンミスト", "アメフラシ"),
    ("jimuwiper", "ワイパー", "クイックボム", "ショクワンダー"),
    ("jimuwiper_fuu", "ワイパー", "ロボットボム", "ナイスダマ"),
    ("jimuwiper_hue", "ワイパー", "ポイズンミスト", "カニタンク"),
    ("kelvin525", "マニューバー", "スプラッシュシールド", "ナイスダマ"),
    ("kelvin525_deco", "マニューバー", "ポイントセンサー", "ウルトラショット"),
    ("kugelschreiber", "スピナー", "タンサンボム", "ジェットパック"),
    ("kugelschreiber_hue", "スピナー", "トラップ", "キューインキ"),
    ("l3reelgun", "シューター", "カーリングボム", "カニタンク"),
    ("l3reelgun_d", "シューター", "クイックボム", "ウルトラハンコ"),
    ("l3reelgun_haku", "シューター", "スプラッシュボム", "ジェットパック"),
    ("lact450", "ストリンガー", "カーリングボム", "マルチミサイル"),
    ("lact450_deco", "ストリンガー", "スプラッシュシールド", "サメライド"),
    ("lact450_milk", "ストリンガー", "トーピード", "ナイスダマ"),
    ("liter4k", "チャージャー", "トラップ", "ホップソナー"),
    ("liter4k_custom", "チャージャー", "ジャンプビーコン", "テイオウイカ"),
    ("liter4k_scope", "チャージャー", "トラップ", "ホップソナー"),
    ("liter4k_scope_custom", "チャージャー", "ジャンプビーコン", "テイオウイカ"),
    ("longblaster", "ブラスター", "キューバンボム", "ホップソナー"),
    ("longblaster_custom", "ブラスター", "スプラッシュボム", "テイオウイカ"),
    ("maneuver", "マニューバー", "キューバンボム", "カニタンク"),
    ("maneuver_collabo", "マニューバー", "カーリングボム", "ウルトラチャクチ"),
    ("maneuver_you", "マニューバー", "タンサンボム", "グレートバリア"),
    ("momiji", "シューター", "トーピード", "ホップソナー"),
    ("moprin", "スロッシャー", "キューバンボム", "サメライド"),
    ("moprin_d", "スロッシャー", "ジャンプビーコン", "ホップソナー"),
    ("moprin_kaku", "スロッシャー", "カーリングボム", "カニタンク"),
    ("nautilus47", "スピナー", "ポイントセンサー", "アメフラシ"),
    ("nautilus79", "スピナー", "キューバンボム", "ウルトラチャクチ"),
    ("nova", "ブラスター", "スプラッシュボム", "ショクワンダー"),
    ("nova_neo", "ブラスター", "タンサンボム", "ウルトラハンコ"),
    ("nzap85", "シューター", "キューバンボム", "エナジースタンド"),
    ("nzap89", "シューター", "ロボットボム", "デコイチラシ"),
    ("octoshooter_replica", "シューター", "スプラッシュボム", "トリプルトルネード"),
    ("order_blaster_replica", "ブラスター", "スプラッシュボム", "ショクワンダー"),
    ("order_brush_replica", "フデ", "キューバンボム", "ショクワンダー"),
    ("order_charger_replica", "チャージャー", "スプラッシュボム", "キューインキ"),
    ("order_maneuver_replica", "マニューバー", "キューバンボム", "カニタンク"),
    ("order_roller_replica", "ローラー", "カーリングボム", "グレートバリア"),
    ("order_shelter_replica", "シェルター", "スプリンクラー", "トリプルトルネード"),
    ("order_shooter_replica", "シューター", "キューバンボム", "ウルトラショット"),
    ("order_slosher_replica", "スロッシャー", "スプラッシュボム", "トリプルトルネード"),
    ("order_spinner_replica", "スピナー", "スプリンクラー", "ホップソナー"),
    ("order_stringer_replica", "ストリンガー", "ポイズンミスト", "メガホンレーザー5.1ch"),
    ("order_wiper_replica", "ワイパー", "クイックボム", "ショクワンダー"),
    ("pablo", "フデ", "スプラッシュボム", "メガホンレーザー5.1ch"),
    ("pablo_hue", "フデ", "トラップ", "ウルトラハンコ"),
    ("parashelter", "シェルター", "スプリンクラー", "トリプルトルネード"),
    ("parashelter_sorella", "シェルター", "ロボットボム", "ジェットパック"),
    ("prime", "シューター", "ラインマーカー", "カニタンク"),
    ("prime_collabo", "シューター", "キューバンボム", "ナイスダマ"),
    ("prime_frzn", "シューター", "スプラッシュボム", "マルチミサイル"),
    ("promodeler_mg", "シューター", "タンサンボム", "サメライド"),
    ("promodeler_rg", "シューター", "スプリンクラー", "ナイスダマ"),
    ("promodeler_sai", "シューター", "クイックボム", "スミナガシート"),
    ("quadhopper_black", "マニューバー", "ロボットボム", "サメライド"),
    ("quadhopper_white", "マニューバー", "スプリンクラー", "ショクワンダー"),
    ("rapid", "ブラスター", "トラップ", "トリプルトルネード"),
    ("rapid_deco", "ブラスター", "トーピード", "ジェットパック"),
    ("rapid_elite", "ブラスター", "ポイズンミスト", "キューインキ"),
    ("rapid_elite_deco", "ブラスター", "ラインマーカー", "メガホンレーザー5.1ch"),
    ("rapid_elite_wntr", "ブラスター", "キューバンボム", "エナジースタンド"),
    ("rpen_5b", "チャージャー", "スプラッシュシールド", "アメフラシ"),
    ("rpen_5h", "チャージャー", "スプリンクラー", "エナジースタンド"),
    ("sblast91", "ブラスター", "クイックボム", "ナイスダマ"),
    ("sblast92", "ブラスター", "スプリンクラー", "サメライド"),
    ("screwslosher", "スロッシャー", "タンサンボム", "ナイスダマ"),
    ("screwslosher_neo", "スロッシャー", "ポイントセンサー", "ウルトラショット"),
    ("sharp", "シューター", "クイックボム", "カニタンク"),
    ("sharp_geck", "シューター", "ポイズンミスト", "アメフラシ"),
    ("sharp_neo", "シューター", "キューバンボム", "トリプルトルネード"),
    ("soytuber", "チャージャー", "トーピード", "マルチミサイル"),
    ("soytuber_custom", "チャージャー", "タンサンボム", "ウルトラハンコ"),
    ("spaceshooter", "シューター", "ポイントセンサー", "メガホンレーザー5.1ch"),
    ("spaceshooter_collabo", "シューター", "トラップ", "ジェットパック"),
    ("splatcharger", "チャージャー", "スプラッシュボム", "キューインキ"),
    ("splatcharger_collabo", "チャージャー", "スプラッシュシールド", "トリプルトルネード"),
    ("splatcharger_frst", "チャージャー", "スプリンクラー", "カニタンク"),
    ("splatroller", "ローラー", "カーリングボム", "グレートバリア"),
    ("splatroller_collabo", "ローラー", "ジャンプビーコン", "テイオウイカ"),
    ("splatscope", "チャージャー", "スプラッシュボム", "キューインキ"),
    ("splatscope_collabo", "チャージャー", "スプラッシュシールド", "トリプルトルネード"),
    ("splatscope_frst", "チャージャー", "スプリンクラー", "カニタンク"),
    ("splatspinner", "スピナー", "クイックボム", "ウルトラハンコ"),
    ("splatspinner_collabo", "スピナー", "ポイズンミスト", "グレートバリア"),
    ("splatspinner_pytn", "スピナー", "ジャンプビーコン", "ウルトラショット"),
    ("sputtery", "マニューバー", "ジャンプビーコン", "エナジースタンド"),
    ("sputtery_hue", "マニューバー", "トーピード", "サメライド"),
    ("sputtery_owl", "マニューバー", "スプラッシュボム", "メガホンレーザー5.1ch"),
    ("spygadget", "シェルター", "トラップ", "サメライド"),
    ("spygadget_ryo", "シェルター", "カーリングボム", "メガホンレーザー5.1ch"),
    ("spygadget_sorella", "シェルター", "トーピード", "スミナガシート"),
    ("squiclean_a", "チャージャー", "ポイントセンサー", "グレートバリア"),
    ("squiclean_b", "チャージャー", "ロボットボム", "ショクワンダー"),
    ("sshooter", "シューター", "キューバンボム", "ウルトラショット"),
    ("sshooter_collabo", "シューター", "スプラッシュボム", "トリプルトルネード"),
    ("sshooter_kou", "シューター", "クイックボム", "テイオウイカ"),
    ("tristringer", "ストリンガー", "ポイズンミスト", "メガホンレーザー5.1ch"),
    ("tristringer_collabo", "ストリンガー", "スプリンクラー", "デコイチラシ"),
    ("tristringer_tou", "ストリンガー", "ラインマーカー", "ジェットパック"),
    ("variableroller", "ローラー", "トラップ", "マルチミサイル"),
    ("variableroller_foil", "ローラー", "キューバンボム", "スミナガシート"),
    ("wakaba", "シューター", "スプラッシュボム", "グレートバリア"),
    ("wideroller", "ローラー", "スプラッシュシールド", "キューインキ"),
    ("wideroller_collabo", "ローラー", "ラインマーカー", "アメフラシ"),
    ("wideroller_waku", "ローラー", "トーピード", "ウルトラチャクチ"),
];

/// slug から (カテゴリ, サブ, スペシャル) を引く。
pub fn lookup(slug: &str) -> Option<(&'static str, &'static str, &'static str)> {
    WEAPON_STATIC_ATTRS
        .iter()
        .find(|(k, _, _, _)| *k == slug)
        .map(|(_, cat, sub, sp)| (*cat, *sub, *sp))
}

/// stat.ink 等のカテゴリ名を公式（SplatNet）準拠に正規化する（#523）。
pub fn normalize_category(cat: &str) -> &str {
    match cat {
        "リールガン" => "シューター",
        other => other,
    }
}

/// ブキの公式英語名（#712）。
///
/// stat.ink /api/v3/weapon（2026-08 時点）の `name.en_US` から生成。
/// WEAPON_STATIC_ATTRS と同じ理由（ブキ追加終了）でこのデータは陳腐化しない。
pub const WEAPON_NAME_EN: &[(&str, &str)] = &[
    ("52gal", ".52 Gal"),
    ("52gal_deco", ".52 Gal Deco"),
    ("96gal", ".96 Gal"),
    ("96gal_deco", ".96 Gal Deco"),
    ("96gal_sou", "Clawz .96 Gal"),
    ("bold", "Sploosh-o-matic"),
    ("bold_neo", "Neo Sploosh-o-matic"),
    ("bottlegeyser", "Squeezer"),
    ("bottlegeyser_foil", "Foil Squeezer"),
    ("heroshooter_replica", "Hero Shot Replica"),
    ("jetsweeper", "Jet Squelcher"),
    ("jetsweeper_cobr", "Jet Squelcher COB-R"),
    ("jetsweeper_custom", "Custom Jet Squelcher"),
    ("momiji", "Custom Splattershot Jr."),
    ("nzap85", "N-ZAP '85"),
    ("nzap89", "N-ZAP '89"),
    ("octoshooter_replica", "Octo Shot Replica"),
    ("order_shooter_replica", "Order Shot Replica"),
    ("prime", "Splattershot Pro"),
    ("prime_collabo", "Forge Splattershot Pro"),
    ("prime_frzn", "Splattershot Pro FRZ-N"),
    ("promodeler_mg", "Aerospray MG"),
    ("promodeler_rg", "Aerospray RG"),
    ("promodeler_sai", "Colorz Aerospray"),
    ("sharp", "Splash-o-matic"),
    ("sharp_geck", "Splash-o-matic GCK-O"),
    ("sharp_neo", "Neo Splash-o-matic"),
    ("spaceshooter", "Splattershot Nova"),
    ("spaceshooter_collabo", "Annaki Splattershot Nova"),
    ("sshooter", "Splattershot"),
    ("sshooter_collabo", "Tentatek Splattershot"),
    ("sshooter_kou", "Glamorz Splattershot"),
    ("wakaba", "Splattershot Jr."),
    ("clashblaster", "Clash Blaster"),
    ("clashblaster_neo", "Clash Blaster Neo"),
    ("hotblaster", "Blaster"),
    ("hotblaster_custom", "Custom Blaster"),
    ("hotblaster_en", "Gleamz Blaster"),
    ("longblaster", "Range Blaster"),
    ("longblaster_custom", "Custom Range Blaster"),
    ("nova", "Luna Blaster"),
    ("nova_neo", "Luna Blaster Neo"),
    ("order_blaster_replica", "Order Blaster Replica"),
    ("rapid", "Rapid Blaster"),
    ("rapid_deco", "Rapid Blaster Deco"),
    ("rapid_elite", "Rapid Blaster Pro"),
    ("rapid_elite_deco", "Rapid Blaster Pro Deco"),
    ("rapid_elite_wntr", "Rapid Blaster Pro WNT-R"),
    ("sblast91", "S-BLAST '91"),
    ("sblast92", "S-BLAST '92"),
    ("h3reelgun", "H-3 Nozzlenose"),
    ("h3reelgun_d", "H-3 Nozzlenose D"),
    ("h3reelgun_snak", "H-3 Nozzlenose VIP-R"),
    ("l3reelgun", "L-3 Nozzlenose"),
    ("l3reelgun_d", "L-3 Nozzlenose D"),
    ("l3reelgun_haku", "Glitterz L-3 Nozzlenose"),
    ("dualsweeper", "Dualie Squelchers"),
    ("dualsweeper_custom", "Custom Dualie Squelchers"),
    ("dualsweeper_tei", "Hoofz Dualie Squelchers"),
    ("gaen_ff", "Douser Dualies FF"),
    ("gaen_ff_custom", "Custom Douser Dualies FF"),
    ("kelvin525", "Glooga Dualies"),
    ("kelvin525_deco", "Glooga Dualies Deco"),
    ("maneuver", "Splat Dualies"),
    ("maneuver_collabo", "Enperry Splat Dualies"),
    ("maneuver_you", "Twinklez Splat Dualies"),
    ("order_maneuver_replica", "Order Dualie Replicas"),
    ("quadhopper_black", "Dark Tetra Dualies"),
    ("quadhopper_white", "Light Tetra Dualies"),
    ("sputtery", "Dapple Dualies"),
    ("sputtery_hue", "Dapple Dualies Nouveau"),
    ("sputtery_owl", "Dapple Dualies NOC-T"),
    ("carbon", "Carbon Roller"),
    ("carbon_angl", "Carbon Roller ANG-L"),
    ("carbon_deco", "Carbon Roller Deco"),
    ("dynamo", "Dynamo Roller"),
    ("dynamo_mei", "Starz Dynamo Roller"),
    ("dynamo_tesla", "Gold Dynamo Roller"),
    ("order_roller_replica", "Order Roller Replica"),
    ("splatroller", "Splat Roller"),
    ("splatroller_collabo", "Krak-On Splat Roller"),
    ("variableroller", "Flingza Roller"),
    ("variableroller_foil", "Foil Flingza Roller"),
    ("wideroller", "Big Swig Roller"),
    ("wideroller_collabo", "Big Swig Roller Express"),
    ("wideroller_waku", "Planetz Big Swig Roller"),
    ("fincent", "Painbrush"),
    ("fincent_brnz", "Painbrush BRN-Z"),
    ("fincent_hue", "Painbrush Nouveau"),
    ("hokusai", "Octobrush"),
    ("hokusai_hue", "Octobrush Nouveau"),
    ("hokusai_sui", "Cometz Octobrush"),
    ("order_brush_replica", "Orderbrush Replica"),
    ("pablo", "Inkbrush"),
    ("pablo_hue", "Inkbrush Nouveau"),
    ("dentalwiper_mint", "Mint Decavitator"),
    ("dentalwiper_sumi", "Charcoal Decavitator"),
    ("drivewiper", "Splatana Wiper"),
    ("drivewiper_deco", "Splatana Wiper Deco"),
    ("drivewiper_rust", "Splatana Wiper RUS-T"),
    ("jimuwiper", "Splatana Stamper"),
    ("jimuwiper_fuu", "Stickerz Splatana Stamper"),
    ("jimuwiper_hue", "Splatana Stamper Nouveau"),
    ("order_wiper_replica", "Order Splatana Replica"),
    ("bamboo14mk1", "Bamboozler 14 Mk I"),
    ("bamboo14mk2", "Bamboozler 14 Mk II"),
    ("liter4k", "E-liter 4K"),
    ("liter4k_custom", "Custom E-liter 4K"),
    ("liter4k_scope", "E-liter 4K Scope"),
    ("liter4k_scope_custom", "Custom E-liter 4K Scope"),
    ("order_charger_replica", "Order Charger Replica"),
    ("rpen_5b", "Snipewriter 5B"),
    ("rpen_5h", "Snipewriter 5H"),
    ("soytuber", "Goo Tuber"),
    ("soytuber_custom", "Custom Goo Tuber"),
    ("splatcharger", "Splat Charger"),
    ("splatcharger_collabo", "Z+F Splat Charger"),
    ("splatcharger_frst", "Splat Charger CAM-O"),
    ("splatscope", "Splatterscope"),
    ("splatscope_collabo", "Z+F Splatterscope"),
    ("splatscope_frst", "Splatterscope CAM-O"),
    ("squiclean_a", "Classic Squiffer"),
    ("squiclean_b", "New Squiffer"),
    ("bucketslosher", "Slosher"),
    ("bucketslosher_deco", "Slosher Deco"),
    ("explosher", "Explosher"),
    ("explosher_custom", "Custom Explosher"),
    ("furo", "Bloblobber"),
    ("furo_deco", "Bloblobber Deco"),
    ("hissen", "Tri-Slosher"),
    ("hissen_ash", "Tri-Slosher ASH-N"),
    ("hissen_hue", "Tri-Slosher Nouveau"),
    ("moprin", "Dread Wringer"),
    ("moprin_d", "Dread Wringer D"),
    ("moprin_kaku", "Hornz Dread Wringer"),
    ("order_slosher_replica", "Order Slosher Replica"),
    ("screwslosher", "Sloshing Machine"),
    ("screwslosher_neo", "Sloshing Machine Neo"),
    ("barrelspinner", "Heavy Splatling"),
    ("barrelspinner_deco", "Heavy Splatling Deco"),
    ("examiner", "Heavy Edit Splatling"),
    ("examiner_hue", "Heavy Edit Splatling Nouveau"),
    ("hydra", "Hydra Splatling"),
    ("hydra_atsu", "Torrentz Hydra Splatling"),
    ("hydra_custom", "Custom Hydra Splatling"),
    ("kugelschreiber", "Ballpoint Splatling"),
    ("kugelschreiber_hue", "Ballpoint Splatling Nouveau"),
    ("nautilus47", "Nautilus 47"),
    ("nautilus79", "Nautilus 79"),
    ("order_spinner_replica", "Order Splatling Replica"),
    ("splatspinner", "Mini Splatling"),
    ("splatspinner_collabo", "Zink Mini Splatling"),
    ("splatspinner_pytn", "Mini Splatling RTL-R"),
    ("brella24mk1", "Recycled Brella 24 Mk I"),
    ("brella24mk2", "Recycled Brella 24 Mk II"),
    ("campingshelter", "Tenta Brella"),
    ("campingshelter_crem", "Tenta Brella CRE-M"),
    ("campingshelter_sorella", "Tenta Sorella Brella"),
    ("order_shelter_replica", "Order Brella Replica"),
    ("parashelter", "Splat Brella"),
    ("parashelter_sorella", "Sorella Brella"),
    ("spygadget", "Undercover Brella"),
    ("spygadget_ryo", "Patternz Undercover Brella"),
    ("spygadget_sorella", "Undercover Sorella Brella"),
    ("furuido", "Wellstring V"),
    ("furuido_custom", "Custom Wellstring V"),
    ("lact450", "REEF-LUX 450"),
    ("lact450_deco", "REEF-LUX 450 Deco"),
    ("lact450_milk", "REEF-LUX 450 MIL-K"),
    ("order_stringer_replica", "Order Stringer Replica"),
    ("tristringer", "Tri-Stringer"),
    ("tristringer_collabo", "Inkline Tri-Stringer"),
    ("tristringer_tou", "Bulbz Tri-Stringer"),
];

/// stat.ink slug からブキの公式英語名を引く。
pub fn lookup_name_en(slug: &str) -> Option<&'static str> {
    WEAPON_NAME_EN.iter().find(|(k, _)| *k == slug).map(|(_, en)| *en)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lookup_known_weapon() {
        assert_eq!(
            lookup("52gal"),
            Some(("シューター", "スプラッシュシールド", "メガホンレーザー5.1ch"))
        );
        assert_eq!(lookup("unknown_slug"), None);
    }

    #[test]
    fn reelguns_are_shooters() {
        assert_eq!(lookup("l3reelgun").map(|(c, _, _)| c), Some("シューター"));
        assert_eq!(lookup("h3reelgun").map(|(c, _, _)| c), Some("シューター"));
        assert_eq!(normalize_category("リールガン"), "シューター");
        assert_eq!(normalize_category("ブラスター"), "ブラスター");
    }

    #[test]
    fn all_entries_complete_and_unique() {
        let mut seen = std::collections::HashSet::new();
        for (key, cat, sub, sp) in WEAPON_STATIC_ATTRS {
            assert!(!key.is_empty() && !cat.is_empty() && !sub.is_empty() && !sp.is_empty(), "incomplete entry: {key}");
            assert!(seen.insert(*key), "duplicate slug: {key}");
        }
        assert_eq!(WEAPON_STATIC_ATTRS.len(), 173);
    }

    #[test]
    fn name_en_complete_and_unique() {
        let mut seen = std::collections::HashSet::new();
        for (key, en) in WEAPON_NAME_EN {
            assert!(!key.is_empty() && !en.is_empty(), "incomplete entry: {key}");
            assert!(seen.insert(*key), "duplicate slug: {key}");
        }
        assert_eq!(WEAPON_NAME_EN.len(), 173);
        // WEAPON_STATIC_ATTRS と同じ slug 集合であることを確認（取りこぼし検出）。
        let attr_keys: std::collections::HashSet<&str> =
            WEAPON_STATIC_ATTRS.iter().map(|(k, ..)| *k).collect();
        let en_keys: std::collections::HashSet<&str> =
            WEAPON_NAME_EN.iter().map(|(k, _)| *k).collect();
        assert_eq!(attr_keys, en_keys, "WEAPON_STATIC_ATTRS と WEAPON_NAME_EN の slug 集合が一致しない");
    }

    #[test]
    fn lookup_name_en_known_weapon() {
        assert_eq!(lookup_name_en("52gal"), Some(".52 Gal"));
        assert_eq!(lookup_name_en("unknown_slug"), None);
    }
}
