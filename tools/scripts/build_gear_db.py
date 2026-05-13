#!/usr/bin/env python3
"""
splatnet3-equipment.json から所有ギアのデータベース JSON を生成する。

出力: data/gear_db.json
  {
    "head":     [ { id, name, rarity, brand, image, primary_skill, additional_skills, exp }, ... ],
    "clothing": [ ... ],
    "shoes":    [ ... ]
  }

image / skill.image はローカルの data/images/ からの相対パス。
"""

import json
from pathlib import Path

EQUIPMENT_JSON = Path(__file__).parent.parent / "data" / "data" / "splatnet3" / "splatnet3-equipment.json"
OUT_JSON       = Path(__file__).parent.parent / "data" / "gear_db.json"

GEAR_SECTIONS = {
    "headGears":     ("head",     "headGearId"),
    "clothingGears": ("clothing", "clothingGearId"),
    "shoesGears":    ("shoes",    "shoesGearId"),
}


def local_image(url: str, subdir: str) -> str:
    """URL から署名を除いたファイル名を取り、images/<subdir>/<file> パスを返す。"""
    fname = Path(url.split("?")[0]).name
    return f"images/{subdir}/{fname}"


def skill_entry(power_node: dict) -> dict:
    return {
        "id":    power_node["gearPowerId"],
        "name":  power_node["name"],
        "image": local_image(power_node["image"]["url"], "skill"),
    }


def gear_entry(node: dict, category: str, id_field: str) -> dict:
    return {
        "id":          node[id_field],
        "name":        node["name"],
        "rarity":      node["rarity"],
        "brand":       node["brand"]["name"],
        "brand_image": local_image(node["brand"]["image"]["url"], "brand"),
        "image":       local_image(node["image"]["url"], f"gear/{category}"),
        "primary_skill":     skill_entry(node["primaryGearPower"]),
        "additional_skills": [skill_entry(p) for p in node["additionalGearPowers"]],
        "exp":         node["stats"]["exp"],
    }


def main() -> None:
    with open(EQUIPMENT_JSON, encoding='utf-8') as f:
        equipment = json.load(f)

    db: dict[str, list] = {}
    for section, (category, id_field) in GEAR_SECTIONS.items():
        nodes = equipment["data"][section]["nodes"]
        db[category] = [gear_entry(n, category, id_field) for n in nodes]
        print(f"  {category}: {len(db[category])} items")

    OUT_JSON.write_text(json.dumps(db, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nSaved → {OUT_JSON}")


if __name__ == "__main__":
    main()
