// MML(テキスト)バイト列の文字コード判定。
//
// MUCOM88のMML(.muc)は伝統的にCP932(Shift_JIS)で書かれるが、UTF-8で保存された実物も
// 存在する(利用者提供の検証材料: sample2をUTF-8化したもの)。決め打ちせず、UTF-8として
// 妥当なバイト列かどうかを厳密デコーダ(fatal:true)で検査し、妥当ならUTF-8、
// デコードエラーになったらCP932とみなす(「推測」ではなく「検査」、README/報告の指示どおり)。
//
// この判定の誤検出率は実務上ごく小さい: 生のCP932バイト列(特に半角カナ0xA1-0xDF単体や
// 2バイト目に0x80/0xFD-0xFF等を含む組)は、UTF-8の継続バイト規則(0x80-0xBFの並び方)を
// 満たさないことがほとんどで、fatal:trueのTextDecoderは大半のCP932日本語文を例外にする。
// ASCIIのみの文字列はUTF-8/CP932のどちらでバイト列としても同一なので、この判定では
// 常にUTF-8側として扱われる(実害無し、デコード結果は同じ)。

/**
 * @param {Uint8Array} bytes
 * @returns {{ text: string, encoding: 'utf-8' | 'shift_jis' }}
 */
export function decodeMmlBytes(bytes) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { text, encoding: 'utf-8' };
  } catch {
    // UTF-8として不正なバイト列 -> CP932(Shift_JIS)とみなす。
  }
  return { text: decodeAsShiftJis(bytes), encoding: 'shift_jis' };
}

/** @param {Uint8Array} bytes */
function decodeAsShiftJis(bytes) {
  let decoder;
  try {
    decoder = new TextDecoder('shift_jis', { fatal: false });
  } catch {
    decoder = new TextDecoder('cp932', { fatal: false });
  }
  return decoder.decode(bytes);
}

/**
 * 利用者が手動で文字コードを切り替えたときに使う、指定エンコーディング固定のデコード。
 * @param {Uint8Array} bytes @param {'utf-8' | 'shift_jis'} encoding
 */
export function decodeMmlBytesAs(bytes, encoding) {
  if (encoding === 'utf-8') {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
  return decodeAsShiftJis(bytes);
}
