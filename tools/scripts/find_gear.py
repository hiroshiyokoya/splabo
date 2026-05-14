#!/usr/bin/env python3
"""
所有ギアをスキル・ブランド・カテゴリ・レアリティで検索する。

Usage:
  python3 scripts/find_gear.py [オプション]

検索オプション（複数指定で AND 絞り込み）:
  --skill  SKILL     指定スキルが付いているギアを検索（メイン or サブ）
  --main             --skill と組み合わせ: メインスロットのみ対象
  --sub              --skill と組み合わせ: サブスロットのみ対象
  --brand  BRAND     ブランド名で絞り込み（部分一致）
  --category CAT     カテゴリで絞り込み: head / clothing / shoes
  --rarity N         レアリティで絞り込み（0〜4）

表示オプション:
  --list             ギア名・ブランド・スキル構成を1行で簡潔に表示
  -h, --help         このヘルプを表示

例:
  python3 scripts/find_gear.py --skill インク回復力アップ
  python3 scripts/find_gear.py --skill インク回復力アップ --main
  python3 scripts/find_gear.py --skill インク回復力アップ --category clothing
  python3 scripts/find_gear.py --brand アナアキ --rarity 2
  python3 scripts/find_gear.py --category head --list
"""

import json
import sys
from pathlib import Path

GEAR_DB = Path(__file__).parent.parent / "data" / "gear_db.json"

CATEGORY_LABEL = {"head": "頭", "clothing": "服", "shoes": "靴"}


def parse_args(argv: list[str]) -> dict:
    opts = {
        "skill": None,
        "main_only": False,
        "sub_only": False,
        "brand": None,
        "category": None,
        "rarity": None,
        "list_mode": False,
    }
    i = 1
    while i < len(argv):
        arg = argv[i]
        if arg in ("-h", "--help"):
            print(__doc__)
            sys.exit(0)
        elif arg == "--skill" and i + 1 < len(argv):
            opts["skill"] = argv[i + 1]
            i += 2
        elif arg == "--main":
            opts["main_only"] = True
            i += 1
        elif arg == "--sub":
            opts["sub_only"] = True
            i += 1
        elif arg == "--brand" and i + 1 < len(argv):
            opts["brand"] = argv[i + 1]
            i += 2
        elif arg == "--category" and i + 1 < len(argv):
            cat = argv[i + 1]
            if cat not in ("head", "clothing", "shoes"):
                print(f"--category は head / clothing / shoes のいずれかを指定してください", file=sys.stderr)
                sys.exit(1)
            opts["category"] = cat
            i += 2
        elif arg == "--rarity" and i + 1 < len(argv):
            opts["rarity"] = int(argv[i + 1])
            i += 2
        elif arg == "--list":
            opts["list_mode"] = True
            i += 1
        else:
            print(f"不明な引数: {arg!r}", file=sys.stderr)
            sys.exit(1)
    return opts


def skill_matches(gear: dict, skill: str, main_only: bool, sub_only: bool) -> bool:
    in_main = gear["primary_skill"]["name"] == skill
    in_sub  = any(s["name"] == skill for s in gear["additional_skills"])
    if main_only:
        return in_main
    if sub_only:
        return in_sub
    return in_main or in_sub


def format_gear_detail(gear: dict, category: str, skill: str | None) -> str:
    subs = [s["name"] for s in gear["additional_skills"]]
    stars = "★" * (gear["rarity"] + 1)
    lines = [
        f"[{CATEGORY_LABEL[category]}] {gear['name']}  {stars}  {gear['brand']}",
        f"  メイン: {gear['primary_skill']['name']}",
        f"  サブ:   {', '.join(subs)}",
    ]
    if skill:
        in_main = gear["primary_skill"]["name"] == skill
        sub_count = sum(1 for s in gear["additional_skills"] if s["name"] == skill)
        ap = (10 if in_main else 0) + sub_count * 3
        lines.append(f"  → {skill}: {ap}AP")
    return "\n".join(lines)


def format_gear_list(gear: dict, category: str) -> str:
    subs = [s["name"] for s in gear["additional_skills"]]
    stars = "★" * (gear["rarity"] + 1)
    return (
        f"[{CATEGORY_LABEL[category]}] {gear['name']:<24} {stars:<5} "
        f"{gear['brand']:<20} "
        f"メイン: {gear['primary_skill']['name']:<20} "
        f"サブ: {', '.join(subs)}"
    )


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(0)

    opts = parse_args(sys.argv)

    with open(GEAR_DB, encoding='utf-8') as f:
        db = json.load(f)

    categories = ["head", "clothing", "shoes"]
    if opts["category"]:
        categories = [opts["category"]]

    results: list[tuple[str, dict]] = []

    for cat in categories:
        for gear in db[cat]:
            if opts["skill"] and not skill_matches(
                gear, opts["skill"], opts["main_only"], opts["sub_only"]
            ):
                continue
            if opts["brand"] and opts["brand"] not in gear["brand"]:
                continue
            if opts["rarity"] is not None and gear["rarity"] != opts["rarity"]:
                continue
            results.append((cat, gear))

    conditions = []
    if opts["skill"]:
        slot = "（メインのみ）" if opts["main_only"] else "（サブのみ）" if opts["sub_only"] else ""
        conditions.append(f"スキル: {opts['skill']}{slot}")
    if opts["brand"]:
        conditions.append(f"ブランド: {opts['brand']}")
    if opts["category"]:
        conditions.append(f"カテゴリ: {CATEGORY_LABEL[opts['category']]}")
    if opts["rarity"] is not None:
        conditions.append(f"レアリティ: {'★' * (opts['rarity'] + 1)}")

    if conditions:
        print(f"検索条件: {' / '.join(conditions)}")
    print(f"{len(results)} 件ヒット\n")

    for cat, gear in results:
        if opts["list_mode"]:
            print(format_gear_list(gear, cat))
        else:
            print(format_gear_detail(gear, cat, opts["skill"]))
            print()


if __name__ == "__main__":
    main()
