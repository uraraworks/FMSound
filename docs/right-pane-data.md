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

## 6. 検証(PMD側)

`tools/verify_right_pane_data.mjs`(Node直接実行)で以下を確認済み:

- FFT 70ビンが全て0-31の範囲
- 無音時はスナップショットリング自体が無効、再生後は非0ビンが存在(配線の証明)
- 実際に鳴っているチャンネルの `level` が非0
- `getSnapshotEntryByteSize()` と各オフセット/カウントの整合性
- **故障注入**: `fft_feed()` の呼び出しを一時的にコメントアウトして再ビルドし、
  (b)の「非0ビンが存在する」チェックだけが FAIL することを確認してから元に戻した
  (常にPASSする検査になっていないことの確認)

実行: `node tools/verify_right_pane_data.mjs`

## 6a. MUCOM側(mucomweb)のFFT実装

`mucomweb/src/MucomWeb.cpp` にも同じ形式でFFT(70ビン)を実装した。PMD側との
違いのみここに記す(共通部分は §1-3 参照。命名も揃えてある: `getSnapshotFftOffset()` /
`getFftBinCount()`)。

- **レベルメーター(levels[])も実装した(2026-08-14)。** 当初「fmgenにレベル
  追従が無いためスコープ外」としていたが、fmgen自体にPMD側`leveldata`相当の
  ピーク追従を後付けした。詳細は§6b参照。`StatusSnapshot` は
  `frame + passTick/intCount/maxCount + chstat[16] + tracks[MUCOM_MAXCH] + fft[72] + levels[19]`
  という構成(PMD側と同じ順、tracksの後にfft→levels)。
- **サンプル形式の食い違い。** MUCOMのミックス後PCM(`g_audioBuffer`)は
  `int32_t`のステレオ(fmgen の `FM_SAMPLETYPE=int32`、`fmgen.h`)。値のスケール
  自体は16bit相当だが(再生側 `mucom-worklet.js` が `sample/32768` でPCM化)、
  ミックスにより ±32768 をわずかに超えることがある。`fft_write()`
  (98fmplayer/fft/fft.h)は`int16_t*`を要求するため、`MucomWeb.cpp`の`FftFeed()`で
  **明示的に[-32768,32767]へクランプしてから`int16_t`にキャスト**している
  (無言のstatic_castによる暗黙切り捨てにはしていない)。
- **FFT算出の間引き間隔。** PMD側はサンプルレート固定(55467Hz)なので
  `SAMPLE_RATE/60`という定数で間引けるが、MUCOM側はUIでサンプルレートが
  可変(12kHz-55kHz、`compileMML(mml, sampleRate)`の引数)なので、
  `g_sampleRate`(再生開始時に保存)から都度 `g_sampleRate/60` を計算している。
- **fft.cのビルド取り込み。** `mucomweb/CMakeLists.txt` に
  `${FFT_UPSTREAM_DIR}/fft/fft.c`(`upstream/98fmplayer`、無改変)を追加し、
  includeパス(`${FFT_UPSTREAM_DIR}`)も追加した。fft.h/fft.cはCで書かれ
  `extern "C"`ガードが無いため、C++の`MucomWeb.cpp`側で
  `extern "C" { #include "fft/fft.h" }` と明示的に包んでリンクエラー
  (名前修飾の不一致)を避けている。ライセンス表記は `NOTICE.md` に追記した
  (98fmplayer由来、BSD 2-Clause。既存のpmdweb分と同一条項)。
- **Node向けテスト専用export。** ブラウザの`AudioWorklet`経路
  (`ProcessAudioRequest`)はNode環境から到達できない(EM_JSの`AudioContext`
  初期化が失敗するため)。`renderFramesForTest(frames)` / `getSampleRate()` を
  pmdweb同様に追加し、Nodeから直接レンダリングして検証できるようにした。

検証: `tools/verify_right_pane_data_mucom.mjs`(PMD側の兄弟スクリプト)。
故障注入の実施記録は `docs/verify_right_pane_data_mucom_fault_injection_log.txt`。

## 6b. MUCOM側(mucomweb)のレベルメーター実装

