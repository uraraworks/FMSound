#!/usr/bin/env node
// レベルメーターPPZ8列(11-18)の「未使用」表示(2026-08-17追加)を検証する。
//
// 背景(fmdsp/channel-mask.js unusedColumnsFromChannels冒頭コメント参照):
// PPZ8はこのWeb版では構造的に絶対に鳴らない(MUCOM88には概念が無く、
// PMDはサンプルバンクを読み込まない)ため、曲ごとの使用状況(usedChannels)に
// 関わらず列11-18は常にunused扱いになるべきで、かつ0-10列は従来どおり
// usedChannelsに応じて変わる(usedChannels=nullなら暗くしない)べきである。
//
// 実行: node tools/verify_ppz8_unused_columns.mjs

import {
  unusedColumnsFromChannels, FM_CHANNELS, SSG_CHANNELS, RHYTHM_CHANNEL, ADPCM_CHANNEL,
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

// 1. usedChannels=null(判定不能。曲を開いた直後等)でも、PPZ8列は常にunused、
//    かつ0-10列はunused扱いにならない(nullは「暗くしない」の従来挙動を維持)。
{
  const columns = unusedColumnsFromChannels(null);
  const ppz8AllUnused = PPZ8_COLUMNS.every((c) => columns.has(c));
  const nonPpz8NoneUnused = NON_PPZ8_COLUMNS.every((c) => !columns.has(c));
  check('usedChannels=null: PPZ8列(11-18)は全てunused', ppz8AllUnused, `unused=${[...columns].sort((a, b) => a - b)}`);
  check('usedChannels=null: 0-10列はunusedにならない(従来挙動維持)', nonPpz8NoneUnused, `unused=${[...columns].sort((a, b) => a - b)}`);
}

// 2. usedChannelsが全チャンネル使用中(FM1-6+SSG1-3+RHYTHM+ADPCM)でも、
//    PPZ8列は依然unused、かつ他の列はunusedにならない。
{
  const allUsed = new Set([...FM_CHANNELS, ...SSG_CHANNELS, RHYTHM_CHANNEL, ADPCM_CHANNEL]);
  const columns = unusedColumnsFromChannels(allUsed);
  const ppz8AllUnused = PPZ8_COLUMNS.every((c) => columns.has(c));
  const nonPpz8NoneUnused = NON_PPZ8_COLUMNS.every((c) => !columns.has(c));
  check('全チャンネル使用中でもPPZ8列(11-18)は全てunused', ppz8AllUnused, `unused=${[...columns].sort((a, b) => a - b)}`);
  check('全チャンネル使用中なら0-10列はunusedにならない', nonPpz8NoneUnused, `unused=${[...columns].sort((a, b) => a - b)}`);
}

// 3. usedChannelsが空集合(曲が0-10列を1つも使っていない)なら、0-10列も
//    unusedになる(従来挙動)。PPZ8はここでも当然unused。
{
  const columns = unusedColumnsFromChannels(new Set());
  const allUnused = [...NON_PPZ8_COLUMNS, ...PPZ8_COLUMNS].every((c) => columns.has(c));
  check('usedChannels=空集合: 0-18列すべてunused', allUnused, `unused=${[...columns].sort((a, b) => a - b)}`);
}

// [陽性対照] このファイル内の疑似チェックでは「壊れた実装」を模した固定Setを
// 比較するだけになり、fmdsp/channel-mask.jsの実装を実際には壊さないため
// 検査効果の証明として弱い(false positiveでも動いてしまう)。そのため陽性対照は
// このスクリプトに埋め込まず、実装ファイルを手動で一時的に壊して本スクリプトを
// 再実行する形で確認した(このコミットの作業記録):
//   1. fmdsp/channel-mask.js のunusedColumnsFromChannels内、PPZ8列を追加する
//      `for (...) columns.add(PPZ8_LEVEL_COLUMN_START + i);` を無効化
//      (旧実装=PPZ8を一切追加しない状態に戻す)。
//   2. 本スクリプトを実行 -> 上のテスト1・2・3が実際にFAILすることを確認済み
//      (2026-08-17実施。PPZ8列がunusedに含まれなくなったため)。
//   3. 実装を元に戻し、本スクリプトが全PASSに戻ることを確認済み。

console.log(`\n=== 結果: ${passCount} PASS / ${failCount} FAIL ===`);
if (failCount > 0) process.exit(1);
