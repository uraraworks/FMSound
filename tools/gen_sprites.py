#!/usr/bin/env python3
"""upstream/98fmplayer/fmdsp/fmdsp_sprites.h からパート行/右半分(ORIGINAL)の
描画に必要なパレットインデックス方式のビットマップ配列を抽出し、
pmdweb/html/fmdsp/sprites.js として ES module で出力する。

抽出対象(すべて file:line の出典あり、fmdsp_sprites.h):
  s_num[11]      : 数字グリフ 0-9,10=マスク時のダミー (NUM_W x NUM_H)
  s_key_bg       : 鍵盤地板1オクターブぶん (KEY_W x KEY_H)
  s_key_left     : 鍵盤左端の飾り (KEY_LEFT_W x KEY_H)
  s_key_right    : 鍵盤右端の飾り (KEY_RIGHT_W x KEY_H)
  s_key_mask     : 鍵盤ハイライト用テンプレート、値1..12がキー番号+1に対応
                   (fmdsp-pacc.c:941-947 の `buf[...] = (s_key_mask[j] == (i+1))` を
                   踏まえ、抽出時に 0..11 の12フレームへ展開する)
  s_bar_l        : ゲージバー左端の飾り (BAR_L_W x BAR_H)
  s_bar          : ゲージバー1セグメント (BAR_W x BAR_H)
  s_dt_sign[3]   : DT符号アイコン(0=符号なし,1=マイナス,2=プラス) (DT_SIGN_W x DT_SIGN_H)

右半分(FMDSP_RIGHT_MODE_DEFAULT、ORIGINAL相当)向けに追加した抽出対象:
  s_logo_fm/ds/p : ロゴ("FM"/"DS"/"P"、fmdsp_sprites.h:666-709)
  s_text         : タイトル文字列("MUSIC FILE SELECTOR & STATUS DISPLAY"の下線飾り、
                   fmdsp_sprites.h:745-777, TOP_TEXT_W x TOP_TEXT_H)
  s_ver          : バージョン数字の飾り罫(fmdsp_sprites.h:779-785)
  s_curl_left/right : DRIVERラベル脇の巻物飾り(786-813)
  s_play/stop/pause/fade/ff/rew : 状態アイコン(815-873)
  s_floppy       : フロッピーアイコン(875-890)
  s_panpot[6]    : パン位置インジケータ 5方向+OFF(892-995)
  s_circle       : 回転インジケータのテンプレート(711-743)。
                   fmdsp-pacc.c:963-977 の生成ロジック(i=0..8の9フレーム、
                   `c = (s==(i+1)) ? 2 : (s?3:0)`)をそのまま踏襲して9フレームへ展開する。
  s_num_colon[2] : コロン(点滅用、消灯/点灯、fmdsp_sprites.h:490-517)
  s_num_bar      : マスク(ミュート)時のダミー数字下線(519-531)
"""
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SRC = REPO_ROOT / "upstream/98fmplayer/fmdsp/fmdsp_sprites.h"
DST = REPO_ROOT / "pmdweb/html/fmdsp/sprites.js"

# fmdsp_sprites.h:1-190 の定数群を手で写す(この抽出処理に必要な分のみ)。
NUM_W, NUM_H = 8, 11
KEY_W, KEY_H = 35, 17
KEY_LEFT_W = 6
KEY_RIGHT_W = 11
BAR_L_W, BAR_H = 14, 4
BAR_W = 2
DT_SIGN_W, DT_SIGN_H = 3, 3

# 右半分(ORIGINAL)向けのサイズ定数。すべて fmdsp_sprites.h:96-190 のenumから転記。
LOGO_FM_W, LOGO_DS_W, LOGO_P_W, LOGO_H = 31, 32, 15, 12
# fmdsp-pacc.c:23 (pacc内ローカル再定義): LOGO_W = LOGO_FM_W+2+LOGO_DS_W+2+LOGO_P_W
LOGO_W = LOGO_FM_W + 2 + LOGO_DS_W + 2 + LOGO_P_W
TOP_TEXT_W, TOP_TEXT_H = 231, 5
VER_W, VER_H = 13, 5
CURL_W, CURL_H = 11, 11
PLAY_W, PLAY_H = 30, 7
STOP_W, STOP_H = 31, 7
PAUSE_W, PAUSE_H = 37, 7
FADE_W, FADE_H = 31, 7
FF_W, FF_H = 20, 7
REW_W, REW_H = 26, 7
FLOPPY_W, FLOPPY_H = 74, 7
PANPOT_W, PANPOT_H = 15, 15
CIRCLE_W, CIRCLE_H = 31, 31


