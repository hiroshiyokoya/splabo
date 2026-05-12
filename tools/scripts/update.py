#!/usr/bin/env python3
"""
ギア DB を最新状態に更新する（fetch → download → build を一括実行）。
update.sh の代替（クロスプラットフォーム対応）。

Usage:
  python3 scripts/update.py
"""

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent


def run(cmd: list, **kwargs) -> None:
    result = subprocess.run(cmd, cwd=ROOT, **kwargs)
    if result.returncode != 0:
        sys.exit(result.returncode)


def main() -> None:
    print("=== ステップ 1/3: 所有ギアデータを API から取得 ===")
    run([
        "docker", "compose", "run", "--rm",
        "--entrypoint", "node",
        "nxapi", "/data/scripts/fetch_equipment.mjs"
    ])

    print("\n=== ステップ 2/3: ギア・スキル画像をダウンロード ===")
    run([sys.executable, "scripts/download_gear_images.py"])

    print("\n=== ステップ 3/3: 構造化 DB JSON を生成 ===")
    run([sys.executable, "scripts/build_gear_db.py"])

    print("\n✅ 更新完了")


if __name__ == "__main__":
    main()
