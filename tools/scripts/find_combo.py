#!/usr/bin/env python3
"""
所有ギアを前提に、スキル目標から装備の組み合わせを探索する。また、所持ギアに登場するギアパワー名を一覧表示できる。

実装関数一覧:
  parse_args: 要件 AP、表示件数、JSON 出力パスを argv から取り出す。
  collect_owned_skill_names: gear_db からスキル名の集合を集める。はてなは除く。
  print_owned_skill_list: スキルをソートして標準出力に1行1件で出す。
  gear_ap: 1 件のギアについて、指定スキルごとの装備内 AP を返す。
  format_gear: 探索結果用にギア1件を整形した文字列にする。
  main: 引数に応じてスキル一覧または組み合わせ探索を実行する。

依存している自作関数一覧:
  なし。

Usage:
  python3 scripts/find_combo.py "スキル名:目標AP" ["スキル名:目標AP" ...]
  python3 scripts/find_combo.py --list-skills

AP 計算:
  メインスロット = 10AP、サブスロット = 3AP
  3ギア合計最大 = メイン3×10 + サブ9×3 = 57AP

例:
  python3 scripts/find_combo.py --list-skills
  python3 scripts/find_combo.py "インク回復力アップ:20"
  python3 scripts/find_combo.py "カムバック" "スペシャル増加量アップ:6"
  python3 scripts/find_combo.py "インク効率アップ(メイン):10" "スペシャル増加量アップ:10" --limit 5
  python3 scripts/find_combo.py "カムバック" --json results.json
"""

import json
import sys
from pathlib import Path

GEAR_DB = Path(__file__).parent.parent / "data" / "gear_db.json"
MAIN_AP = 10
SUB_AP = 3
MAX_AP_PER_PIECE = MAIN_AP + SUB_AP * 3  # 19

# メインスロットにのみ存在するギアパワーID（geartoon/app の定義と揃える）
MAIN_ONLY_SKILL_IDS: set[int] = {
    100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111
}

def load_json(path: Path) -> dict:
    for enc in ("utf-8", "utf-8-sig", "cp932"):
        try:
            return json.loads(path.read_text(encoding=enc))
        except UnicodeDecodeError:
            continue
    return json.loads(path.read_bytes().decode("utf-8", errors="replace"))


def build_skill_name_to_id(db: dict) -> dict[str, int]:
    name_to_id: dict[str, int] = {}
    for cat in ("head", "clothing", "shoes"):
        for gear in db.get(cat, []):
            s = gear["primary_skill"]
            if s.get("name") and s.get("id") is not None:
                name_to_id.setdefault(s["name"], s["id"])
            for sub in gear.get("additional_skills", []):
                if sub.get("name") and sub.get("id") is not None:
                    name_to_id.setdefault(sub["name"], sub["id"])
    return name_to_id


def parse_args(
    argv: list[str],
    skill_name_to_id: dict[str, int],
) -> tuple[dict[str, int], int, Path | None]:
    requirements: dict[str, int] = {}
    limit = 20
    out_json: Path | None = None
    i = 1
    while i < len(argv):
        arg = argv[i]
        if arg == "--limit" and i + 1 < len(argv):
            limit = int(argv[i + 1])
            i += 2
        elif arg == "--json" and i + 1 < len(argv):
            out_json = Path(argv[i + 1])
            i += 2
        else:
            if ":" in arg:
                name, _, ap_str = arg.rpartition(":")
                if not name:
                    print(f"Invalid argument: {arg!r}", file=sys.stderr)
                    sys.exit(1)
                requirements[name.strip()] = int(ap_str)
                i += 1
                continue

            name = arg.strip()
            if not name:
                print(f"Invalid argument: {arg!r}", file=sys.stderr)
                sys.exit(1)

            skill_id = skill_name_to_id.get(name)
            if skill_id is None:
                print(f"未知のスキル名です: {name}", file=sys.stderr)
                print("ヒント: --list-skills で所持ギアに登場するスキル名を確認できます。", file=sys.stderr)
                sys.exit(1)

            if skill_id in MAIN_ONLY_SKILL_IDS:
                requirements[name] = MAIN_AP
            else:
                print(
                    f"スタック型スキルは 'スキル名:目標AP' 形式で指定してください: {name}",
                    file=sys.stderr,
                )
                print(
                    "例: \"インク回復力アップ:20\"  \"スペシャル増加量アップ:6\"",
                    file=sys.stderr,
                )
                sys.exit(1)
            i += 1
    return requirements, limit, out_json


def collect_owned_skill_names(db: dict) -> list[str]:
    """gear_db 全体から、メインまたはサブとして登場するスキル名を重複なく集める。はてなは除く。"""
    names: set[str] = set()
    for cat in ("head", "clothing", "shoes"):
        for gear in db.get(cat, []):
            names.add(gear["primary_skill"]["name"])
            for sub in gear.get("additional_skills", []):
                n = sub.get("name") or ""
                if n and n != "はてな":
                    names.add(n)
    return sorted(names)


def collect_owned_skills(db: dict) -> list[tuple[int, str]]:
    """gear_db 全体から、メインまたはサブとして登場するスキルを重複なく集める。はてなは除く。"""
    skills: dict[int, str] = {}
    for cat in ("head", "clothing", "shoes"):
        for gear in db.get(cat, []):
            s = gear.get("primary_skill") or {}
            sid = s.get("id")
            name = (s.get("name") or "").strip()
            if isinstance(sid, int) and sid != -1 and name and name != "はてな":
                skills.setdefault(sid, name)
            for sub in gear.get("additional_skills", []):
                sid = sub.get("id")
                name = (sub.get("name") or "").strip()
                if isinstance(sid, int) and sid != -1 and name and name != "はてな":
                    skills.setdefault(sid, name)
    return sorted(skills.items(), key=lambda x: x[0])


