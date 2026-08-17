// 自動生成ファイル。編集しないこと。
// 再生成: python3 tools/gen_rhythm_rom.py
// html/rhythm/2608_*.WAV (自作リズム波形。実機ROM不使用) から
// YM2608 リズムROM互換の ADPCM-A データを合成したもの。
#ifndef PMDWEB_RHYTHM_ROM_H_INCLUDED
#define PMDWEB_RHYTHM_ROM_H_INCLUDED

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define RHYTHM_ROM_SIZE 8192

extern const uint8_t rhythm_rom[RHYTHM_ROM_SIZE];

#ifdef __cplusplus
}
#endif

#endif // PMDWEB_RHYTHM_ROM_H_INCLUDED
