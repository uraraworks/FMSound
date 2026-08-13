/* sjis2jis() の実測用。upstream/98fmplayer/fmdsp/font.h を直接includeし、
 * C側の実装そのものを相手役にする(自作JS実装を自作JS実装で検証しても
 * 誤解は検出できないため)。
 *
 * sjis_is_mb_start()がtrueを返す1バイト目(0x81-0x9f, 0xe0-0xef)の全域と、
 * 2バイト目0x00-0xffの全域を総当たりし、"1st 2nd jis"を16進で1行ずつ出力する。
 * JS側(cp932.js)で同じ全域を計算し、比較スクリプト(compare_sjis2jis.mjs)が
 * 全件一致を確認する。
 *
 * ビルド: cc -std=c11 -o /tmp/verify_sjis2jis tools/verify_sjis2jis.c
 */
#include <stdio.h>
#include "../upstream/98fmplayer/fmdsp/font.h"

int main(void) {
  for (int a = 0; a < 256; a++) {
    if (!sjis_is_mb_start((uint8_t)a)) continue;
    for (int b = 0; b < 256; b++) {
      uint16_t jis = sjis2jis((uint8_t)a, (uint8_t)b);
      printf("%02x %02x %04x\n", a, b, jis);
    }
  }
  return 0;
}
