/* upstream/98fmplayer/libopna/opnadrum.c の実物(自作コードではない)を使って
 * 8KBのリズムROMバイナリを復号し、6音それぞれの復号済みint16 PCMを
 * ファイルへダンプする検証用ハーネス。
 *
 * ビルド:
 *   cc -std=c11 -O2 -I<repo>/upstream/98fmplayer/libopna \
 *      -o rhythm_rom_decode_harness rhythm_rom_decode_harness.c \
 *      <repo>/upstream/98fmplayer/libopna/opnadrum.c
 *
 * 実行:
 *   rhythm_rom_decode_harness <rom.bin> <out_dir>
 * 出力: <out_dir>/{BD,SD,TOP,HH,TOM,RIM}.i16 (リトルエンディアン int16 raw)
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "opnadrum.h"

static const char *NAMES[6] = {"BD", "SD", "TOP", "HH", "TOM", "RIM"};

int main(int argc, char **argv) {
  if (argc != 3) {
    fprintf(stderr, "usage: %s <rom.bin> <out_dir>\n", argv[0]);
    return 2;
  }
  const char *rom_path = argv[1];
  const char *out_dir = argv[2];

  FILE *f = fopen(rom_path, "rb");
  if (!f) {
    fprintf(stderr, "cannot open %s\n", rom_path);
    return 1;
  }
  static uint8_t rom[OPNA_ROM_SIZE];
  size_t n = fread(rom, 1, sizeof(rom), f);
  fclose(f);
  if (n != sizeof(rom)) {
    fprintf(stderr, "%s: expected %d bytes, got %zu\n", rom_path, OPNA_ROM_SIZE, n);
    return 1;
  }

  static struct opna_drum drum;
  opna_drum_reset(&drum);
  opna_drum_set_rom(&drum, rom);

  for (int d = 0; d < 6; d++) {
    char path[1024];
    snprintf(path, sizeof(path), "%s/%s.i16", out_dir, NAMES[d]);
    FILE *out = fopen(path, "wb");
    if (!out) {
      fprintf(stderr, "cannot open %s for write\n", path);
      return 1;
    }
    unsigned len = drum.drums[d].len;
    fwrite(drum.drums[d].data, sizeof(int16_t), len, out);
    fclose(out);
    fprintf(stderr, "%s: %u samples\n", NAMES[d], len);
  }
  return 0;
}