fmgen(`upstream/MucomWeb/mucom88/src/fmgen`)には98fmplayerの`leveldata`に
相当するチャンネル単位のレベル出力が一切無い。そこで
`mucomweb/patches/0002-fmgen-leveldata.patch`でfmgen自体のミックス処理に
ピーク追従(read-and-clear、上流`leveldata_read()`/`leveldata_update()`と
同じ意味論)を直接差し込んだ。単一スレッド(wasm/Node)なので上流の
`stdatomic`(`atomic_flag`)は使わず、`unsigned`+`bool`の素朴な実装にしている。

### 経路ごとの分離可否(全経路を確認済み。分離不能だった経路は無い)

| 経路 | 対応チャンネル | 分離可否 | 差し込み位置 |
|---|---|---|---|
| `OPNABase::MixSubS`/`MixSubSL` | FM 1-6 | **可** | `ch[c].Calc()`/`CalcL()`の戻り値をステレオバッファへ加算する**前**に捕捉。元々1呼び出し=1チャンネル分離済み |
| `PSG::Mix` | SSG 1-3 | **可(要変更)** | 3チャンネル分がオーバーサンプリングループ内でインライン合算されており中間値が無い。3並列のアキュムレータ`csample[0..2]`を追加し、既存の合算アキュムレータと並行して積算(ノイズ無効/有効/エンベロープ固定の3つのループ変種すべてに同じ変更を適用) |
| `OPNA::RhythmMix` | リズム(6音) | **可** | 楽器ごとのループ内`sample`ローカル変数が既に1楽器分離済み。6音の最大値をindex9として採用(PMD側`build_levels()`と同じ方針) |
| `OPNABase::ADPCMBMix` | ADPCM | **可** | モノラル1系統のみなので分離の必要すら無い。ループが3種類あるがどれも同じ`s`ローカルをタップ |

### 並び順(index 0-18)。実測で確定(下記参照)

| index | チャンネル | 対応track(A-K) | 備考 |
|---|---|---|---|
| 0-2 | FM 1-3 | A,B,C | |
| 3-5 | FM 4-6 | H,I,J | MUCOMコンパイラのパート固定割り当て。fmgen `ch[]`配列上のindexは0-5でFM1-6と連番(PMD側と同じ) |
| 6-8 | SSG 1-3 | D,E,F | |
| 9 | リズム(6音の最大値) | G | ただし本フォークは構造的に常に0(後述) |
| 10 | ADPCM | K | |
| 11-18 | PPZ8 1-8 | (無し) | MUCOMにPPZ8チャンネルは存在しないため、5フィールド全て常に0 |

track対応(`MucomWeb.cpp`の`LevelToTrack[]`)はMUCOMコンパイラのパート
固定割り当て(`upstream/MucomWeb/mucom88/src/cmucom.h`の
`MUCOM_CH_FM1=0`/`MUCOM_CH_PSG=3`/`MUCOM_CH_RHYTHM=6`/`MUCOM_CH_ADPCM=10`)
と一致する。PMD側`build_levels()`はindex9(リズム)の`t`を明示せず暗黙に
FM1を流用する上流の癖があるが、MUCOMには実在するリズム専用パートGがある
ため、そちらを使うほうが正確と判断し、あえて同じ癖は再現していない。

### フィールド(1chあたり5つのint32、PMD側と同じ意味)

- `level`: fmgenへ追加したpeak-holdの値。0が無音、大きいほど大
- `pan`: PMD側`build_levels()`と同じ`table[4]={5,4,0,2}`変換
  (`docs/mucom-pchdata-mapping.md`で実測済みのFM/ADPCM pan register bit
  との一致を流用)。**鳴っていないチャンネルは`pan=5`固定**(PMD側と同じ
  上書き仕様、`fmdsp-pacc.c`の`if (!playing) levels[c].pan = 5;`をそのまま
  再現)。SSG(6-8)とリズム(9)はcmucom.cppが`pan=3`を無条件に返す実装
  (レジスタを読んですらいない)に合わせ、rawpan=3固定として扱う
- `prog`: 対応trackの`vnum`
- `key`: 対応trackの`code`に`+0x10`(MUCOM内部オクターブは0始まり、PMDは
  1始まりのためオクターブぶんを補正)、休符時(`fnum1==0 && fnum2==0`)は
  下位4bitを0xFへ上書き。`mucomweb/html/adapter.js`の既存key計算と同じ式