def print_owned_skill_list() -> None:
    if not GEAR_DB.exists():
        print(f"gear_db が見つかりません: {GEAR_DB}", file=sys.stderr)
        print("先に python3 scripts/build_gear_db.py を実行してください。", file=sys.stderr)
        sys.exit(1)
    db = load_json(GEAR_DB)
    skills = collect_owned_skills(db)
    for sid, name in skills:
        print(f"{sid}\t{name}")
    print(f"\n計 {len(skills)} スキル（所持ギアに登場するIDと名称）", file=sys.stderr)


def gear_ap(gear: dict, skill_names: list[str]) -> dict[str, int]:
    ap: dict[str, int] = {}
    for s in skill_names:
        v = 0
        if gear["primary_skill"]["name"] == s:
            v += MAIN_AP
        for sub in gear["additional_skills"]:
            if sub["name"] == s:
                v += SUB_AP
        ap[s] = v
    return ap


def format_gear(gear: dict, skill_names: list[str], main_only_skills: set[str]) -> str:
    subs = [s["name"] for s in gear["additional_skills"]]
    ap_parts = []
    for s in skill_names:
        v = 0
        if gear["primary_skill"]["name"] == s:
            v += MAIN_AP
        for sub in gear["additional_skills"]:
            if sub["name"] == s:
                v += SUB_AP
        if v:
            ap_parts.append(s if s in main_only_skills else f"{s} {v}AP")
    ap_str = f"  [{', '.join(ap_parts)}]" if ap_parts else ""
    return (
        f"{gear['name']} ({gear['brand']})"
        f"  main: {gear['primary_skill']['name']}"
        f"  sub: {', '.join(subs)}"
        f"{ap_str}"
    )


def main() -> None:
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help"):
        print(__doc__)
        sys.exit(0)

    if sys.argv[1] == "--list-skills":
        if len(sys.argv) > 2:
            print("--list-skills 以外の引数は指定できません。", file=sys.stderr)
            sys.exit(1)
        print_owned_skill_list()
        sys.exit(0)

    db = load_json(GEAR_DB)

    skill_name_to_id = build_skill_name_to_id(db)
    requirements, limit, out_json = parse_args(sys.argv, skill_name_to_id)
    skill_names = list(requirements.keys())
    main_only_skills = {
        name
        for name in skill_names
        if (skill_name_to_id.get(name) in MAIN_ONLY_SKILL_IDS)
    }

    # AP ベクトルを事前計算
    heads     = [(g, gear_ap(g, skill_names)) for g in db["head"]]
    clothings = [(g, gear_ap(g, skill_names)) for g in db["clothing"]]
    shoes_all = [(g, gear_ap(g, skill_names)) for g in db["shoes"]]

    # 各カテゴリの最大 AP を確認（実現可能性チェック）
    max_ap = {s: 0 for s in skill_names}
    for items in (heads, clothings, shoes_all):
        for _, ap in items:
            for s in skill_names:
                max_ap[s] = max(max_ap[s], ap[s])

    total_max = {s: sum(
        max(ap[s] for _, ap in items)
        for items in (heads, clothings, shoes_all)
    ) for s in skill_names}

    for s, target in requirements.items():
        if total_max[s] < target:
            print(f"[不可能] '{s}' の目標 {target}AP は達成できません（最大 {total_max[s]}AP）")
            sys.exit(1)

    # 探索（枝刈りあり）
    valid: list[dict] = []

    for h, h_ap in heads:
        if any(requirements[s] - h_ap[s] > MAX_AP_PER_PIECE * 2 for s in skill_names):
            continue

        for c, c_ap in clothings:
            min_shoes = {s: max(0, requirements[s] - h_ap[s] - c_ap[s]) for s in skill_names}

            if any(min_shoes[s] > MAX_AP_PER_PIECE for s in skill_names):
                continue

            for sh, sh_ap in shoes_all:
                if all(h_ap[s] + c_ap[s] + sh_ap[s] >= requirements[s] for s in skill_names):
                    total_ap = {s: h_ap[s] + c_ap[s] + sh_ap[s] for s in skill_names}
                    valid.append({
                        "head":     h,
                        "clothing": c,
                        "shoes":    sh,
                        "total_ap": total_ap,
                    })

    valid.sort(key=lambda x: sum(x["total_ap"].values()))

    print(f"\n{len(valid)} 件の組み合わせが見つかりました（上位 {min(limit, len(valid))} 件を表示）\n")

    for i, combo in enumerate(valid[:limit], 1):
        ap_str = "  ".join(
            (s if s in main_only_skills else f"{s}: {combo['total_ap'][s]}AP")
            for s in skill_names
        )
        print(f"─── {i:3d}  {ap_str}")
        print(f"  [頭] {format_gear(combo['head'],     skill_names, main_only_skills)}")
        print(f"  [服] {format_gear(combo['clothing'], skill_names, main_only_skills)}")
        print(f"  [靴] {format_gear(combo['shoes'],    skill_names, main_only_skills)}")
        print()

    if out_json:
        out_json.write_text(json.dumps(
            [{"head": c["head"], "clothing": c["clothing"], "shoes": c["shoes"], "total_ap": c["total_ap"]}
             for c in valid],
            ensure_ascii=False, indent=2
        ))
        print(f"JSON 保存: {out_json}  ({len(valid)} 件)")


if __name__ == "__main__":
    main()
