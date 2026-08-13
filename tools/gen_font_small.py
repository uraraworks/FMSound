#!/usr/bin/env python3
"""upstream/98fmplayer/fmdsp/font_fmdsp_small_data.h の fontdat[] と
font_fmdsp_medium_data.h の fmdsp_medium_dat[] (C配列リテラル) をパースし、
pmdweb/html/fmdsp/font_small.js (ES module) として出力する。

出典:
  upstream/98fmplayer/fmdsp/font_fmdsp_small.c:14-16
    const struct fmdsp_font font_fmdsp_small = { fmdsp_font_get, 0, 5, 6 };
    -> width_half=5, height=6, 1バイト/行 x 6行 = 6バイト/グリフ, 256文字
  upstream/98fmplayer/fmdsp/font_fmdsp_small.c:26-28
    const struct fmdsp_font font_fmdsp_medium = { fmdsp_font_medium_get, 0, 6, 8 };
    -> width_half=6, height=8, 1バイト/行 x 8行 = 8バイト/グリフ, 256文字

このサイズ(256*6=1536, 256*8=2048)と一致しなければ異常終了する。
"""
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SRC_SMALL = REPO_ROOT / "upstream/98fmplayer/fmdsp/font_fmdsp_small_data.h"
SRC_MEDIUM = REPO_ROOT / "upstream/98fmplayer/fmdsp/font_fmdsp_medium_data.h"
DST = REPO_ROOT / "pmdweb/html/fmdsp/font_small.js"

SMALL_W, SMALL_H = 5, 6
MEDIUM_W, MEDIUM_H = 6, 8
SMALL_EXPECTED = 256 * SMALL_H
MEDIUM_EXPECTED = 256 * MEDIUM_H


def parse_array(path: Path, expected_size: int, label: str) -> bytes:
    text = path.read_text(encoding="ascii")
    match = re.search(r"\{(.*)\}", text, re.DOTALL)
    if not match:
        print(f"error: could not locate array body in {path}", file=sys.stderr)
        sys.exit(1)
    body = match.group(1)
    values = [int(tok, 16) for tok in re.findall(r"0x[0-9a-fA-F]+", body)]
    data = bytes(values)
    if len(data) != expected_size:
        print(
            f"error: {label}: parsed {len(data)} bytes, expected {expected_size} "
            f"(256 glyphs)",
            file=sys.stderr,
        )
        sys.exit(1)
    return data


def to_js_array(data: bytes) -> str:
    hexvals = ",".join(f"0x{b:02x}" for b in data)
    return hexvals


def main() -> int:
    small = parse_array(SRC_SMALL, SMALL_EXPECTED, "font_fmdsp_small")
    medium = parse_array(SRC_MEDIUM, MEDIUM_EXPECTED, "font_fmdsp_medium")

    DST.parent.mkdir(parents=True, exist_ok=True)
    js = f"""// 自動生成: tools/gen_font_small.py で生成。手編集しないこと。
// 出典: upstream/98fmplayer/fmdsp/font_fmdsp_small_data.h (fontdat[])
//       upstream/98fmplayer/fmdsp/font_fmdsp_medium_data.h (fmdsp_medium_dat[])
// レイアウト: 1グリフ=height バイト、1バイト/行 (1<<(7-x) がMSB=左端、
// font_fmdsp_small.c:14-16, 26-28 および fmdsp-pacc.c:212 の bit 展開式より)。

export const FONT_SMALL = {{
  w: {SMALL_W},
  h: {SMALL_H},
  bytesPerGlyph: {SMALL_H},
  data: new Uint8Array([{to_js_array(small)}]),
}};

export const FONT_MEDIUM = {{
  w: {MEDIUM_W},
  h: {MEDIUM_H},
  bytesPerGlyph: {MEDIUM_H},
  data: new Uint8Array([{to_js_array(medium)}]),
}};
"""
    DST.write_text(js, encoding="utf-8")
    print(f"wrote {DST} (small {len(small)} bytes, medium {len(medium)} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
