// PMD側のPCM(.PPC/.PZI/.PVI)をMEMFS(wasm仮想FS)へ配置する窓口。DOM非依存
// (html/pmd-app.jsだけでなく tools/verify_pmd_ppc_load.mjs からも同じ関数を
// 本番経路として通す想定。ヘルパを別に用意して検証だけ通す、という形にはしない)。
//
// 実測で確定した事実(2026-08-17): pmdweb は upstream の fmplayer_file_load() を
// 呼んでおり、その中の loadppc()/loadpmdppz()
// (upstream/98fmplayer/common/fmplayer_file.c) が .M ヘッダのPCMファイル名を使って
// 「.Mファイルと同じディレクトリ」を opendir/readdir で大文字小文字無視走査して探す
// (upstream/98fmplayer/common/fmplayer_file_unix.c fmplayer_fileread())。
// ルート直下('/'+name)へ書き込むと dirpath が空文字になり opendir("") が失敗するため、
// .PPC は絶対に見つからない(実測: ルート直下に曲と.PPCを両方置いてもADPCMの
// absSumが「.PPCを置かない陰性対照」と完全一致した)。そのため曲ごとに専用の
// サブディレクトリを作り、曲とPCMを必ず同居させる。

import { baseNameOf, dirNameOf } from './archive.js';
import { p86ToPpc } from './pmd-p86.js';

/** 対応拡張子(ドット付き、大文字小文字は無視)。.P86(PMD86)は2026-08-19に
 * net/pmd-p86.js p86ToPpc()による疑似.PPC変換で対応済み(writeSongWithPcm()参照)。
 * .PPS(PPSDRV)はupstream未実装のまま対象外(fmdriver_pmd.c参照)。 */
export const PMD_PCM_EXTENSIONS = ['.PPC', '.PZI', '.PVI', '.P86'];

const PMD_PCM_EXTENSION_RE = new RegExp(
  `\\.(${PMD_PCM_EXTENSIONS.map((ext) => ext.slice(1)).join('|')})$`,
  'i',
);

// .P86ファイル名判定・拡張子置換の両方に使う(writeSongWithPcm()参照)。
const P86_FILENAME_RE = /\.P86$/i;

/**
 * 書庫展開エントリ配列(net/archive.js extractArchive()の結果)からPMD PCM系
 * ファイルだけを拾う純関数。nameはディレクトリを含みうる(書庫内のサブフォルダや
 * d88入れ子展開の "<d88名>/<内側のファイル名>" 形式)ため、basename化して返す
 * (MEMFS上は曲と同じディレクトリへフラットに置くため)。
 *
 * 不具合(実測で確定、2026-08-18): 実データのzipで、別ディレクトリに同名だが
 * 中身の違う .PPC が2つ存在する構成があった(例: JSM/MF88PCM.PPC と
 * YD/MF88PCM.PPC)。basename化するとどちらも同じnameになり、
 * writeSongWithPcm()は受け取った配列を順に書き込むため「後に書いた方が勝つ」
 * 事故になる(音は出るが別の曲の音色バンクで鳴る、無音より気づきにくい不具合)。
 * これを防ぐため、songEntryName(選ばれた曲の書庫内エントリ名)を受け取り、
 * 同名候補があれば曲と同じディレクトリのものを優先して1つに絞る。
 *
 * @param {{name: string, data: Uint8Array}[]} entries
 * @param {string} [songEntryName] 選ばれた曲の書庫内エントリ名(entry.name。
 *   表示用のdisplayName/basenameではなくパスを含む実際の名前を渡すこと)。
 *   **省略時**: 従来通りbasename化するだけで、同名衝突の解決は一切行わない
 *   (=entries内の出現順そのままを返す。writeSongWithPcm()が書き込み順に
 *   上書きするため、実質「entries内で最後に出現したものが勝つ」という、
 *   この関数がまだ知らなかった頃の挙動と同じになる)。曲のエントリ名を
 *   持たない/特定できない呼び出し元のための後方互換用の分岐であり、
 *   同名PCMが複数ディレクトリに存在する書庫では不正確になりうる。
 *   本番の呼び出し元(html/pmd-app.js)は必ず第2引数を渡すこと。
 * @returns {{name: string, data: Uint8Array}[]}
 */