- `playing`: FM(0-5)とADPCM(10)は`mucomvm::GetChStatus()`(レジスタ由来、
  リアルタイム)を使う。SSG(6-8)とリズム(9)には対応するchstat[]が
  存在しない(`adapter.js`の`CH_TO_CHSTAT`コメント参照)ため、代わりに
  今回追加した実測`level`(>0か)を「今鳴っているか」の判定に使う。
  これはPMD側の`track_status[].playing`より一段直接的で、sticky近似より
  正確(レベル自体が実際の音声出力そのものであるため)

### リズム(index9)が常に0であることについて(パッチ起因ではない既知の制約)

`mucomvm::InitSoundSystem()`が`opn->Init(baseclock, 8000, 0)`と3引数で
`OPNA::Init()`を呼んでおり、4番目の`rhythmpath`引数(デフォルト`nullptr`)を
一度も指定していない。そのため`OPNA::RhythmMix()`の
`if (rhythmtvol < 128 && rhythm[0].sample && ...)`ガードが常に`false`で
早期returnし、**このMucomWebフォークはビルド全体を通じてリズムPCM
サンプルを一度もロードしない**(実機YM2608のリズムサンプルROMデータを
このOSSフォークが同梱していないため)。これは今回のパッチが原因ではなく、
MucomWeb全体の既存の構造的制約。`UpdateRhythmLevel()`自体は正しい位置
(サンプル計算直後)に差し込まれているため、将来リズムサンプルが
ロードされるようになれば正しく動作する。

### チャンネル対応表(実測)

`tools/verify_right_pane_data_mucom.mjs`の(b)チェックで、1パートだけ
鳴らすMMLを使い「鳴らしたパートに対応するindexだけが非0」を実測確認した
(推測ではなく実測、過去に「ビット割当を推測して1024x848が212ラインに
なった」失敗があるため)。

| MMLパート | note | index | 実測level(参考値) |
|---|---|---|---|
| A(FM1) | `@1o4c1` | 0 | 75 |
| B(FM2) | `@1o4c1` | 1 | 75 |
| C(FM3) | `@1o4c1` | 2 | 75 |
| H(FM4) | `@1o4c1` | 3 | 75 |
| I(FM5) | `@1o4c1` | 4 | 75 |
| J(FM6) | `@1o4c1` | 5 | 75 |
| D(SSG1) | `@4v10o4c1` | 6 | 406 |
| E(SSG2) | `@4v10o4c1` | 7 | 406 |
| F(SSG3) | `@4v10o4c1` | 8 | 406 |
| G(リズム) | `@8 v52,21,21,21,20,21,21 l16c1` | 9 | 0(常に。上記参照) |
| K(ADPCM) | `#pcm <mucompcm.bin>` + `@1v50o1l16c1` | 10 | 121 |

SSG(D,E,F)は`@4`(SSG用音色)を明示しないと無音のまま
(`tools/probe_mucom_pchdata.mjs`のコメントにある「@省略で鳴らない」罠と
同種)。ADPCM(K)は`#pcm`ディレクティブでPCMデータを実際に読み込まないと
KeyOnが起きない(`docs/mucom-pchdata-mapping.md`既知の制約と同じ)ため、
検証スクリプトは`upstream/MucomWeb/mucom88/package/mucompcm.bin`
(既存パッケージ同梱アセット、無改変)を絶対パスで指定している。

### 検証

`tools/verify_right_pane_data_mucom.mjs`のレベルメーター系チェック:

- (a) 各levelが非負、無音時は全19chが0
- (b) 上記チャンネル対応表どおり、1パートだけ鳴らすと対応indexだけが非0
  (リズムは常に0が期待値として別扱い)
- (c) 音量を変えるとlevelが変わる(`v1`と`v15`でFM1のlevelが約27倍differ、
  v1=255 vs v15=6868)
- (d) `getSnapshotLevelOffset()`/`getLevelCount()`/`getLevelFieldCount()`と
  `getSnapshotEntryByteSize()`の整合性
- **故障注入**: `MucomWeb.cpp`の`PushSnapshot()`内`BuildLevels(snapshot, vm);`
  呼び出しを一時的にコメントアウトして再ビルドし、(b)(c)の合計19件が
  単独でFAILすることを確認してから元に戻した。実施記録は
  `docs/verify_right_pane_data_mucom_fault_injection_log.txt`参照

