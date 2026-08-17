#!/usr/bin/env python3
"""自作リズム波形(html/rhythm/2608_*.WAV)から YM2608 リズムROM互換の
8KB ADPCM-A バイナリを生成する。実機ROMは一切使わない。

再生成コマンド: python3 tools/gen_rhythm_rom.py

## 仕様の根拠
- 領域アドレス/サイズ・division係数(div)は upstream/98fmplayer/libopna/opnadrum.h
  の OPNA_ROM_*_START / OPNA_ROM_SIZE と、opnadrum.c opna_drum_set_rom() 内の
  part[6] テーブル(BD,SD,TOP,HH div=3 / TOM,RIM div=6)をそのまま使う。
- ADPCM-A の復号アルゴリズム(steps[49] / step_inc[8] / 12bit wrap する
  差分積分器)は opnadrum.c の opna_drum_set_rom() を読み取り、その逆写像
  (target に最も近い出力を作る nibble を全16通りから貪欲選択する適応的
  ADPCM エンコーダ)として実装した。テーブル値は同ファイルからコピーしており
  推測していない。
- ミックスレート(1ニブル=1出力サンプルの時間刻み)は opna.c の
  opna_mix_oscillo() が opna_drum_mix() を opna_fm_mix()/opna_ssg_mix_55466()
  と同じバッファ・同じ samples 数で呼んでいること、および opnassg.h の
  コメント「samplerate: 7987200/144 Hz (55466.66..) Hz」から、OPNAの
  マスターmixレート = 7987200/144 Hz と特定した(推測ではなく実装根拠あり)。
  各リズム音の実効サンプルレートはこれを part[].div で割った値になる
  (BD/SD/TOP/HH: 約18488.9Hz, TOM/RIM: 約9244.4Hz)。
  この値で各WAVの長さをROM領域サイズに換算すると、実測した詰め幅
  (BD 149ms→48ms 等、タスク指示文の実測値)とほぼ一致することで裏取り済み。
"""
import struct
import wave
from pathlib import Path

import numpy as np

REPO_ROOT = Path(__file__).resolve().parent.parent
WAV_DIR = REPO_ROOT / "html" / "rhythm"
OUT_C = REPO_ROOT / "pmdweb" / "src" / "rhythm_rom.c"
OUT_H = REPO_ROOT / "pmdweb" / "src" / "rhythm_rom.h"
# 生バイナリ(検証用)はリポジトリ外のscratchpadへ
SCRATCH_DIR = Path(
    "/private/tmp/claude-501/-Users-haruurara-MyProject--emulator-PC98/"
    "efcc7436-b615-4158-b6b9-b184dca6519f/scratchpad"
)
OUT_BIN = SCRATCH_DIR / "rhythm_rom.bin"
OUT_TARGETS_DIR = SCRATCH_DIR / "rhythm_rom_targets"

# --- opnadrum.h の定数(コピー、推測なし) ---
ROM_SIZE = 0x2000
STARTS = {
    "BD": 0x0000,
    "SD": 0x01c0,
    "TOP": 0x0440,
    "HH": 0x1b80,
    "TOM": 0x1d00,
    "RIM": 0x1f80,
}
ORDER = ["BD", "SD", "TOP", "HH", "TOM", "RIM"]
DIV = {"BD": 3, "SD": 3, "TOP": 3, "HH": 3, "TOM": 6, "RIM": 6}

# opna.c: opna_mix_oscillo() が opna_drum_mix を opna_fm_mix/opna_ssg_mix_55466 と
# 同じ samples 数で同一バッファに対して呼ぶ。opnassg.h のコメントより
# OPNAマスターmixレート = 7987200/144 Hz (根拠あり、推測ではない)
BASE_RATE = 7987200 / 144  # = 55466.666... Hz

# opnadrum.c のテーブルそのままコピー(推測禁止のため転記のみ)
STEPS = [
    16, 17, 19, 21, 23, 25, 28,
    31, 34, 37, 41, 45, 50, 55,
    60, 66, 73, 80, 88, 97, 107,
    118, 130, 143, 157, 173, 190, 209,
    230, 253, 279, 307, 337, 371, 408,
    449, 494, 544, 598, 658, 724, 796,
    876, 963, 1060, 1166, 1282, 1411, 1552,
]
STEP_INC = [-1, -1, -1, -1, 2, 5, 7, 9]

# フェードアウト長。トリム/パディング境界でのクリックノイズ回避が目的。
# 最短領域(RIM: 約28ms)に対しても波形の大半を残せる程度に短く、かつ
# 人の耳で不連続音が聞こえない程度(数ms〜)に十分な長さとして4msを選定
# (このリポジトリに既存の基準値は無く、独自に決めた値)。
FADE_MS = 4.0


