#!/usr/bin/env python3
"""upstream/98fmplayer/fmdsp/fontrom_shinonome.inc (C配列リテラル) をパースし、
pmdweb/html/shinonome.rom としてバイナリ出力する。

出典: upstream/98fmplayer/fmdsp/font.h の
  enum { FONT_ROM_FILESIZE = 0x46800 };
このサイズと一致しなければ異常終了する。
"""
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SRC = REPO_ROOT / "upstream/98fmplayer/fmdsp/fontrom_shinonome.inc"
DST = REPO_ROOT / "pmdweb/html/shinonome.rom"
EXPECTED_SIZE = 0x46800  # font.h: FONT_ROM_FILESIZE


def main() -> int:
    text = SRC.read_text(encoding="ascii")
    match = re.search(r"\{(.*)\}", text, re.DOTALL)
    if not match:
        print(f"error: could not locate array body in {SRC}", file=sys.stderr)
        return 1
    body = match.group(1)
    values = [int(tok, 16) for tok in re.findall(r"0x[0-9a-fA-F]+", body)]
    data = bytes(values)
    if len(data) != EXPECTED_SIZE:
        print(
            f"error: parsed {len(data)} bytes, expected {EXPECTED_SIZE} "
            f"(0x{EXPECTED_SIZE:x}) per font.h FONT_ROM_FILESIZE",
            file=sys.stderr,
        )
        return 1
    DST.parent.mkdir(parents=True, exist_ok=True)
    DST.write_bytes(data)
    print(f"wrote {DST} ({len(data)} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