### ビルド上の変更点

- `mucomweb/patches/0002-fmgen-leveldata.patch`: fmgen本体
  (`opna.h`/`opna.cpp`/`psg.h`/`psg.cpp`)へのピーク追従差し込みと、
  `mucomvm.h`への`GetOpna()`読み取り専用アクセサ追加。`mucomweb/CMakeLists.txt`
  が0001と同じ仕組み(`git apply --reverse --check`で冪等判定、失敗時は
  警告でなくビルド失敗)で自動適用する
- `mucomweb/src/MucomWeb.cpp`: `LevelStatus`構造体・`BuildLevels()`・
  export(`getSnapshotLevelOffset`/`getLevelCount`/`getLevelFieldCount`、
  PMD側と同じ命名)を追加

## 7. PMD側のPASSED TIME/CLOCK COUNT/TIMER B CYCLE/LOOP COUNT/回転円(2026-08-14)

PMD側では長らく、これらのカウンタに対応するwasm exportが存在せず(旧実装)、
`html/pmd-app.js`が全て0/falseを渡していた。そのため描画層(`fmdsp/rightpane.js`)は
正しいのにPLAY表示だけが切り替わり、数値と回転円が全く動かないという不具合が
あった。原因は「データが来ていない」ことであり、描画側の実装は無変更で直せる
(`fmdsp/`は今回も一切変更していない)。

### 何が取れて何が取れないか

出典は `upstream/98fmplayer/fmdriver/fmdriver.h` の `struct fmdriver_work`。
実装を読んで確認した結果、必要な項目は**全て取得できる**(でっち上げが必要な
項目は無かった):

| FMDSP表示項目 | 元データ | 取得可否 |
|---|---|---|
| PASSED TIME(経過時間) | `struct status_snapshot.frame`(既存。`opna.generated_frames`そのもの) | **既存フィールドで取得済み**(新規追加不要。fmdsp-pacc.cのpassed time計算`update_default()`:1502が使うのと同一の値) |
| CLOCK COUNT | `work->timerb_cnt` | **取得できる**(新規追加) |
| TIMER B CYCLE | `work->timerb` | **取得できる**(新規追加) |
| LOOP COUNT | `work->loop_cnt` | **取得できる**(新規追加) |
| ループ進捗バー | `work->timerb_cnt_loop` / `work->loop_timerb_cnt` | **取得できる**(新規追加) |
| 回転円(drawCircle) | `work->timerb_cnt`(CLOCK COUNTと同じ値を`/8%8`) | **取得できる**(CLOCK COUNTと共用) |
| CPU POWER COUNT | プロセスCPU使用率(ブラウザにAPI無し) | **取得できない**(下記§8参照。CPU側は暗色描画に固定) |
| FRAMES PER SECOND | ホスト側描画ループの実測(wasm export不要) | **2026-08-16実装**。下記§8参照 |

MUCOM側(`mucomweb/src/MucomWeb.cpp`)は`passTick`(`vm->time_master`)から
経過時間を逆算する必要があったが、PMD側は`frame`フィールド自体が既に
`opna.generated_frames`(55467Hz換算のサンプル数)であり、これは
`fmdsp-pacc.c`のpassed time計算がそのまま使う値と同一のため、変換が一切不要。

### スナップショットへの配線

`struct status_snapshot`の`frame`に続けて、`timerb_cnt`/`timerb`/`loop_cnt`/
`timerb_cnt_loop`/`loop_timerb_cnt`(いずれも`uint32_t`)を追加した
(`pmdweb/src/PmdCore.c`)。既存の`_Static_assert`によるレイアウト固定の作法を
そのまま踏襲しており、レイアウトを崩すとビルドが落ちる。

```
struct status_snapshot {
  uint32_t frame;
  uint32_t timerb_cnt;
  uint32_t timerb;
  uint32_t loop_cnt;
  uint32_t timerb_cnt_loop;
  uint32_t loop_timerb_cnt;
  struct flat_track_status tracks[TRACK_COUNT];
  uint8_t  fft[72];
  struct flat_level_status levels[19];
};
```