export function collectPmdPcmFiles(entries, songEntryName) {
  if (!entries) return [];
  const matches = entries.filter((entry) => PMD_PCM_EXTENSION_RE.test(entry.name));

  if (songEntryName === undefined) {
    return matches.map((entry) => ({ name: baseNameOf(entry.name), data: entry.data }));
  }

  // 同名(basename一致)の候補をグループ化し、グループごとに1つだけ採用する。
  // 採用規則(利用者指示通り、決め打ちしない部分を明記する):
  //  1. グループ内に「曲と同じディレクトリ(dirNameOf一致)」の候補があれば、
  //     その中でentries配列の出現順が最初のものを採用する。
  //  2. 曲と同じディレクトリに候補が無ければ、他ディレクトリの候補を捨てず
  //     (1曲が別フォルダの共有音色バンクを参照する構成もありうるため)、
  //     グループ全体の中で出現順が最初のものを採用する。
  //  どちらの場合も「出現順最初」で固定し、「たまたま配列の最後に来たもの」に
  //  依存しないようにする(=同じ入力なら常に同じ結果になる)。
  const songDir = dirNameOf(songEntryName);
  /** @type {Map<string, {name: string, data: Uint8Array}[]>} */
  const byBase = new Map();
  for (const entry of matches) {
    const base = baseNameOf(entry.name);
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(entry);
  }

  const result = [];
  for (const [base, candidates] of byBase) {
    const sameDir = candidates.filter((c) => dirNameOf(c.name) === songDir);
    const chosen = (sameDir.length > 0 ? sameDir : candidates)[0];
    result.push({ name: base, data: chosen.data });
  }
  return result;
}

// upstreamが未実装の拡張子(.PPS=PPSDRV)。.P86(PMD86)は2026-08-19にp86ToPpc()で
// 対応済みになったためここから外した(PMD_PCM_EXTENSIONS側で拾う)。
// PMD_PCM_EXTENSIONSには加えない(供給しても鳴らないので供給対象を増やす意味がない)。
// ここで拾うのはあくまで「使われているが対応していない」ことを利用者に伝えるため。
const PMD_PCM_UNSUPPORTED_EXTENSIONS = ['.PPS'];
const PMD_PCM_UNSUPPORTED_EXTENSION_RE = new RegExp(
  `\\.(${PMD_PCM_UNSUPPORTED_EXTENSIONS.map((ext) => ext.slice(1)).join('|')})$`,
  'i',
);

/**
 * 書庫展開エントリ配列からupstream未実装のPCM系ファイル(.PPS)だけを拾う
 * 純関数。collectPmdPcmFiles()と対になるが、こちらはMEMFSへ書き込むためではなく
 * 「供給しても鳴らない」ことを利用者へ知らせるための情報収集用。
 * @param {{name: string, data: Uint8Array}[]} entries
 * @returns {{name: string, ext: string}[]}
 */
export function collectUnsupportedPmdPcmFiles(entries) {
  if (!entries) return [];
  return entries
    .filter((entry) => PMD_PCM_UNSUPPORTED_EXTENSION_RE.test(entry.name))
    .map((entry) => {
      const base = baseNameOf(entry.name);
      const m = PMD_PCM_UNSUPPORTED_EXTENSION_RE.exec(base);
      return { name: base, ext: `.${m[1].toUpperCase()}` };
    });
}

/**
 * pcmtype→表示用拡張子の対応。表示用の名前復元にのみ使う(実ファイル探索には
 * 使わない。探索はwriteSongWithPcm()が既に済ませた後の話で、ここは「何が
 * 足りなかったか」の文言を組み立てるだけ)。
 * PPZ1/PPZ2は".PZI / .PVI"と両方示す(断定しない。describePmdPcmStatus()の
 * コメント参照)。PPCは".PPC"固定でよい(loadppc()が.PPCしか試さないため)。
 */
const PCM_TYPE_TO_EXT = { PPC: '.PPC', PPZ1: '.PZI / .PVI', PPZ2: '.PZI / .PVI' };

/**
 * work.pcmname[i]はfmdriver_fillpcmname()により8文字・空白詰めで格納される
 * (拡張子は含まない)。表示用に末尾の空白を取り除く。
 * @param {string} name
 */
function trimPcmName(name) {
  return (name || '').replace(/\s+$/, '');
}

