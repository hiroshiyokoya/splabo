//! Splatoon 3 ステージの公式英語名（#712）。
//!
//! stat.ink /api/v3/stage（2026-08 時点）の `name.en_US` から生成。
//! ステージは今後追加される可能性があるため、weapon_static.rs と違い
//! 陳腐化しうる（新ステージ追加時は再取得して追記する）。

/// stat.ink slug（`map.statink_key` と一致）→ ステージの公式英語名。
pub const STAGE_NAME_EN: &[(&str, &str)] = &[
    ("yunohana", "Scorch Gorge"),
    ("gonzui", "Eeltail Alley"),
    ("kinmedai", "Museum d'Alfonsino"),
    ("mategai", "Undertow Spillway"),
    ("namero", "Mincemeat Metalworks"),
    ("yagara", "Hagglefish Market"),
    ("masaba", "Hammerhead Bridge"),
    ("mahimahi", "Mahi-Mahi Resort"),
    ("zatou", "MakoMart"),
    ("chozame", "Sturgeon Shipyard"),
    ("amabi", "Inkblot Art Academy"),
    ("sumeshi", "Wahoo World"),
    ("hirame", "Flounder Heights"),
    ("kusaya", "Brinewater Springs"),
    ("manta", "Manta Maria"),
    ("nampla", "Um'ami Ruins"),
    ("taraport", "Barnacle & Dime"),
    ("kombu", "Humpback Pump Track"),
    ("takaashi", "Crableg Capital"),
    ("ohyo", "Shipshape Cargo Co."),
    ("negitoro", "Bluefin Depot"),
    ("baigai", "Robo ROM-en"),
    ("kajiki", "Marlin Airport"),
    ("ryugu", "Lemuria Hub"),
    ("grand_arena", "Grand Splatlands Bowl"),
    ("decaline", "Urchin Underpass"),
];

/// stat.ink slug からステージの公式英語名を引く。
pub fn lookup_name_en(slug: &str) -> Option<&'static str> {
    STAGE_NAME_EN.iter().find(|(k, _)| *k == slug).map(|(_, en)| *en)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entries_complete_and_unique() {
        let mut seen = std::collections::HashSet::new();
        for (key, en) in STAGE_NAME_EN {
            assert!(!key.is_empty() && !en.is_empty(), "incomplete entry: {key}");
            assert!(seen.insert(*key), "duplicate slug: {key}");
        }
        assert_eq!(STAGE_NAME_EN.len(), 26);
    }

    #[test]
    fn lookup_name_en_known_stage() {
        assert_eq!(lookup_name_en("yunohana"), Some("Scorch Gorge"));
        assert_eq!(lookup_name_en("unknown_slug"), None);
    }
}
