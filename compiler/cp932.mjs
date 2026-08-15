// テキスト → CP932(Shift_JIS)バイト列。PMDの`.M`ヘッダ文字列(#Title等)の
// エンコードに使う(pmd_mml_compiler.mjs参照)。
//
// pmdweb/build-web/ui/cp932-encode.js(描画側でMMLソース文字列をCP932化する用途)
// と同じ手法: ブラウザ/Node共通のTextDecoder('shift_jis')に0x00-0xFFの1バイト値・
// 2バイト値の全組み合わせを総当たりして「バイト列→文字」の対応を実測し、逆引き表を
// 作る(値を手で転記しない。decode/encodeが常に同じ実装から導出されるので食い違わない)。
// compiler/ はNode(tools/配下のスクリプト)からもブラウザ(pmdweb/build-web,dist/)からも
// importされるため、UI層(pmdweb/build-web/ui/)には依存させず、ここに独立して持つ。
//
// Node v18+ / 現行ブラウザとも TextDecoder('shift_jis') はサポート済み(実測確認済み)。

let cachedTable = null;

function buildTable() {
  if (cachedTable) return cachedTable;
  const decoder = new TextDecoder('shift_jis', { fatal: false });
  const map = new Map();

  for (let b = 0; b <= 0xff; b++) {
    const s = decoder.decode(Uint8Array.of(b));
    if (s.length === 1 && s.charCodeAt(0) !== 0xfffd && !map.has(s)) {
      map.set(s, Uint8Array.of(b));
    }
  }

  const leadRanges = [[0x81, 0x9f], [0xe0, 0xfc]];
  for (const [lo, hi] of leadRanges) {
    for (let b1 = lo; b1 <= hi; b1++) {
      for (let b2 = 0x40; b2 <= 0xfc; b2++) {
        if (b2 === 0x7f) continue;
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

// 戻り値: { bytes: Uint8Array|null, unmappable: string[] }
// 変換できない文字が1つでもあれば bytes は null、unmappable にその文字(重複なし)を返す。
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