/**
 * PMD再生後のPCM状態から、利用者に見せるべきメッセージのキーと引数だけを
 * 返す純関数(文言そのものはui/i18n.jsに置く。ここでは決めない)。
 *
 * 判定規則(利用者指示の通り、決め打ちしない部分はコメントで明示する):
 *  - type===''(そのドライバに存在しないスロット)、またはnameが空白のみ
 *    (使っていないスロット)は無視する。
 *  - type==='PPS' はupstream未実装。PPSDRVは「必要だが読み込めない」のではなく
 *    「そもそもこのプレイヤーが対応していない」ので専用メッセージにする
 *    (errorは常にtrueなので条件に使わない。fmdriver_pmd.c pmd_init()参照)。
 *  - それ以外(PPC/PPZ1/PPZ2)でerrorが真なら「必要だが読み込めていない」。
 *    ファイル名は拡張子をtypeから補って表示する。PPZ1/PPZ2は work.pcmtype/pcmname
 *    だけでは実ファイルが.PZIか.PVIかを区別できないため、どちらか一方に断定せず
 *    「NAME.PZI / .PVI」の形で両方示す(PCM_TYPE_TO_EXT参照)。この文言は利用者に
 *    「探して同じ書庫に入れる」よう促すものなので、外れた拡張子を1つだけ提示すると
 *    探せない。upstream の loadpmdppz()(common/fmplayer_file.c)自身が.PVI/.PZIを
 *    両方試す実装になっており、両方示すのはその実装と整合する判断。
 *    PPCは.PPC固定でよい(loadppc()が.PPCしか試さないため断定して正しい)。
 *  - p86ConversionErrorsにエントリがあれば、.P86→疑似.PPC変換(pmd-p86.js
 *    p86ToPpc())が失敗した旨を errorの種類ごとに専用メッセージで伝える。
 *    【2026-08-19】以前ここには「.P86はupstream未対応」という抑止ロジック
 *    (matchesP86())があったが、writeSongWithPcm()がp86ToPpc()で実際に変換して
 *    鳴らせるようになったため誤りになった(同梱を忘れた場合に何も言わなくなる)。
 *    撤去し、変換の成否で判断する形に置き換えた。
 * @param {{ slots: {type: string, name: string, error: boolean}[],
 *   unsupportedFiles?: {name: string, ext: string}[],
 *   p86ConversionErrors?: { name: string, error: 'invalid_p86' | 'capacity',
 *     requiredBytes?: number, maxBytes?: number }[] }} args
 * @returns {{ key: string, params: Record<string, string|number> }[]}
 */
export function describePmdPcmStatus({ slots, unsupportedFiles = [], p86ConversionErrors = [] }) {
  const messages = [];

  const missingNames = [];
  const ppsNames = [];
  for (const slot of slots || []) {
    const type = slot.type || '';
    const name = trimPcmName(slot.name);
    if (!type || !name) continue; // 未使用スロット
    if (type === 'PPS') {
      ppsNames.push(name);
      continue;
    }
    if (slot.error) {
      const ext = PCM_TYPE_TO_EXT[type] || '';
      missingNames.push(`${name}${ext}`);
    }
  }

  if (missingNames.length > 0) {
    messages.push({ key: 'pmd.pcm.missing', params: { files: missingNames.join(', ') } });
  }
  if (ppsNames.length > 0) {
    messages.push({ key: 'pmd.pcm.ppsUnsupported', params: { files: ppsNames.join(', ') } });
  }

  // .P86→疑似.PPC変換の失敗。requiredBytes/maxBytesは実数値をそのまま渡す
  // (利用者指示: capacityは必要量と上限の実数値を文言に含める。翻訳可能なように
  // p86ToPpc()の日本語message文字列はここでは使わず、構造化された値だけを使う)。
  for (const err of p86ConversionErrors || []) {
    if (err.error === 'capacity') {
      messages.push({
        key: 'pmd.pcm.p86Capacity',
        params: { file: err.name, requiredBytes: err.requiredBytes, maxBytes: err.maxBytes },
      });
    } else {
      messages.push({ key: 'pmd.pcm.p86Invalid', params: { file: err.name } });
    }
  }

  return messages;
}

/**
 * 前回このModuleへ書き込んだ曲ディレクトリの中身を削除する。
 * 同じディレクトリを使い回すと前の曲の.PPCが残ってしまい、たまたま名前が一致した
 * 場合に誤って読み込まれる(無音より発見しにくい事故になる)ため、必ず片付けてから
 * 次の曲用の新しいディレクトリを作る。
 * 削除失敗(初回でまだ存在しない等)はここで黙って握りつぶす。以降の書き込みは
 * 常に新しい一意なディレクトリ名を使うため、削除に失敗しても衝突は起きない。
 * @param {*} Module
 * @param {string} dir
 */
