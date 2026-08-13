// CP932(SJIS)関連の変換ヘルパ。
// 出典: upstream/98fmplayer/fmdsp/font.h:11-35
// 3関数を出典どおり移植する(でっちあげ・簡略化を避けるため、ロジックは
// C版と1対1対応させ、file:lineをコメントで明示する)。

// upstream/98fmplayer/fmdsp/font.h:11-15
//   static inline bool sjis_is_mb_start(uint8_t c) {
//     if (0x81 <= c && c <= 0x9f) return true;
//     if (0xe0 <= c && c <= 0xef) return true;
//     return false;
//   }
export function sjisIsMbStart(c) {
  if (0x81 <= c && c <= 0x9f) return true;
  if (0xe0 <= c && c <= 0xef) return true;
  return false;
}

// upstream/98fmplayer/fmdsp/font.h:17-20
//   static inline bool jis_is_halfwidth(uint16_t jis) {
//     uint8_t row = jis >> 8;
//     return row == 0x29 || row == 0x2a;
//   }
export function jisIsHalfwidth(jis) {
  const row = (jis >> 8) & 0xff;
  return row === 0x29 || row === 0x2a;
}

// upstream/98fmplayer/fmdsp/font.h:22-35
//   static inline uint16_t sjis2jis(uint8_t sjis_1st, uint8_t sjis_2nd) {
//     uint16_t jis;
//     if (sjis_1st >= 0xe0) sjis_1st -= 0x40;
//     sjis_1st -= 0x81;
//     jis = sjis_1st << 9;
//     if (sjis_2nd >= 0x80) sjis_2nd--;
//     if (sjis_2nd >= 0x9e) {
//       jis |= 0x100 | (sjis_2nd - 0x9e);
//     } else {
//       jis |= (sjis_2nd - 0x40);
//     }
//     jis += 0x2121;
//     return jis;
//   }
//
// uint8_t変数(sjis_1st, sjis_2nd)への再代入(-=/--)はC側もuint8_tとして
// 保存されるためラップする(mod 256) -> `& 0xff` で再現する。
//
// 一方 `jis |= (sjis_2nd - 0x40)` のように「uint8_t変数を式の中で使うだけで
// 再代入しない」場合、Cの整数昇格規則により sjis_2nd は一旦 int に昇格されて
// から減算されるため、sjis_2nd=0 のとき `0 - 0x40` は uint8_t の 0xc0 には
// ラップせず、符号付き int の -64 のままビット演算に渡る(実機C出力で確認済み:
// 0x81,0x00 は 0x20e1 になり、`& 0xff` で 0xc0 に丸めると 0x21e1 という誤値に
// なることを検証スクリプトの故障検出で確認した)。
// JSの `|`/`&` 演算子はオペランドをToInt32(符号拡張含む)してから演算するため、
// ここを `& 0xff` でマスクせず素の負数のまま `|` に渡せば C と同じ結果になる。
export function sjis2jis(sjis1st, sjis2nd) {
  let s1 = sjis1st & 0xff;
  if (s1 >= 0xe0) s1 = (s1 - 0x40) & 0xff; // sjis_1st -= 0x40; (uint8_t再代入)
  s1 = (s1 - 0x81) & 0xff; // sjis_1st -= 0x81; (uint8_t再代入)
  let jis = (s1 << 9) & 0xffff; // jis = sjis_1st << 9; (uint16_t格納)
  let s2 = sjis2nd & 0xff;
  if (s2 >= 0x80) s2 = (s2 - 1) & 0xff; // sjis_2nd--; (uint8_t再代入)
  if (s2 >= 0x9e) {
    // jis |= 0x100 | (sjis_2nd - 0x9e); (s2>=0x9eなのでこの減算は非負)
    jis = (jis | (0x100 | (s2 - 0x9e))) & 0xffff;
  } else {
    // jis |= (sjis_2nd - 0x40); 再代入ではないので int 昇格のまま(負値あり得る)。
    jis = (jis | (s2 - 0x40)) & 0xffff;
  }
  jis = (jis + 0x2121) & 0xffff; // jis += 0x2121; (uint16_t格納)
  return jis;
}