def region_bytes():
    """各パートのROMバイト範囲 {name: (start, end_exclusive)} を返す。
    ここでの end_exclusive は「ROM上でこのパートに割り当てられたバイト空間」
    の終端(次パートの start、またはRIMのみROM_SIZE)であり、opnadrum.c の
    part[].end とは別物であることに注意。

    重要: opna_drum_set_rom() の停止条件は
      if ((addr>>1) == part[p].end) break;
    であり、part[p].end = 次パートの start - 1 (最終パートのみ ROM_SIZE-1)。
    この判定はバイト境界 part[p].end の「直前」で止まるため、
    part[p].end に対応するバイト(= このパートに割り当てられた範囲の
    最終バイト)は一度もrom[]から読まれない。つまり実際にデコードされる
    バイト数は (end_exclusive - start - 1) であり、素朴に
    (end_exclusive - start) だと考えると1バイト(=2ニブル)分ずれる。
    これはハーネス(tools/rhythm_rom_decode_harness.c)で drum->drums[d].len
    を実測し、当初の想定(nbytes*2*div)より短いことを確認して発覚した
    (BD: 2688想定 -> 実測2682。原文推測ではなく実測で確定)。
    """
    out = {}
    for i, name in enumerate(ORDER):
        start = STARTS[name]
        end_excl = STARTS[ORDER[i + 1]] if i + 1 < len(ORDER) else ROM_SIZE
        out[name] = (start, end_excl)
    return out


def load_wav_mono16(path: Path):
    with wave.open(str(path), "rb") as w:
        assert w.getnchannels() == 1, f"{path}: expected mono, got {w.getnchannels()}ch"
        assert w.getsampwidth() == 2, f"{path}: expected 16bit, got {w.getsampwidth()*8}bit"
        rate = w.getframerate()
        n = w.getnframes()
        raw = w.readframes(n)
    samples = np.frombuffer(raw, dtype="<i2").astype(np.float64)
    return samples, rate


def resample_linear(samples: np.ndarray, src_rate: float, dst_rate: float) -> np.ndarray:
    """線形補間によるリサンプル。scipy等の外部依存を避けるためnumpy.interpで実装。"""
    n_src = len(samples)
    duration = n_src / src_rate
    n_dst = int(round(duration * dst_rate))
    if n_dst <= 0:
        return np.zeros(0, dtype=np.float64)
    x_src = np.arange(n_src) / src_rate
    x_dst = np.arange(n_dst) / dst_rate
    x_dst = np.clip(x_dst, x_src[0] if n_src else 0, x_src[-1] if n_src else 0)
    return np.interp(x_dst, x_src, samples)


def build_target(name: str, nibble_count: int) -> np.ndarray:
    """このパートの1ニブル=1サンプルとなる、int16相当のターゲット波形
    (長さ=nibble_count)を作る。実波形を実効レートへリサンプルし、
    領域より長ければ末尾をトリム+フェードアウト、短ければ末尾を
    フェードアウトしたのち無音(0)でパディングする。"""
    wav_path = WAV_DIR / f"2608_{name}.WAV"
    samples, src_rate = load_wav_mono16(wav_path)
    eff_rate = BASE_RATE / DIV[name]
    resampled = resample_linear(samples, src_rate, eff_rate)

    real_len = min(len(resampled), nibble_count)
    target = np.zeros(nibble_count, dtype=np.float64)
    target[:real_len] = resampled[:real_len]

    fade_samples = min(real_len, max(1, int(round(FADE_MS / 1000.0 * eff_rate))))
    if fade_samples > 0:
        window = np.linspace(1.0, 0.0, fade_samples, endpoint=True)
        target[real_len - fade_samples:real_len] *= window
    # real_len 以降(パディング域)はもともと0のまま

    orig_ms = len(samples) / src_rate * 1000.0
    rom_ms = nibble_count / eff_rate * 1000.0
    trimmed = len(resampled) > nibble_count
    print(
        f"  {name}: {orig_ms:7.1f}ms -> ROM {rom_ms:7.1f}ms "
        f"(eff_rate={eff_rate:8.2f}Hz, nibbles={nibble_count}, "
        f"{'trimmed' if trimmed else 'padded' if len(resampled) < nibble_count else 'exact'}, "
        f"fade={fade_samples}samples)"
    )
    return target


def encode_adpcm_a(target: np.ndarray) -> list:
    """opnadrum.c の復号アルゴリズムの逆写像。各ステップで16通りのnibbleが
    生成しうる出力を全探索し、targetに最も近いものを貪欲選択する適応的
    ADPCMエンコーダ。状態遷移(acc の12bit wrap・stepクランプ)は復号側と
    完全に一致させてある。"""
    nibbles = []
    step = 0
    acc = 0  # 復号側と同じく無制限精度で加算し続ける(wrapは出力抽出時のみ)
    for t in target:
        best_nibble = 0
        best_err = None
        best_new_acc = acc
        best_new_step = step
        for data in range(16):
            acc_diff = (((data & 7) << 1 | 1) * STEPS[step]) >> 3
            if data & 8:
                acc_diff = -acc_diff
            new_acc = acc + acc_diff
            out = new_acc & 0xFFF
            if out >= 0x800:
                out -= 0x1000
            out16 = out << 4
            err = abs(out16 - t)
            if best_err is None or err < best_err:
                best_err = err
                best_nibble = data
                best_new_acc = new_acc
                new_step = step + STEP_INC[data & 7]
                if new_step < 0:
                    new_step = 0
                if new_step > 48:
                    new_step = 48
                best_new_step = new_step
        nibbles.append(best_nibble)
        acc = best_new_acc
        step = best_new_step
    return nibbles


