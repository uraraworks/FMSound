// 課題D: コンパイル済みバイト列をNASMの`db`配列ソースへ変換する。
//
// WorkbenchNP2(PC-98/PC-88プログラムをWeb上でビルドする道具)のファイル保管庫は
// 文字列専用でバイナリを保存できない。曲データを`.asm`ソース内の`db`配列として
// 埋め込めばこの制約を回避できることは実測で確認済み(docs/pipeline-spike.md)。
// ラベル名は単純な識別子(`song_data`)で足りることも同ドキュメントで確認済み。

const BYTES_PER_LINE = 16;

/**
 * @param {Uint8Array} bytes コンパイル済みの曲データ(.M/.mub)
 * @param {string} label ラベル名(NASMの識別子として有効な文字列にすること)
 * @returns {string} そのまま.asmファイルへ貼り付けられるテキスト
 */
export function bytesToAsmDb(bytes, label) {
  const lines = [];
  lines.push(`; FMSoundからの書き出し(${bytes.length} bytes)。docs/pipeline-spike.md参照。`);
  lines.push(`${label}:`);
  for (let i = 0; i < bytes.length; i += BYTES_PER_LINE) {
    const end = Math.min(i + BYTES_PER_LINE, bytes.length);
    const hex = [];
    for (let j = i; j < end; j++) hex.push(`0x${bytes[j].toString(16).toUpperCase().padStart(2, '0')}`);
    lines.push(`    db ${hex.join(', ')}`);
  }
  lines.push(`${label}_end:`);
  lines.push(`${label}_len equ ${label}_end - ${label}`);
  return lines.join('\n') + '\n';
}