`push_snapshot()`(ドライバ割り込みのたび、`driver_interrupt()`経由で呼ばれる)で
`g_player.work`から直接コピーしているだけで、独自のポーリングや平均化は
一切していない。

frameに続くヘッダのワード数(=6)は`getSnapshotHeaderWordCount()`で export し、
JS側がハードコードしなくて済むようにした(`mucomweb`の同名exportと同じ命名。
MUCOM側は`frame+passTick/intCount/maxCount+chstat[16]`で20ワードなのに対し、
PMD側はchstat相当が無いぶん6ワードで済む)。`html/pmd-app.js`はこの値を使って
トラック配列のオフセットを計算しており、ヘッダのワード数を変えても
JS側の修正は不要。

### 同期(リング経由)について

表示はスナップショットリングをframe基準で二分探索して引き当てている
(`docs/sync-design.md`)。カウンタ類も**必ずこのリング経由で読む**(現在値を
直読みしない)ことで、既存の同期を壊していない。

### 検証

`tools/verify_pmd_timerb_counters.mjs`(Node直接実行)で以下を確認した:

- 回転コマ(`floor(timerbCnt/8)%8`)が時間とともに変化する(停止中は変化しない
  ことも対照として確認)
- 経過時間(`frame/55467`秒)がNode側で制御した累積レンダリングフレーム数と
  一致する。ただし`frame`はOPNAタイマーB割り込みのたびにしか更新されない
  (毎サンプルではない)ため、最大で1割り込み周期ぶん(実測で数百フレーム、
  10ms未満)遅れる。この遅延は既存のtrack_status等のスナップショットも
  同じ構造で持っており、`sync-design.md`の二分探索設計はこれを前提にしている。
  遅延が時間とともに拡大しないことも確認した
- ループする曲(`upstream/pmdmini/PC-98_Hartmann_s_Youkai_GIrl.M`、ローカル
  検証専用でdist配信には含まれない)で`loopCnt`が実際に増える(1周約155秒)
- **故障注入**: `push_snapshot()`内の`snapshot->timerb_cnt = g_player.work.timerb_cnt;`
  を一時的に`snapshot->timerb_cnt = 0;`へ変更して再ビルドし、回転コマの変化
  検出と`timerbCnt`単調増加の検査が単独でFAILすることを確認してから元に戻した

ブラウザでの実測(`?driver=pmd&debug=1`、`sample_fur_elise.M`再生)でも、
壁時計(`AudioContext.currentTime`)9.494s時点でPASSED TIME表示が`00:09.30`
(`frame/55467=9.305s`)、30.392s時点で`frame/55467=30.216s`となり、
20.9秒の壁時計経過に対し経過時間表示も20.911秒進んでいる(slope誤差0.005%)。
同時に`loopCnt`が0→4へ実際に増加することも確認した。オフセット(約0.18-0.23秒、
AudioWorkletの出力レイテンシ相当)はMUCOM側の実測(§ドキュメント
`docs/mucom-pchdata-mapping.md`)と同じ構造。

### MUCOM側の回帰

`fmdsp/`・`mucomweb/`は一切変更していない。ブラウザで`?driver=mucom`を開き、
PASSED TIME/CLOCK COUNT/回転円が引き続き正常に動作すること、
`tools/verify_right_pane_data_mucom.mjs`がALL PASSすることを確認した。

## 8. CPU POWER COUNT/FRAMES PER SECOND/VOLUME DOWN/PGM NUMBER(2026-08-16)

上の表(§7)の「CPU POWER COUNT / FRAMES PER SECOND | 対応するwasm export無し |
取得できない。0のまま」という記述は誤りだった。実装前に4項目それぞれの取得可否を
調べ直した結果は次のとおり:

