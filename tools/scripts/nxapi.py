#!/usr/bin/env python3
"""
docker compose run --rm nxapi のラッパ。
nxapi.sh の代替（クロスプラットフォーム対応）。

Usage:
  python3 scripts/nxapi.py [nxapi のコマンドと引数...]

例:
  python3 scripts/nxapi.py nso auth
  python3 scripts/nxapi.py nso user
  python3 scripts/nxapi.py splatnet3 dump-records data/splatnet3
  python3 scripts/nxapi.py --help
"""

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent


def main() -> None:
    cmd = ["docker", "compose", "run", "--rm", "nxapi", *sys.argv[1:]]
    result = subprocess.run(cmd, cwd=ROOT)
    sys.exit(result.returncode)


if __name__ == "__main__":
    main()