def extract_array(text: str, name: str, dims_desc: str) -> list[int]:
    """`static [const] uint8_t <name>[...] = { ... };` を1つ抽出しflat intリストで返す。"""
    pattern = rf"static (?:const )?uint8_t {re.escape(name)}\[[^=]*\]\s*=\s*\{{(.*?)\n\}};"
    match = re.search(pattern, text, re.DOTALL)
    if not match:
        raise SystemExit(f"error: could not locate {name} ({dims_desc}) in {SRC}")
    body = match.group(1)
    return [int(tok) for tok in re.findall(r"\d+", body)]


def split_frames(flat: list[int], frame_size: int, count: int) -> list[list[int]]:
    if len(flat) != frame_size * count:
        raise SystemExit(
            f"error: expected {frame_size * count} values, got {len(flat)}"
        )
    return [flat[i * frame_size:(i + 1) * frame_size] for i in range(count)]


def js_array(values: list[int]) -> str:
    return "[" + ",".join(str(v) for v in values) + "]"


def main() -> int:
    text = SRC.read_text(encoding="utf-8")

    s_num_flat = extract_array(text, "s_num", "11 x NUM_W*NUM_H")
    s_num = split_frames(s_num_flat, NUM_W * NUM_H, 11)

    s_key_bg = extract_array(text, "s_key_bg", "KEY_W*KEY_H")
    if len(s_key_bg) != KEY_W * KEY_H:
        raise SystemExit("error: s_key_bg size mismatch")

    s_key_left = extract_array(text, "s_key_left", "KEY_LEFT_W*KEY_H")
    if len(s_key_left) != KEY_LEFT_W * KEY_H:
        raise SystemExit("error: s_key_left size mismatch")

    s_key_right = extract_array(text, "s_key_right", "KEY_RIGHT_W*KEY_H")
    if len(s_key_right) != KEY_RIGHT_W * KEY_H:
        raise SystemExit("error: s_key_right size mismatch")

    s_key_mask_template = extract_array(text, "s_key_mask", "KEY_W*KEY_H")
    if len(s_key_mask_template) != KEY_W * KEY_H:
        raise SystemExit("error: s_key_mask size mismatch")
    # fmdsp-pacc.c:941-947: 12フレーム、frame i は (template[j] == i+1) の0/1マスク。
    key_mask_frames = []
    for i in range(12):
        key_mask_frames.append([1 if v == (i + 1) else 0 for v in s_key_mask_template])

    s_bar_l = extract_array(text, "s_bar_l", "BAR_L_W*BAR_H")
    if len(s_bar_l) != BAR_L_W * BAR_H:
        raise SystemExit("error: s_bar_l size mismatch")

    s_bar = extract_array(text, "s_bar", "BAR_W*BAR_H")
    if len(s_bar) != BAR_W * BAR_H:
        raise SystemExit("error: s_bar size mismatch")

    s_dt_sign_flat = extract_array(text, "s_dt_sign", "3 x DT_SIGN_W*DT_SIGN_H")
    s_dt_sign = split_frames(s_dt_sign_flat, DT_SIGN_W * DT_SIGN_H, 3)

    # --- 右半分(ORIGINAL)向け追加抽出 ---
    s_logo_fm = extract_array(text, "s_logo_fm", "LOGO_FM_W*LOGO_H")
    if len(s_logo_fm) != LOGO_FM_W * LOGO_H:
        raise SystemExit("error: s_logo_fm size mismatch")
    s_logo_ds = extract_array(text, "s_logo_ds", "LOGO_DS_W*LOGO_H")
    if len(s_logo_ds) != LOGO_DS_W * LOGO_H:
        raise SystemExit("error: s_logo_ds size mismatch")
    s_logo_p = extract_array(text, "s_logo_p", "LOGO_P_W*LOGO_H")
    if len(s_logo_p) != LOGO_P_W * LOGO_H:
        raise SystemExit("error: s_logo_p size mismatch")

    s_text = extract_array(text, "s_text", "TOP_TEXT_W*TOP_TEXT_H")
    if len(s_text) != TOP_TEXT_W * TOP_TEXT_H:
        raise SystemExit("error: s_text size mismatch")

    s_ver = extract_array(text, "s_ver", "VER_W*VER_H")
    if len(s_ver) != VER_W * VER_H:
        raise SystemExit("error: s_ver size mismatch")

    s_curl_left = extract_array(text, "s_curl_left", "CURL_W*CURL_H")
    if len(s_curl_left) != CURL_W * CURL_H:
        raise SystemExit("error: s_curl_left size mismatch")
    s_curl_right = extract_array(text, "s_curl_right", "CURL_W*CURL_H")
    if len(s_curl_right) != CURL_W * CURL_H:
        raise SystemExit("error: s_curl_right size mismatch")

    s_play = extract_array(text, "s_play", "PLAY_W*PLAY_H")
    if len(s_play) != PLAY_W * PLAY_H:
        raise SystemExit("error: s_play size mismatch")
    s_stop = extract_array(text, "s_stop", "STOP_W*STOP_H")
    if len(s_stop) != STOP_W * STOP_H:
        raise SystemExit("error: s_stop size mismatch")
    s_pause = extract_array(text, "s_pause", "PAUSE_W*PAUSE_H")
    if len(s_pause) != PAUSE_W * PAUSE_H:
        raise SystemExit("error: s_pause size mismatch")
    s_fade = extract_array(text, "s_fade", "FADE_W*FADE_H")
    if len(s_fade) != FADE_W * FADE_H:
        raise SystemExit("error: s_fade size mismatch")
    s_ff = extract_array(text, "s_ff", "FF_W*FF_H")
    if len(s_ff) != FF_W * FF_H:
        raise SystemExit("error: s_ff size mismatch")
    s_rew = extract_array(text, "s_rew", "REW_W*REW_H")
    if len(s_rew) != REW_W * REW_H:
        raise SystemExit("error: s_rew size mismatch")
    s_floppy = extract_array(text, "s_floppy", "FLOPPY_W*FLOPPY_H")
    if len(s_floppy) != FLOPPY_W * FLOPPY_H:
        raise SystemExit("error: s_floppy size mismatch")

    s_panpot_flat = extract_array(text, "s_panpot", "6 x PANPOT_W*PANPOT_H")
    s_panpot = split_frames(s_panpot_flat, PANPOT_W * PANPOT_H, 6)

    # fmdsp-pacc.c:963-977 (tex_circle生成ロジック)をそのまま再現。
    # s_circle[y*W+x] の値 s に対し、9フレーム(i=0..8)の各ピクセルは:
    #   s == (i+1) なら 2 (点灯=強調色)、s != 0 なら 3 (減光)、s == 0 なら 0 (透明)。
    # clock=0..7 が実際に光っている方向、clock=8(i=8)は s==9になる箇所が無いため
    # 全点灯ピクセルが減光色3になる = 一時停止中の消灯コマに相当。
    s_circle_template = extract_array(text, "s_circle", "CIRCLE_W*CIRCLE_H")
    if len(s_circle_template) != CIRCLE_W * CIRCLE_H:
        raise SystemExit("error: s_circle size mismatch")
    circle_frames = []
    for i in range(9):
        frame = []
        for s in s_circle_template:
            if s == 0:
                frame.append(0)
            elif s == (i + 1):
                frame.append(2)
            else:
                frame.append(3)
        circle_frames.append(frame)

    s_num_colon_flat = extract_array(text, "s_num_colon", "2 x NUM_W*NUM_H")
    s_num_colon = split_frames(s_num_colon_flat, NUM_W * NUM_H, 2)

    s_num_bar = extract_array(text, "s_num_bar", "NUM_W*NUM_H")
    if len(s_num_bar) != NUM_W * NUM_H:
        raise SystemExit("error: s_num_bar size mismatch")

    lines = []
    lines.append("// Generated by tools/gen_sprites.py from")
    lines.append("// upstream/98fmplayer/fmdsp/fmdsp_sprites.h.")
    lines.append("// Do not edit by hand; re-run the generator instead.")
    lines.append(f"export const NUM_W = {NUM_W};")
    lines.append(f"export const NUM_H = {NUM_H};")
    lines.append(f"export const KEY_W = {KEY_W};")
    lines.append(f"export const KEY_H = {KEY_H};")
    lines.append(f"export const KEY_LEFT_W = {KEY_LEFT_W};")
    lines.append(f"export const KEY_RIGHT_W = {KEY_RIGHT_W};")
    lines.append(f"export const BAR_L_W = {BAR_L_W};")
    lines.append(f"export const BAR_H = {BAR_H};")
    lines.append(f"export const BAR_W = {BAR_W};")
    lines.append(f"export const DT_SIGN_W = {DT_SIGN_W};")
    lines.append(f"export const DT_SIGN_H = {DT_SIGN_H};")
    lines.append(
        "// s_num[0..9] = 数字0-9, s_num[10] = マスク(ミュート)時のダミーグリフ。"
    )
    lines.append(
        "export const S_NUM = [" + ",".join(js_array(f) for f in s_num) + "];"
    )
    lines.append(f"export const S_KEY_BG = {js_array(s_key_bg)};")
    lines.append(f"export const S_KEY_LEFT = {js_array(s_key_left)};")
    lines.append(f"export const S_KEY_RIGHT = {js_array(s_key_right)};")
    lines.append(
        "// 12フレーム(半音0..11)。値1のピクセルがそのキー位置のハイライト形状。"
    )
    lines.append(
        "export const S_KEY_MASK = ["
        + ",".join(js_array(f) for f in key_mask_frames)
        + "];"
    )
    lines.append(f"export const S_BAR_L = {js_array(s_bar_l)};")
    lines.append(f"export const S_BAR = {js_array(s_bar)};")
    lines.append(
        "// s_dt_sign[0] = 符号なし, [1] = マイナス, [2] = プラス"
        " (fmdsp-pacc.c update_track_without_key: sign = !detune?0:(detune<0?1:2))"
    )
    lines.append(
        "export const S_DT_SIGN = ["
        + ",".join(js_array(f) for f in s_dt_sign)
        + "];"
    )

    # --- 右半分(ORIGINAL)向け追加エクスポート ---
    lines.append(f"export const LOGO_FM_W = {LOGO_FM_W};")
    lines.append(f"export const LOGO_DS_W = {LOGO_DS_W};")
    lines.append(f"export const LOGO_P_W = {LOGO_P_W};")
    lines.append(f"export const LOGO_H = {LOGO_H};")
    lines.append(f"export const LOGO_W = {LOGO_W};")
    lines.append(f"export const TOP_TEXT_W = {TOP_TEXT_W};")
    lines.append(f"export const TOP_TEXT_H = {TOP_TEXT_H};")
    lines.append(f"export const VER_W = {VER_W};")
    lines.append(f"export const VER_H = {VER_H};")
    lines.append(f"export const CURL_W = {CURL_W};")
    lines.append(f"export const CURL_H = {CURL_H};")
    lines.append(f"export const PLAY_W = {PLAY_W};")
    lines.append(f"export const PLAY_H = {PLAY_H};")
    lines.append(f"export const STOP_W = {STOP_W};")
    lines.append(f"export const STOP_H = {STOP_H};")
    lines.append(f"export const PAUSE_W = {PAUSE_W};")
    lines.append(f"export const PAUSE_H = {PAUSE_H};")
    lines.append(f"export const FADE_W = {FADE_W};")
    lines.append(f"export const FADE_H = {FADE_H};")
    lines.append(f"export const FF_W = {FF_W};")
    lines.append(f"export const FF_H = {FF_H};")
    lines.append(f"export const REW_W = {REW_W};")
    lines.append(f"export const REW_H = {REW_H};")
    lines.append(f"export const FLOPPY_W = {FLOPPY_W};")
    lines.append(f"export const FLOPPY_H = {FLOPPY_H};")
    lines.append(f"export const PANPOT_W = {PANPOT_W};")
    lines.append(f"export const PANPOT_H = {PANPOT_H};")
    lines.append(f"export const CIRCLE_W = {CIRCLE_W};")
    lines.append(f"export const CIRCLE_H = {CIRCLE_H};")

    lines.append(
        "// ロゴ3枚(FM/DS/P)を横に並べたもの。x方向オフセットは"
        " 0, LOGO_FM_W+2, LOGO_FM_W+2+LOGO_DS_W+2 (fmdsp-pacc.c:952-961)。"
    )
    lines.append(f"export const S_LOGO_FM = {js_array(s_logo_fm)};")
    lines.append(f"export const S_LOGO_DS = {js_array(s_logo_ds)};")
    lines.append(f"export const S_LOGO_P = {js_array(s_logo_p)};")
    lines.append(f"export const S_TEXT = {js_array(s_text)};")
    lines.append(f"export const S_VER = {js_array(s_ver)};")
    lines.append(f"export const S_CURL_LEFT = {js_array(s_curl_left)};")
    lines.append(f"export const S_CURL_RIGHT = {js_array(s_curl_right)};")
    lines.append(
        "// PLAY/STOP/PAUSEはpacc_mode_colorで描かれ、アクティブ時2/非アクティブ時3"
        " (fmdsp-pacc.c:2113-2118)。スプライト自体は1bitマスクとして扱うこと。"
    )
    lines.append(f"export const S_PLAY = {js_array(s_play)};")
    lines.append(f"export const S_STOP = {js_array(s_stop)};")
    lines.append(f"export const S_PAUSE = {js_array(s_pause)};")
    lines.append(
        "// FADE/FF/REW/FLOPPYはpacc_mode_copyで常時同じ見た目のまま描画される"
        " (fmdsp-pacc.c:2119-2130、状態に応じた色分岐なし)。"
    )
    lines.append(f"export const S_FADE = {js_array(s_fade)};")
    lines.append(f"export const S_FF = {js_array(s_ff)};")
    lines.append(f"export const S_REW = {js_array(s_rew)};")
    lines.append(f"export const S_FLOPPY = {js_array(s_floppy)};")
    lines.append(
        "// s_panpot[0..4] = 5方向(fmdsp-pacc.c:1765-1769等)、"
        " 実際の割当(L/R/中央等)は呼び出し側で決める。[5]はOFF/中央相当。"
    )
    lines.append(
        "export const S_PANPOT = ["
        + ",".join(js_array(f) for f in s_panpot)
        + "];"
    )
    lines.append(
        "// 9フレーム(clock=0..7が8方向点灯、clock=8が一時停止中の全減光)。"
        " 生成ロジックの出典は fmdsp-pacc.c:963-977、詳細はモジュール先頭コメント参照。"
    )
    lines.append(
        "export const S_CIRCLE = ["
        + ",".join(js_array(f) for f in circle_frames)
        + "];"
    )
    lines.append(
        "// tex_num (fmdsp-pacc.c:814, NUM_H*14)の frame11=S_NUM_BAR,"
        " frame12-13=S_NUM_COLON[0..1] に相当する追加フレーム"
        " (fmdsp-pacc.c:879-880)。S_NUMの11フレームと合わせて使うと0..13の"
        " 14フレーム構成を再現できる。"
    )
    lines.append(
        "export const S_NUM_COLON = ["
        + ",".join(js_array(f) for f in s_num_colon)
        + "];"
    )
    lines.append(f"export const S_NUM_BAR = {js_array(s_num_bar)};")
    lines.append("")

    DST.parent.mkdir(parents=True, exist_ok=True)
    DST.write_text("\n".join(lines), encoding="utf-8")
    print(f"wrote {DST}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