function cleanupPreviousSongDir(Module, dir) {
  try {
    const names = Module.FS.readdir(dir).filter((n) => n !== '.' && n !== '..');
    for (const name of names) {
      try {
        Module.FS.unlink(`${dir}/${name}`);
      } catch {
        // 無視(個別ファイルの削除失敗。ディレクトリごと使い捨てるので致命的ではない)。
      }
    }
    Module.FS.rmdir(dir);
  } catch {
    // 無視(ディレクトリが存在しない等)。
  }
}

/**
 * 曲(と付随PCM)をMEMFS上の専用ディレクトリへ配置し、Module.playMusic()へ渡すべき
 * 絶対パスを返す唯一の窓口。html/pmd-app.jsの全ての曲読み込み経路(ローカル
 * ファイル/URL/書庫/ライブラリ選択/コンパイル済みMML)はここを通す。
 *
 * 曲ごとに新しい一意のディレクトリ(/song1, /song2, ...)を作る。ディレクトリを
 * 使い回さないのは、PCMの探索(fmplayer_fileread())が「.Mと同じディレクトリを
 * 大文字小文字無視で走査する」仕様のため、前の曲の.PPCが残っていると誤検出しうる
 * ためで、cleanupPreviousSongDir()で前回分を削除してから新設する。
 *
 * songName/pcmFiles[].name は日本語やスラッシュを含みうる(#titleフォールバックや
 * 書庫内サブフォルダ由来)ため、ディレクトリ区切りとして誤解釈されないよう必ず
 * basename化してから書き込む。
 * 【2026-08-19拡張】pcmFilesに.P86(PMD86のPCM)が混じっている場合、そのままでは
 * ドライバが読めない(loadppc()は.PPCしか探さない)ため、net/pmd-p86.js p86ToPpc()で
 * 疑似.PPCへ変換してから`<拡張子抜きの元の名前>.PPC`として書く。理由:
 * ドライバの`work->pcmname[0]`には拡張子抜き8文字(例`MBE86PCM`)が入り、loadppc()は
 * その名前に`.PPC`を付けて同じディレクトリを探す。元の`.P86`はそのまま書いても
 * 誰も探さないので書かない(前の曲の残骸と紛れる事故を避ける、cleanupPreviousSongDir()
 * と同じ考え方)。
 * 変換に失敗した場合(容量超過/不正な.P86)はそのPCMを書かず、失敗理由を
 * `Module.__pmdPcmP86Failures`(呼び出しごとに全消去してから積み直す配列)へ積む。
 * html/pmd-app.js reportPmdPcmStatus()がここを読み、describePmdPcmStatus()の
 * p86ConversionErrors引数へ渡して利用者へ理由を説明する。
 * @param {*} Module - createPmdWeb()が返すEmscripten Module
 * @param {{songName: string, songBytes: Uint8Array, pcmFiles?: {name: string, data: Uint8Array}[]}} args
 * @returns {string} Module.playMusic()に渡す絶対パス
 */
export function writeSongWithPcm(Module, { songName, songBytes, pcmFiles = [] }) {
  if (Module.__pmdPcmCurrentDir) {
    cleanupPreviousSongDir(Module, Module.__pmdPcmCurrentDir);
  }
  Module.__pmdPcmDirCounter = (Module.__pmdPcmDirCounter || 0) + 1;
  const dir = `/song${Module.__pmdPcmDirCounter}`;
  Module.FS.mkdir(dir);
  Module.__pmdPcmCurrentDir = dir;

  const songPath = `${dir}/${baseNameOf(songName)}`;
  Module.FS.writeFile(songPath, songBytes);

  // この曲の.P86変換失敗を集める配列。曲を読み込むたびに全消去してから積み直す
  // (前の曲の失敗を持ち越さない)。
  const p86Failures = [];
  Module.__pmdPcmP86Failures = p86Failures;

  for (const pcm of pcmFiles) {
    const base = baseNameOf(pcm.name);
    if (P86_FILENAME_RE.test(base)) {
      const converted = p86ToPpc(pcm.data);
      if (!converted.ok) {
        p86Failures.push({ name: base, ...converted });
        continue; // 変換できない.P86は書かない(残骸が紛れる事故を避ける)
      }
      const ppcName = base.replace(P86_FILENAME_RE, '.PPC');
      Module.FS.writeFile(`${dir}/${ppcName}`, converted.bytes);
      continue;
    }
    Module.FS.writeFile(`${dir}/${base}`, pcm.data);
  }
  return songPath;
}
