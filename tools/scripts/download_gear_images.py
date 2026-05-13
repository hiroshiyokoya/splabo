#!/usr/bin/env python3
"""
SplatNet 3 の JSON ファイルからギア・スキル画像をダウンロードする。
equipment JSON からはカテゴリ別 (head / clothing / shoes) に振り分ける。
"""

import json
import sys
import urllib.request
import urllib.error
from pathlib import Path

DATA_DIR = Path(__file__).parent.parent / "data" / "data" / "splatnet3"
OUT_DIR = Path(__file__).parent.parent / "data" / "images"
EQUIPMENT_JSON = DATA_DIR / "splatnet3-equipment.json"

GEAR_SECTIONS = {
    "headGears":     "head",
    "clothingGears": "clothing",
    "shoesGears":    "shoes",
}


def filename_from_url(url: str) -> str:
    return Path(url.split("?")[0]).name


def download(url: str, dest: Path) -> bool:
    if dest.exists():
        return False
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            dest.write_bytes(resp.read())
        return True
    except urllib.error.HTTPError as e:
        print(f"  HTTP {e.code}: {dest.name}", file=sys.stderr)
        return False
    except Exception as e:
        print(f"  Error {dest.name}: {e}", file=sys.stderr)
        return False


def collect_gear_by_category(equipment: dict) -> dict[str, set[str]]:
    """equipment JSON から head / clothing / shoes 別に gear_img URL を収集する。"""
    result: dict[str, set[str]] = {}
    for section, label in GEAR_SECTIONS.items():
        nodes = equipment.get("data", {}).get(section, {}).get("nodes", [])
        for node in nodes:
            url = node.get("image", {}).get("url", "")
            if url:
                result.setdefault(label, set()).add(url)
    return result


def collect_brand_urls(equipment: dict) -> set[str]:
    """equipment JSON から brand_img URL を収集する。"""
    urls: set[str] = set()
    for section in GEAR_SECTIONS:
        nodes = equipment.get("data", {}).get(section, {}).get("nodes", [])
        for node in nodes:
            url = node.get("brand", {}).get("image", {}).get("url", "")
            if url:
                urls.add(url)
    return urls


def collect_skill_urls(*json_files) -> set[str]:
    """複数の JSON ファイルから skill_img URL を収集する。"""
    urls: set[str] = set()

    def walk(obj, depth=0):
        if depth > 20:
            return
        if isinstance(obj, dict):
            for v in obj.values():
                walk(v, depth + 1)
        elif isinstance(obj, list):
            for item in obj:
                walk(item, depth + 1)
        elif isinstance(obj, str) and "/skill_img/" in obj and obj.startswith("https://"):
            urls.add(obj)

    for jf in json_files:
        with open(jf, encoding='utf-8') as f:
            walk(json.load(f))
    return urls


def main() -> None:
    if not EQUIPMENT_JSON.exists():
        print(f"equipment JSON not found: {EQUIPMENT_JSON}", file=sys.stderr)
        print("先に update.py を実行してください。", file=sys.stderr)
        sys.exit(1)

    with open(EQUIPMENT_JSON, encoding='utf-8') as f:
        equipment = json.load(f)

    gear_by_cat = collect_gear_by_category(equipment)

    all_json = sorted(DATA_DIR.glob("*.json"))
    skill_urls = collect_skill_urls(*all_json)

    brand_urls = collect_brand_urls(equipment)

    total_gear = sum(len(v) for v in gear_by_cat.values())
    print(f"Gear images : {total_gear}  (head={len(gear_by_cat.get('head', []))}, clothing={len(gear_by_cat.get('clothing', []))}, shoes={len(gear_by_cat.get('shoes', []))})")
    print(f"Skill images: {len(skill_urls)}")
    print(f"Brand images: {len(brand_urls)}")

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    downloaded = skipped = 0

    for label, urls in sorted(gear_by_cat.items()):
        cat_dir = OUT_DIR / "gear" / label
        cat_dir.mkdir(parents=True, exist_ok=True)
        for url in sorted(urls):
            fname = filename_from_url(url)
            if download(url, cat_dir / fname):
                print(f"  [gear/{label}] {fname}")
                downloaded += 1
            else:
                skipped += 1

    skill_dir = OUT_DIR / "skill"
    skill_dir.mkdir(exist_ok=True)
    for url in sorted(skill_urls):
        fname = filename_from_url(url)
        if download(url, skill_dir / fname):
            print(f"  [skill] {fname}")
            downloaded += 1
        else:
            skipped += 1

    brand_dir = OUT_DIR / "brand"
    brand_dir.mkdir(exist_ok=True)
    for url in sorted(brand_urls):
        fname = filename_from_url(url)
        if download(url, brand_dir / fname):
            print(f"  [brand] {fname}")
            downloaded += 1
        else:
            skipped += 1

    print(f"\nDone: {downloaded} downloaded, {skipped} skipped (already existed)")
    print(f"Output: {OUT_DIR}")


if __name__ == "__main__":
    main()