def pack_nibbles(nibbles: list) -> bytes:
    assert len(nibbles) % 2 == 0
    out = bytearray(len(nibbles) // 2)
    for i in range(0, len(nibbles), 2):
        out[i // 2] = (nibbles[i] << 4) | nibbles[i + 1]
    return bytes(out)


def main():
    regions = region_bytes()
    rom = bytearray(ROM_SIZE)
    OUT_TARGETS_DIR.mkdir(parents=True, exist_ok=True)

    print("生成中(元波形 -> ROM内 長さ):")
    for name in ORDER:
        start, end_excl = regions[name]
        nbytes = end_excl - start  # このパートに割り当てられたバイト空間の幅
        # 実際にデコードされるのは最終1バイトを除いた (nbytes-1) バイトぶんのみ
        # (region_bytes() のdocstring参照。opnadrum.c の停止条件による)
        decoded_bytes = nbytes - 1
        nibble_count = decoded_bytes * 2
        div = DIV[name]

        target = build_target(name, nibble_count)
        nibbles = encode_adpcm_a(target)
        packed = pack_nibbles(nibbles)
        assert len(packed) == decoded_bytes, (name, len(packed), decoded_bytes)
        rom[start:start + decoded_bytes] = packed
        # 最終1バイト(part[].end に対応する、デコーダが読まないバイト)は
        # 未使用のため0で埋める(意味を持たせない)。
        rom[start + decoded_bytes:end_excl] = b"\x00" * (nbytes - decoded_bytes)

        # 検証用: このパートが実際に狙った目標波形(int16)を書き出す
        target_i16 = np.clip(np.round(target), -32768, 32767).astype("<i2")
        (OUT_TARGETS_DIR / f"{name}.i16").write_bytes(target_i16.tobytes())

    assert len(rom) == ROM_SIZE

    SCRATCH_DIR.mkdir(parents=True, exist_ok=True)
    OUT_BIN.write_bytes(bytes(rom))
    print(f"\n生バイナリ: {OUT_BIN} ({len(rom)} bytes)")

    write_c_source(bytes(rom))
    print(f"Cソース: {OUT_C}")
    print(f"ヘッダ: {OUT_H}")


def write_c_source(rom: bytes):
    OUT_H.write_text(
        "// 自動生成ファイル。編集しないこと。\n"
        "// 再生成: python3 tools/gen_rhythm_rom.py\n"
        "// html/rhythm/2608_*.WAV (自作リズム波形。実機ROM不使用) から\n"
        "// YM2608 リズムROM互換の ADPCM-A データを合成したもの。\n"
        "#ifndef PMDWEB_RHYTHM_ROM_H_INCLUDED\n"
        "#define PMDWEB_RHYTHM_ROM_H_INCLUDED\n\n"
        "#include <stdint.h>\n\n"
        "#ifdef __cplusplus\n"
        'extern "C" {\n'
        "#endif\n\n"
        f"#define RHYTHM_ROM_SIZE {len(rom)}\n\n"
        "extern const uint8_t rhythm_rom[RHYTHM_ROM_SIZE];\n\n"
        "#ifdef __cplusplus\n"
        "}\n"
        "#endif\n\n"
        "#endif // PMDWEB_RHYTHM_ROM_H_INCLUDED\n",
        encoding="utf-8",
    )

    lines = []
    lines.append("// 自動生成ファイル。編集しないこと。")
    lines.append("// 再生成: python3 tools/gen_rhythm_rom.py")
    lines.append(
        "// html/rhythm/2608_*.WAV (自作リズム波形。実機ROM不使用) を"
        " opnadrum.c のADPCM-A復号アルゴリズムの逆写像でエンコードしたもの。"
    )
    lines.append('#include "rhythm_rom.h"\n')
    lines.append("const uint8_t rhythm_rom[RHYTHM_ROM_SIZE] = {")
    for i in range(0, len(rom), 16):
        chunk = rom[i:i + 16]
        hexs = ", ".join(f"0x{b:02x}" for b in chunk)
        lines.append(f"  {hexs},")
    lines.append("};")
    OUT_C.write_text("\n".join(lines) + "\n", encoding="utf-8")


if __name__ == "__main__":
    raise SystemExit(main())
