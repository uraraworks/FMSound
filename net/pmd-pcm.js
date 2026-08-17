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

import { baseNameOf } from './archive.js';

/** 対応拡張子(ドット付き、大文字小文字は無視)。upstream未実装の.P86(PMD86)・
 * .PPS(PPSDRV)は対象外(fmdriver_pmd.c参照)。 */
export const PMD_PCM_EXTENSIONS = ['.PPC', '.PZI', '.PVI'];

const PMD_PCM_EXTENSION_RE = new RegExp(
  `\\.(${PMD_PCM_EXTENSIONS.map((ext) => ext.slice(1)).join('|')})$`,
  'i',
);

/**
 * 書庫展開エントリ配列(net/archive.js extractArchive()の結果)からPMD PCM系
 * ファイルだけを拾う純関数。nameはディレクトリを含みうる(書庫内のサブフォルダや
 * d88入れ子展開の "<d88名>/<内側のファイル名>" 形式)ため、basename化して返す
 * (MEMFS上は曲と同じディレクトリへフラットに置くため)。
 * @param {{name: string, data: Uint8Array}[]} entries
 * @returns {{name: string, data: Uint8Array}[]}
 */
export function collectPmdPcmFiles(entries) {
  if (!entries) return [];
  return entries
    .filter((entry) => PMD_PCM_EXTENSION_RE.test(entry.name))
    .map((entry) => ({ name: baseNameOf(entry.name), data: entry.data }));
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
  for (const pcm of pcmFiles) {
    Module.FS.writeFile(`${dir}/${baseNameOf(pcm.name)}`, pcm.data);
  }
  return songPath;
}
