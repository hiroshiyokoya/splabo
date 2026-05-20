//! ギアパワー（アビリティ）の画像ハッシュ → stat.ink キー対応表と URL 逆引き。
//!
//! SplatNet 3 の画像 URL はハッシュ化されたファイル名（`<sha256>_0.png`）になっており、
//! CamelCase のアビリティ名は含まれない。s3s が持つハッシュ → stat.ink キーのテーブルを
//! そのまま転載して URL 内の部分一致で逆引きする。
//! 出典: https://github.com/frozenpandaman/s3s/blob/master/utils.py (translate_gear_ability)

/// 空スロット画像（ギアパワー未付与）を表す擬似キー。
pub const EMPTY_SLOT_KEY: &str = "empty";

/// (画像ファイル名ハッシュ, stat.ink アビリティキー)
/// None は空スロット画像を表す（画像キャッシュでは `EMPTY_SLOT_KEY` に正規化）。
pub const ABILITY_HASHES: &[(&str, Option<&str>)] = &[
    ("5c98cc37d2ce56291a7e430459dc9c44d53ca98b8426c5192f4a53e6dd6e4293", Some("ink_saver_main")),
    ("11293d8fe7cfb82d55629c058a447f67968fc449fd52e7dd53f7f162fa4672e3", Some("ink_saver_sub")),
    ("29b845ea895b931bfaf895e0161aeb47166cbf05f94f04601769c885d019073b", Some("ink_recovery_up")),
    ("3b6c56c57a6d8024f9c7d6e259ffa2e2be4bdf958653b834e524ffcbf1e6808e", Some("run_speed_up")),
    ("087ffffe40c28a40a39dc4a577c235f4cc375540c79dfa8ede1d8b63a063f261", Some("swim_speed_up")),
    ("e8668a2af7259be74814a9e453528a3e9773435a34177617a45bbf79ad0feb17", Some("special_charge_up")),
    ("e3154ab67494df2793b72eabf912104c21fbca71e540230597222e766756b3e4", Some("special_saver")),
    ("fba267bd56f536253a6bcce1e919d8a48c2b793c1b554ac968af8d2068b22cab", Some("special_power_up")),
    ("aaa9b7e95a61bfd869aaa9beb836c74f9b8d4e5d4186768a27d6e443c64f33ce", Some("quick_respawn")),
    ("138820ed46d68bdf2d7a21fb3f74621d8fc8c2a7cb6abe8d7c1a3d7c465108a7", Some("quick_super_jump")),
    ("9df9825e470e00727aa1009c4418cf0ace58e1e529dab9a7c1787309bb25f327", Some("sub_power_up")),
    ("db36f7e89194ed642f53465abfa449669031a66d7538135c703d3f7d41f99c0d", Some("ink_resistance_up")),
    ("664489b24e668ef1937bfc9a80a8cf9cf4927b1e16481fa48e7faee42122996d", Some("sub_resistance_up")),
    ("1a0c78a1714c5abababd7ffcba258c723fefade1f92684aa5f0ff7784cc467d0", Some("intensify_action")),
    ("85d97cd3d5890b80e020a554167e69b5acfa86e96d6e075b5776e6a8562d3d4a", Some("opening_gambit")),
    ("d514787f65831c5121f68b8d96338412a0d261e39e522638488b24895e97eb88", Some("last_ditch_effort")),
    ("aa5b599075c3c1d27eff696aeded9f1e1ddf7ae3d720268e520b260db5600d60", Some("tenacity")),
    ("748c101d23261aee8404c573a947ffc7e116a8da588c7371c40c4f2af6a05a19", Some("comeback")),
    ("2c0ef71abfb3efe0e67ab981fc9cd46efddcaf93e6e20da96980079f8509d05d", Some("ninja_squid")),
    ("de15cad48e5f23d147449c70ee4e2973118959a1a115401561e90fc65b53311b", Some("haunt")),
    ("56816a7181e663b5fedce6315eb0ad538e0aadc257b46a630fcfcc4a16155941", Some("thermal_ink")),
    ("de0d92f7dfed6c76772653d6858e7b67dd1c83be31bd2324c7939105180f5b71", Some("respawn_punisher")),
    ("0d6607b6334e1e84279e482c1b54659e31d30486ef0576156ee0974d8d569dbc", Some("ability_doubler")),
    ("f9c21eacf6dbc1d06edbe498962f8ed766ab43cb1d63806f3731bf57411ae7b6", Some("stealth_jump")),
    ("9d982dc1a7a8a427d74df0edcebcc13383c325c96e75af17b9cdb6f4e8dafb24", Some("object_shredder")),
    ("18f03a68ee64da0a2e4e40d6fc19de2e9af3569bb6762551037fd22cf07b7d2d", Some("drop_roller")),
    // 空スロット用画像
    ("dc937b59892604f5a86ac96936cd7ff09e25f18ae6b758e8014a24c7fa039e91", None),
];

/// 画像 URL から stat.ink のアビリティキーを返す。
/// 空スロット画像は `Some(None)`、未知ハッシュは `None`。
pub fn ability_key_from_url(url: &str) -> Option<Option<&'static str>> {
    ABILITY_HASHES
        .iter()
        .find(|(hash, _)| url.contains(hash))
        .map(|(_, key)| *key)
}

/// 画像 URL からキャッシュキーを返す。空スロットは `EMPTY_SLOT_KEY`、
/// 未知ハッシュは `None`（キャッシュ対象外）。
pub fn cache_key_from_url(url: &str) -> Option<&'static str> {
    match ability_key_from_url(url) {
        Some(Some(key)) => Some(key),
        Some(None)      => Some(EMPTY_SLOT_KEY),
        None            => None,
    }
}
