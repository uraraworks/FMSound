# FMDSP 右半分データ(FFT/レベルメーター)引き継ぎ資料

wasm(`pmdweb/src/PmdCore.c`)から JS へ供給する、右半分表示に必要なデータの
バイトレイアウトと export の意味。**描画コードはここには含まれない**
(html/ 側の担当が実装する)。

## 1. 供給方法

既存のスナップショットリング(`struct status_snapshot`, `docs/fmdsp-layout.md` 参照)の
**同じエントリに** FFT とレベルを追加した。A/V 同期の仕組み(frame基準の二分探索)は
そのまま使える。

```
struct status_snapshot {
  uint32_t frame;
  struct flat_track_status tracks[TRACK_COUNT];      // 既存(21トラック x 26フィールド)
  uint8_t  fft[72];                                   // 追加: 先頭70byteが有効、末尾2byteは常に0の明示パディング
  struct flat_level_status levels[19];                // 追加: 19ch x 5フィールド(各int32_t)
};
```

`_Static_assert` で `sizeof(struct status_snapshot)` の内訳が固定されている
(`pmdweb/src/PmdCore.c` 冒頭)。レイアウトを変えた場合はビルドが落ちるので気付ける。

## 2. 新規 export(JS から呼べる関数)

| export名 | 戻り値 | 意味 |
|---|---|---|
| `getSnapshotFftOffset()` | uint32 | エントリ先頭から `fft[]` までのバイトオフセット |
| `getSnapshotLevelOffset()` | uint32 | エントリ先頭から `levels[]` までのバイトオフセット |
| `getFftBinCount()` | int | FFTの有効ビン数。**70固定**(`fft[]`配列自体は末尾パディング込みで72byte確保されているが、有効なのは先頭70byteのみ) |
| `getLevelCount()` | int | レベルメーターのチャンネル数。**19固定** |
| `getLevelFieldCount()` | int | 1チャンネルあたりのフィールド数。**5固定**(下記参照) |

既存の `getSnapshotRingPointer()` / `getSnapshotEntryByteSize()` / `getSnapshotWriteIndex()` と
組み合わせて使う。1エントリの絶対アドレスの求め方は既存コード
(`pmdweb/html/index.html` の `getSnapshotWriteIndex()` 周辺)と同じ。

```js
const entryBytes = Module.getSnapshotEntryByteSize();
const ringPtr = Module.getSnapshotRingPointer();
const entryBase = ringPtr + logicalIndex * entryBytes; // logicalIndexはリングサイズ(2048)でmod

// FFT: 70byte、値域0-31 (4段で6dB)
const fftBase = entryBase + Module.getSnapshotFftOffset();
const fft = Module.HEAPU8.slice(fftBase, fftBase + Module.getFftBinCount());

// レベル: 19ch x 5 int32(=20byte/ch)
const levelBase = (entryBase + Module.getSnapshotLevelOffset()) / 4; // HEAP32の添字(word単位)
const fieldCount = Module.getLevelFieldCount();
for (let ch = 0; ch < Module.getLevelCount(); ch++) {
  const o = levelBase + ch * fieldCount;
  const level   = Module.HEAP32[o + 0];
  const pan     = Module.HEAP32[o + 1];
  const prog    = Module.HEAP32[o + 2];
  const key     = Module.HEAP32[o + 3];
  const playing = Module.HEAP32[o + 4];
}
```

## 3. FFT(70ビン)

- 出典: `upstream/98fmplayer/fft/fft.h` / `fft.c`。`FFTLEN=8192`, `FFTDISPLEN=70`。
- 値域は **0〜31**(4段で6dB)。`uint8_t`。
- **算出頻度は約60Hz**(`SAMPLE_RATE/60 ≒ 924フレームごと`)。8192点FFTを毎スナップショット
  (ドライバ割り込みのたびの数百Hz)計算すると重いため、`PmdCore.c` 内の `fft_feed()` で
  間引いている。`fft_write()` 自体(PCMリングへの書き込み)は全オーディオブロックで毎回呼ぶので、
  スペクトラム自体は途切れなく供給されるが、**計算した値が更新されるのは約60Hzに1回**という点は
  描画側で考慮すること(リアルタイム性が必要な場合は間引き間隔 `FFT_CALC_INTERVAL_FRAMES` を
  `PmdCore.c` 側で調整可能)。
