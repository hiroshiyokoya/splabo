#!/usr/bin/env python3
"""CHANGELOG から X 告知文を組む (#648)。

GitHub リリース Publish 後に Slack へ流す文面。280 加重字に収める。
URL は t.co 換算 23、非 ASCII は 2、ASCII は 1。
"""
from __future__ import annotations

import argparse
import re
import sys
import unicodedata

DOWNLOAD_URL = "https://chartoon.pages.dev/"
TCO_LEN = 23
MAX_WEIGHT = 280
MAX_BULLETS = 3

VERSION_RE = re.compile(r"^## \[([^\]]+)\]")
URL_RE = re.compile(r"https?://[^\s]+")


def tweet_weight(text: str) -> int:
    """X の加重文字数。URL は t.co 23 固定。"""
    n = 0
    pos = 0
    for m in URL_RE.finditer(text):
        n += _run_weight(text[pos:m.start()])
        n += TCO_LEN
        pos = m.end()
    n += _run_weight(text[pos:])
    return n


def _run_weight(s: str) -> int:
    w = 0
    for ch in s:
        if ch == "\n" or ch == "\r":
            w += 1
            continue
        # East Asian Wide/Fullwidth とそれ以外の非 Latin-1 は 2。
        ea = unicodedata.east_asian_width(ch)
        w += 2 if ea in ("W", "F") or ord(ch) > 0x10FF else 1
    return w


def extract_bullets(changelog: str, version: str) -> list[str]:
    lines = changelog.splitlines()
    in_section = False
    bullets: list[str] = []
    for line in lines:
        m = VERSION_RE.match(line)
        if m:
            if in_section:
                break
            in_section = m.group(1) == version
            continue
        if not in_section:
            continue
        if line.startswith("- "):
            bullets.append(line[2:].strip())
    return bullets


def shorten_bullet(raw: str) -> str:
    s = raw.replace("**", "")
    s = re.sub(r"\s*[（(][^）)]*[）)]\s*$", "", s)
    s = re.sub(r"ようにしました。?$", "", s)
    s = re.sub(r"しました。?$", "", s)
    s = s.rstrip("。").strip()
    return s


def build_post(version: str, bullets: list[str]) -> str:
    short = [shorten_bullet(b) for b in bullets if shorten_bullet(b)]
    chosen = short[:MAX_BULLETS]

    def compose(items: list[str]) -> str:
        parts = [f"splabo v{version} を出しました。", ""]
        if items:
            parts.extend(f"・{b}" for b in items)
            parts.append("")
        parts.extend(["ダウンロード", DOWNLOAD_URL])
        return "\n".join(parts)

    text = compose(chosen)
    while tweet_weight(text) > MAX_WEIGHT and chosen:
        chosen = chosen[:-1]
        text = compose(chosen)
    if tweet_weight(text) > MAX_WEIGHT:
        # 箇条書き無しでも溢れることはまず無い。保険で末尾を切る。
        while tweet_weight(text) > MAX_WEIGHT and len(text) > 8:
            text = text[:-2] + "…"
    return text


def render(changelog: str, version: str) -> str:
    return build_post(version, extract_bullets(changelog, version))


def self_test() -> None:
    sample = """# Changelog

## [Unreleased]

## [0.10.4] — 2026-08-14

### Changed

- 散布図のツールチップに、ブキの**サブとスペシャル**のアイコンを出すようにしました（ダッシュボード・環境分析。保存 HTML も同じ）
- ヒートマップの**ブキ軸ラベル**をホバーすると、名前とサブ／スペシャルのアイコンが出るようにしました（ダッシュボード・環境分析）
- 自動取得に失敗したときの通知に**時刻**を出すようにしました（何度も溜まったとき、いつ失敗したか分かるように）

### Fixed

- ステージ図鑑で **平均塗り** で並び替えできるようにしました（一覧ヘッダ・パネルの並び順）

## [0.10.3] — 2026-08-13

- これは混ざらない
"""
    text = render(sample, "0.10.4")
    assert "0.10.3" not in text
    assert "splabo v0.10.4 を出しました。" in text
    assert DOWNLOAD_URL in text
    assert "**" not in text
    assert tweet_weight(text) <= MAX_WEIGHT, tweet_weight(text)
    assert "散布図" in text
    empty = render("# Changelog\n\n## [1.0.0]\n\n### Changed\n\n", "1.0.0")
    assert empty.startswith("splabo v1.0.0")
    assert tweet_weight(empty) <= MAX_WEIGHT
    missing = render("# Changelog\n", "9.9.9")
    assert "splabo v9.9.9" in missing
    print(text)
    print("--- weight:", tweet_weight(text), "/", MAX_WEIGHT)


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--changelog", help="CHANGELOG.md のパス")
    p.add_argument("--version", help="0.10.4 形式（splabo-v 無し）")
    p.add_argument("--self-test", action="store_true")
    args = p.parse_args()
    if args.self_test:
        self_test()
        return 0
    if not args.changelog or not args.version:
        print("--changelog と --version が必要です", file=sys.stderr)
        return 2
    version = args.version.removeprefix("splabo-v")
    changelog = open(args.changelog, encoding="utf-8").read()
    sys.stdout.write(render(changelog, version))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