| 項目 | 取得可否 | 理由 |
|---|---|---|
| FRAMES PER SECOND | **取得できる(実装済み)** | 上流`fmdsp_fps_30()`(`upstream/98fmplayer/fmdsp/fmdsp_platform_unix.c:29`)はwasmや音源と無関係に、ホスト側の描画呼び出し頻度を30フレームぶん数えているだけの値。本Web版でも同じ意味の値(描画ループ=`updateChannelStatus()`のrAF実測頻度)を`fmdsp/rightpane.js`の`createFpsCounter()`/`tickFpsCounter()`で数えられる。wasm exportは一切不要 |
| CPU POWER COUNT | **恒久的に取得できない** | 上流は`times(2)`(POSIX)でプロセスのCPU時間を取得している。**wasm exportの有無の問題ではなく**、ブラウザにはプロセス/タブ単位のCPU使用率を取得するAPIが存在しない(Performance APIにも同等のものは無い)。旧コメントの「対応するwasm exportが無い」は原因の説明として不正確だった |
| VOLUME DOWN | **取得できない** | 上流(`fmdsp-pacc.c`・GDI版`fmdsp.c`のどちらも)、この項目の**値**を描くコードが存在しない(ラベルのみ)。元データ候補の`pmd->fm_voldown`/`ssg_voldown`/`adpcm_voldown`/`opnarhythm_voldown`/`ppz8_voldown`(`upstream/98fmplayer/fmdriver/fmdriver_pmd.h:352-450`)はPMDドライバ**内部**構造体限定のフィールドで、fmdsp/wasm側が読める共通インタフェース(`struct fmdriver_work`、`upstream/98fmplayer/fmdriver/fmdriver.h:77-141`、grep -n "voldown" で該当なしを確認済み)には含まれない。本Web版のwasm export(`pmdweb/src/PmdCore.c`/`mucomweb/src/MucomWeb.cpp`)にも対応するexportは無い(grep -rn "voldown" で0件)。MUCOM88側(`upstream/MucomWeb/mucom88/src/`)にはそもそも同名の概念自体が存在しない(grep -rn "voldown" で0件) |
| PGM NUMBER(依頼メモでは「BGM NUMBER」表記) | **取得できない** | VOLUME DOWNと同じく、上流のどちらの描画実装にも値を出すコードが無い。加えて`struct fmdriver_work`/PMDドライバ内部構造体のどちらにもそれらしいフィールドが見当たらず(fmdriver_pmd.hを全文確認)、何を指す項目なのか上流自身が実装した形跡が無い(ラベルだけ置かれた未使用スロットの可能性が高い) |

### 実装

- `fmdsp/rightpane.js`: `createFpsCounter()`/`tickFpsCounter()`(DOM非依存の純粋関数、
  `tools/verify_fps_counter.mjs`でNode単体テスト可能)を追加。`drawCpuFps()`は
  FPS引数をそのまま数字スプライトへ(通常のblitCopy、上流と同じ意匠)、CPU側は
  常に`COLOR_UNAVAILABLE`(=`COLOR_3`)で強制的に塗り直す(値自体は0のまま渡している
  が、表示は「桁の形はあるが暗色」で「この項目は無い」と読めるようにする。
  0という値そのものを見せない)
- `drawCpuFpsLabels()`のCPU側ラベル/下線/三角、`drawTimeLabels()`のVOLUME DOWN/
  PGM NUMBERのラベル/下線/三角も同じ`COLOR_UNAVAILABLE`にした(値の項目
  (PASSED TIME等)は`COLOR_2`のまま据え置き、ラベルの色だけでも「値が出ない
  項目」だとひと目で区別できるようにする)
- `html/pmd-app.js`・`html/mucom-app.js`: `updateChannelStatus()`(rAF駆動の
  描画ループ本体)の先頭で`tickFpsCounter()`を呼び、その戻り値を
  `rightpane.drawDynamic()`の`fps`引数へ渡す

### 検証

`tools/verify_fps_counter.mjs`: 60Hz/30Hz相当の合成タイムスタンプ列でfps値が
妥当な範囲になること、1秒未満の経過では値が更新されないこと、elapsed=0の
連発・NaN/Infinity・時刻の巻き戻りを注入してもクラッシュせず有限値を保つこと
を確認(過去に「自動ブラウザのrAFは0回のことも59.97Hzのこともある」実測が
あるため、ブラウザのrAFを信頼せずロジック自体をNode上で検証する方針)。

`tools/verify_right_pane_unavailable_colors.mjs`: CPU数字桁が暗色のみ
(色2を含まない)で構成される一方、FPS数字桁は通常描画のまま(素のスプライトの
色2を含む)ことを対照させて確認。VOLUME DOWN/PGM NUMBERラベルが暗色のみである
一方、PASSED TIME(値がある項目)は暗色化されていないことも確認。