- 元のGTK版実装(`fmdsp_pacc_render()`)は表示フレームごとに1回 `fft_calc()` を呼んでおり
  (`upstream/98fmplayer/fmdsp/fmdsp-pacc.c:1626-1627`)、ディスプレイのリフレッシュレートに
  自然に同期していた。60Hzという間引き値はそれに合わせたもの。

## 4. レベルメーター(19ch)

出典: `upstream/98fmplayer/fmdsp/fmdsp-pacc.c:1660-1733` の `levels[]` 構築ロジックを
`PmdCore.c` の `build_levels()` にそのまま移植した。

### 並び順(index 0-18)

| index | チャンネル | level取得元 |
|---|---|---|
| 0-5 | FM 1-6 | `opna.fm.channel[c].leveldata` |
| 6-8 | SSG 1-3 | `opna.resampler.leveldata[c]` |
| 9 | リズム(6音の最大値) | `opna.drum.drums[0..5].leveldata` の最大 |
| 10 | ADPCM | `opna.adpcm.leveldata` |
| 11-18 | PPZ8 1-8 | `work.ppz8->channel[p].leveldata` |

### フィールド(1chあたり5つのint32)

| フィールド | 意味 |
|---|---|
| `level` | `leveldata_read()` の値。0が無音、大きいほど大(スケールは出典未確認、上流のまま) |
| `pan` | 定位。`fmdsp-pacc.c` の `table[]` をそのまま使用。**値の意味(左右のどちらに何を対応させるか)は未確認**。出典どおりの数値のみ保証 |
| `prog` | `track_status[].tonenum` |
| `key` | `track_status[].key` |
| `playing` | `track_status[].playing`。ただし `info` が `FMDRIVER_TRACK_INFO_PDZF` / `FMDRIVER_TRACK_INFO_PPZ8` のときは強制的に0(出典どおり) |

### 既知の癖(バグではなく上流の仕様をそのまま再現)

- **index 9(リズム)の `prog`/`key`/`playing` は FM1(`FMDRIVER_TRACK_FM_1`)の値がそのまま
  流用される。** リズムパートには専用の `track_status` が無いため。出典 `fmdsp-pacc.c` も
  同じ構造(`levels[9].t` を明示的に設定しない=デフォルト0=`FMDRIVER_TRACK_FM_1`)。
  描画側でリズムの音名表示等をする場合はこの値を信用しないこと。

## 5. ビルド上の変更点

- `pmdweb/CMakeLists.txt`:
  - `${UPSTREAM_DIR}/fft/fft.c` をソースに追加
  - `target_compile_definitions(pmdweb PRIVATE LIBOPNA_ENABLE_LEVELDATA)` を追加
    (これが無いと `opna.fm.channel[].leveldata` 等のフィールド自体が存在しない
    ビルドになる。PPZ8側の `leveldata` はこのマクロ非依存で常時有効)

## 6. 検証

`tools/verify_right_pane_data.mjs`(Node直接実行)で以下を確認済み:

- FFT 70ビンが全て0-31の範囲
- 無音時はスナップショットリング自体が無効、再生後は非0ビンが存在(配線の証明)
- 実際に鳴っているチャンネルの `level` が非0
- `getSnapshotEntryByteSize()` と各オフセット/カウントの整合性
- **故障注入**: `fft_feed()` の呼び出しを一時的にコメントアウトして再ビルドし、
  (b)の「非0ビンが存在する」チェックだけが FAIL することを確認してから元に戻した
  (常にPASSする検査になっていないことの確認)

実行: `node tools/verify_right_pane_data.mjs`
