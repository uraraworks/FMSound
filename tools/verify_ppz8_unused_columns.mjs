#!/usr/bin/env node
// レベルメーターPPZ8列(11-18)の「未使用」表示を検証する。
//
// 背景(fmdsp/channel-mask.js unusedColumnsFromChannels冒頭コメント参照):
// 2026-08-17時点ではPPZ8はこのWeb版で構造的に絶対に鳴らない(MUCOM88には
// 概念が無く、PMDはサンプルバンクを読み込まない)という前提で、PPZ8列は
// usedChannelsの中身に関わらず常にunused扱いだった。その後PPZ8バンク
// (.PZI/.PVI)を書庫から読み込めるようになり(実データで絶対値和が0から
// 2,525,364,434へ変化することを確認済み)、PMD側の前提が崩れたため、
// 2026-08-18にPMD側だけ曲ごとの判定(unusedColumnsFromChannensの第2引数
// ppz8UsedChannels)へ差し替えた。MUCOM88側(第2引数省略)は今も一律unusedの
// ままで正しい(fmgenにPPZ8相当の実装が無いため)。
//
// 実行: node tools/verify_ppz8_unused_columns.mjs

import {
  unusedColumnsFromChannels, FM_CHANNELS, SSG_CHANNELS, RHYTHM_CHANNEL, ADPCM_CHANNEL,
  PPZ8_CHANNELS,
} from '../fmdsp/channel-mask.js';

let failCount = 0;
let passCount = 0;
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passCount++; else failCount++;
  console.log(`[${mark}] ${name}${detail !== undefined ? ' - ' + detail : ''}`);
  return cond;
}

const PPZ8_COLUMNS = [11, 12, 13, 14, 15, 16, 17, 18];
const NON_PPZ8_COLUMNS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

console.log('=== PPZ8列(11-18)の未使用表示検証(fmdsp/channel-mask.js unusedColumnsFromChannels) ===\n');

// --- 第2引数を省略した場合(MUCOM88側の呼び出し方。html/mucom-app.js参照)。
// 一律unusedのまま(従来どおり)であること。

// 1. usedChannels=null(判定不能。曲を開いた直後等)でも、PPZ8列は常にunused、
//    かつ0-10列はunused扱いにならない(nullは「暗くしない」の従来挙動を維持)。
{
  const columns = unusedColumnsFromChannels(null);
  const ppz8AllUnused = PPZ8_COLUMNS.every((c) => columns.has(c));
  const nonPpz8NoneUnused = NON_PPZ8_COLUMNS.every((c) => !columns.has(c));
  check('MUCOM側(第2引数省略) usedChannels=null: PPZ8列(11-18)は全てunused', ppz8AllUnused, `unused=${[...columns].sort((a, b) => a - b)}`);
  check('MUCOM側(第2引数省略) usedChannels=null: 0-10列はunusedにならない(従来挙動維持)', nonPpz8NoneUnused, `unused=${[...columns].sort((a, b) => a - b)}`);
}

// 2. usedChannelsが全チャンネル使用中(FM1-6+SSG1-3+RHYTHM+ADPCM)でも、
//    PPZ8列は依然unused、かつ他の列はunusedにならない。
{
  const allUsed = new Set([...FM_CHANNELS, ...SSG_CHANNELS, RHYTHM_CHANNEL, ADPCM_CHANNEL]);
  const columns = unusedColumnsFromChannels(allUsed);
  const ppz8AllUnused = PPZ8_COLUMNS.every((c) => columns.has(c));
  const nonPpz8NoneUnused = NON_PPZ8_COLUMNS.every((c) => !columns.has(c));
  check('MUCOM側(第2引数省略) 全チャンネル使用中でもPPZ8列(11-18)は全てunused', ppz8AllUnused, `unused=${[...columns].sort((a, b) => a - b)}`);
  check('MUCOM側(第2引数省略) 全チャンネル使用中なら0-10列はunusedにならない', nonPpz8NoneUnused, `unused=${[...columns].sort((a, b) => a - b)}`);
}

// 3. usedChannelsが空集合(曲が0-10列を1つも使っていない)なら、0-10列も
//    unusedになる(従来挙動)。PPZ8はここでも当然unused。
{
  const columns = unusedColumnsFromChannels(new Set());
  const allUnused = [...NON_PPZ8_COLUMNS, ...PPZ8_COLUMNS].every((c) => columns.has(c));
  check('MUCOM側(第2引数省略) usedChannels=空集合: 0-18列すべてunused', allUnused, `unused=${[...columns].sort((a, b) => a - b)}`);
}

