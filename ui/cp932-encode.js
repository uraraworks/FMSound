// 課題D: MMLソースをCP932(Shift_JIS)バイト列へエンコードする。
//
// ブラウザ標準のTextEncoderはUTF-8専用でCP932変換を持たない(TextDecoderは
// 'shift_jis'をデコードできるのに、エンコード側は無い)。かといって数千件規模の
// CP932変換テーブルを手で書き写す/どこかから丸写しするのは「でっちあげ」の危険が
// ある(誤記に気づけない)。
//
// ここでは0x00-0xFFの1バイト値・全2バイト先頭/後続バイトの組み合わせを、
// ブラウザ自身のTextDecoder('shift_jis')に総当たりで通して「バイト列→文字」の
// 対応表を実測し、それを逆引きすることでエンコード表を作る。値を推測・転記せず、
// 使用しているのと同じ実装(TextDecoder)から機械的に導出するので、デコードと
// エンコードが常に一致する(0x5Cが'\'か'¥'か、といった実装依存の揺れも自動的に
// 追従する)。

let cachedTable = null;

function buildTable() {
  if (cachedTable) return cachedTable;
  const decoder = new TextDecoder('shift_jis', { fatal: false });
  const map = new Map();

  // 1バイト領域(ASCII+半角カナ)。
  for (let b = 0; b <= 0xff; b++) {
    const s = decoder.decode(Uint8Array.of(b));
    if (s.length === 1 && s.charCodeAt(0) !== 0xfffd && !map.has(s)) {
      map.set(s, Uint8Array.of(b));
    }
  }

  // 2バイト領域(先頭バイトの範囲はCP932の一般的な定義に従う)。
  const leadRanges = [[0x81, 0x9f], [0xe0, 0xfc]];
  for (const [lo, hi] of leadRanges) {
    for (let b1 = lo; b1 <= hi; b1++) {
      for (let b2 = 0x40; b2 <= 0xfc; b2++) {
        if (b2 === 0x7f) continue; // DEL相当は2バイト目に来ない
        const s = decoder.decode(Uint8Array.of(b1, b2));
        if (s.length >= 1 && s.charCodeAt(0) !== 0xfffd && !map.has(s)) {
          map.set(s, Uint8Array.of(b1, b2));
        }
      }
    }
  }

  cachedTable = map;
  return cachedTable;
}

/** 中身がASCII(0x00-0x7E)だけならCP932/UTF-8のどちらでも同じバイト列になる。 */
export function isAsciiOnly(text) {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 0x7e) return false;
  }
  return true;
}

/**
 * @param {string} text
 * @returns {{ bytes: Uint8Array|null, unmappable: string[] }}
 *   変換できない文字が1つでもあれば bytes は null、unmappable にその文字(重複なし)を返す。
 */
export function encodeCp932(text) {
  const table = buildTable();
  const unmappableSet = new Set();
  const chunks = [];
  let total = 0;

  for (const ch of text) { // サロゲートペアも1コードポイント単位で扱う
    const bytes = table.get(ch);
    if (bytes) {
      chunks.push(bytes);
      total += bytes.length;
    } else {
      unmappableSet.add(ch);
    }
  }

  if (unmappableSet.size > 0) {
    return { bytes: null, unmappable: [...unmappableSet] };
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return { bytes: out, unmappable: [] };
}