// --- 第2引数(ppz8UsedChannels)を渡す場合(PMD側の呼び出し方。html/pmd-app.js
// draw()参照)。2026-08-18追加。列ごとに個別判定される。

// 4. [本体] ppz8UsedChannelsが空集合(まだどのPPZ8chもtrack_status.playingを
//    観測していない、曲を開いた直後)なら、PPZ8列(11-18)は全てunused。
{
  const columns = unusedColumnsFromChannels(null, new Set());
  const ppz8AllUnused = PPZ8_COLUMNS.every((c) => columns.has(c));
  check('PMD側 ppz8UsedChannels=空集合: PPZ8列は全てunused', ppz8AllUnused, `unused=${[...columns].sort((a, b) => a - b)}`);
}

// 5. [本体] ppz8UsedChannelsにPPZ8_1(列11)だけが入っていれば、列11だけが
//    unusedから外れ、他のPPZ8列(12-18)はunusedのまま。
{
  const columns = unusedColumnsFromChannels(null, new Set([PPZ8_CHANNELS[0]]));
  check('PMD側 PPZ8_1だけ使用中: 列11はunusedに含まれない', !columns.has(11), `unused=${[...columns].sort((a, b) => a - b)}`);
  const restUnused = PPZ8_COLUMNS.slice(1).every((c) => columns.has(c));
  check('PMD側 PPZ8_1だけ使用中: 列12-18はunusedのまま', restUnused, `unused=${[...columns].sort((a, b) => a - b)}`);
}

// 6. [本体] ppz8UsedChannelsに全8ch入っていれば、PPZ8列は1つもunusedにならない。
{
  const columns = unusedColumnsFromChannels(null, new Set(PPZ8_CHANNELS));
  const noneUnused = PPZ8_COLUMNS.every((c) => !columns.has(c));
  check('PMD側 PPZ8全ch使用中: PPZ8列は1つもunusedにならない', noneUnused, `unused=${[...columns].sort((a, b) => a - b)}`);
}

// 7. PPZ8列の判定(ppz8UsedChannels)と0-10列の判定(usedChannels)は独立している
//    こと(片方を全部使用中にしても、もう片方の判定に影響しない)。
{
  const allUsed010 = new Set([...FM_CHANNELS, ...SSG_CHANNELS, RHYTHM_CHANNEL, ADPCM_CHANNEL]);
  const columns = unusedColumnsFromChannels(allUsed010, new Set([PPZ8_CHANNELS[3]]));
  check('PMD側 0-10列全使用中でもPPZ8列3(列14)以外はunusedのまま', PPZ8_COLUMNS.filter((c) => c !== 14).every((c) => columns.has(c)));
  check('PMD側 0-10列全使用中でも列14はunusedに含まれない', !columns.has(14));
  check('PMD側 0-10列は全使用中なのでunusedに含まれない', NON_PPZ8_COLUMNS.every((c) => !columns.has(c)));
}

// [陽性対照] このファイル内の疑似チェックでは「壊れた実装」を模した固定Setを
// 比較するだけになり、fmdsp/channel-mask.jsの実装を実際には壊さないため
// 検査効果の証明として弱い(false positiveでも動いてしまう)。そのため陽性対照は
// このスクリプトに埋め込まず、実装ファイルを手動で一時的に壊して本スクリプトを
// 再実行する形で確認した(作業記録):
//   1. fmdsp/channel-mask.js のunusedColumnsFromChannels内、
//      `if (ppz8UsedChannels) { ... } else { ... }` の分岐を削除し、
//      常にelse側(一律unused)だけを実行する旧実装へ戻す。
//   2. 本スクリプトを実行 -> テスト5・6・7が実際にFAILすることを確認済み
//      (2026-08-18実施。個別判定が効かず全列unusedになったため)。
//   3. 実装を元に戻し、本スクリプトが全PASSに戻ることを確認済み。
// (「暗いままという症状」でのFAIL確認は tools/verify_pmd_ppz8_used_columns.mjs
// 側の陽性対照(wasm実測)でも別途行っている。)

console.log(`\n=== 結果: ${passCount} PASS / ${failCount} FAIL ===`);
if (failCount > 0) process.exit(1);
