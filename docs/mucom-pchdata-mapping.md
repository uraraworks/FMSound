# MUCOM88 PCHDATA -> flat_track_status 対応表

MUCOM88 の演奏状態(`PCHDATA`, Z80ワークエリア38バイトのデコード結果)を、
FMDSP共通スキーマ `flat_track_status`(`pmdweb/src/PmdCore.c` の `flatten()`, 26フィールド)
へ写すための対応表。**Z80ドライバのasmはMucomWebフォルク側で空ファイルのため読めない。
よってこの文書の内容はすべて `tools/probe_mucom_pchdata.mjs` による実測、または
`upstream/mucom88/src/cmucom.cpp` / `mucomvm.cpp`(C++側のVM実装。asmではない)の
直接参照のいずれかであり、出典を明記する。** 未解明の項目は「未解明」と明記する。

実行方法: `node tools/probe_mucom_pchdata.mjs` (再実行可能。PASS/FAIL表を出力する)

## 0. 実測の前提(ハマった点)

- `compileMML()` で `@<voice>` を省略すると(デフォルト音色のまま)FM/SSGパートは
  PCHDATAを一切更新しない(全フィールド0のまま)。G(リズム)/K(ADPCM)は`@`省略でも動く。
  実測: `tools/probe_mucom_pchdata.mjs` Phase 1。
- コンパイル直後に少数フレームだけレンダリングしてもPCHDATAは更新されない。
  44100Hzで 14336フレーム(約325ms)まではまだ0、16384フレーム(約372ms)から
  確実に値が入ることを実測で確認した。本ツールは安全マージンを見て
  20480フレーム(約464ms)をデフォルトにしている。
- Node環境では `StreamingPlayer::Play()` 内で `AudioContext` が無く例外になるため、
  `Module.audioWorkletRequest(frames, generation, requestId)` を手動で呼んでレンダリングを
  進める。`generation` は fresh instance であれば1回目のcompile後は必ず`2`になることを
  実測で確認済み(`mucomweb/src/StreamingPlayer.cpp` の `Play()`→`Stop()`→
  `MucomWeb.cpp` の `CompileMML()` 内の明示`Stop()`で、2回ずつ`_generation`が進む)。
- wasm側のC++は変更していない。既存exportのみで測定した。

## 1. ch index <-> MML パート文字(A-K)の対応 【実測】

事前予想は「A-F=FM1-6(ch0-5) / G=リズム(ch6) / H-J=SSG1-3(ch7-9) / K=ADPCM(ch10)」
だったが、**実測の結果、予想は外れた**。正しくは:

| パート文字 | ch index | 音源 |
|---|---|---|
| A | 0 | FM1 |
| B | 1 | FM2 |
| C | 2 | FM3 |
| D | 3 | SSG1 |
| E | 4 | SSG2 |
| F | 5 | SSG3 |
| G | 6 | リズム |
| H | 7 | FM4 |
| I | 8 | FM5 |
| J | 9 | FM6 |
| K | 10 | ADPCM |

つまり **A-Kはそのままch0-10に対応する**(パート文字のアルファベット順=ch index順)。
FMは前半(A-C)と後半(H-J)に分割されており連続していない。

裏付け: `upstream/mucom88/src/cmucom.cpp:2255-2333` の `GetChannelData()` 内の
`switch(ch)` 文でも `MUCOM_CH_FM1=0, MUCOM_CH_PSG=3, MUCOM_CH_RHYTHM=6, MUCOM_CH_FM2=7,
MUCOM_CH_ADPCM=10`(`cmucom.h:24-28`)というハードコードされた定数と一致する
(このC++コードはVMのホスト側実装であり、Z80アセンブラそのものではないが、
チャンネル番号の意味を確定させる一次情報として使える)。

陽性対照: なし(この項目は「文字通りの直接対応」という単純な仮説のため、
誤りうる別解釈を作りにくかった。事前予想との不一致自体が「当てずっぽうでは
当たらない」ことの証拠になっている)。

## 2. 音程 【実測・FM/SSGとも式が確定】

`code`(BEFORE CODE, `cmucom.h:331`)と `keyon`(実体は生バイトのraw copy。
`cmucom.h:336`のコメントでは元々「あき」領域を流用しているとある)の両方が、
以下の式で **FM・SSGとも同一の式** によりオクターブ・音名を保持していることを
o1-o8 × 半音12個(計96通り)の全数実測で確認した。

```
noteIdx: c=0, c+=1, d=2, d+=3, e=4, f=5, f+=6, g=7, g+=8, a=9, a+=10, b=11

code  = ((octave - 1) << 4) | noteIdx     // 0x00-0x7B
keyon = (octave - 1) * 12 + noteIdx        // 0-95 (絶対半音番号)
```

PMDの `key = (octave<<4)|notenum` と比べると、**オクターブ部分が1小さい
(MUCOM側は内部オクターブが0始まり)** という違いがある。`flat_track_status.key`
形式に変換する際は `((mucom_octave) << 4) | noteIdx` = `code + 0x10` とすればよい
(実測はしていないが式変形として自明)。

休符判定: `code===0` は **oct1,cの実音と衝突する**(どちらも0x00になる)ため、
`code`単体では休符と実音を区別できない。**`fnum1===0 && fnum2===0` を併用すると
確実に区別できる**(FM/SSGとも実測した全96音でfnum1が0になるケースは無かった)。
実測: `tools/probe_mucom_pchdata.mjs` Phase 3。

陽性対照: オクターブのシフト量を意図的に1つずらした誤った式
`code = (octave<<4)|noteIdx`(シフト無し)を検証し、**全96件でFAILすることを確認した**
(Phase 2の出力: `[PASS] FM: 陽性対照(オクターブを+1ずらした誤った式)は不一致(FAILするはず)`)。

独立検証(sampl1.muc, 測定に使っていない実MML): part A(ch0)冒頭の
`e8r4.r4edc8 d8.g&g2 g8f8e4r4 r4cde8e8.f8.c8 c8.d8r<g8>`(o6基準)を実際に
再生し、`code`の遷移列を音名にデコードしたところ
`o6e,o6d,o6c,o6d,o6g,o6f,o6e,o6c,o6d,o6e,o6f,o6c,o6d,o5g` となり、
MML上の音名列(タイ`&`による重複・休符・オクターブ変更`<`込み)と完全一致した。
実測: `tools/probe_mucom_pchdata.mjs` Phase 5。

### fnum1 / fnum2 の意味

- **FM**: 同じ音名ならオクターブが変わっても `fnum1` は不変、`fnum2` はオクターブ毎に
  ちょうど+8される(実測、96件全て)。これはYM2203のF-Number/Block registerの典型的な
  ビット配置(block(3bit)をbit3-5に、F-Numberの上位3bitをbit0-2に同居させたレジスタが
  `fnum2`、F-Numberの下位8bitが`fnum1`)と整合する挙動だが、**このビット配置そのものを
  実測で分解して確認したわけではない**(fnum2の値からblock/上位3bitを分離する検証は
  未実施。「+8ずつ増える」という外形的な挙動のみ確認済み)。
- **SSG**: `fnum1`/`fnum2`は **オクターブに依存せず音名だけで決まる**(実測、96件全て
  同一音名ならオクターブ1-8で完全に同一値)。SSGの周期レジスタは本来オクターブごとに
  半分になるはずなので、この2フィールドは「オクターブ基準の相対値」であり、
  Z80ドライバが実際にハードウェアへ書き込む際にオクターブ分だけ別途シフトしている
  と考えられる。**そのシフト後の絶対値はPCHDATAのどこにも保存されていないため、
  SSGの絶対音程をfnum1/fnum2から復元することはできない(未解明・測定不能)**。
  SSGの音程が必要な場面では `code`/`keyon` を使うこと。

## 3. flag 【部分的に実測、大半は未解明】

ヘッダコメント(`cmucom.h:322-329`):
```
bit 7 = LFO FLAG
bit 6 = KEYOFF FLAG
bit 5 = LFO CONTINUE FLAG
bit 4 = TIE FLAG
bit 3 = MUTE FLAG
bit 2 = LFO 1SHOT FLAG
bit 0,1 = LOOPEND FLAG
```

実測結果:

| 状態 | flag(2進) | 備考 |
|---|---|---|
| 演奏中(ノート持続中) | `0b01000000` (0x40, bit6) | |
| 休符中 | `0b01000000` (0x40, bit6) | 演奏中と同じ |
| タイ直後 | `0b01000000` (0x40, bit6) | 単発ノートと同じ値で、タイ特有のbit変化は確認できなかった |
| 曲全体が終了した後 | `0b01000001` (0x41, bit6+bit0) | bit0が追加で立つ |
| そのパートを一度も使わない曲 | `0b01000001` (0x41, bit6+bit0) | 曲終了後と同じ値 |

**bit6は「演奏中」「休符中」「タイ直後」のいずれでも常に1**であり、ヘッダコメントの
「KEYOFF FLAG」という名前が示唆する意味(キーオフされた時だけ1)とは一致しなかった。
命名と実測挙動が食い違っている、もしくは測定条件(20480フレーム=約464ms後の
1点しか読んでいない)がタイミングを外している可能性があり、**bit6の正確な意味は
未解明**。bit0(LOOPEND FLAGの下位ビットと推測)は「曲が最後まで到達した」場面で
確かに追加で立ったが、1サンプルのみでの確認であり、ループ回数など他の要因での
変化は検証していないため、これも**確定とまでは言えない(推測が実測と整合した、
というレベル)**。

bit7(LFO)/bit5(LFO CONTINUE)/bit4(TIE)/bit3(MUTE)/bit2(LFO 1SHOT)は
**未測定・未解明**(LFO命令やM(ソフトエンベロープ)命令を使ったMMLでの測定が必要だが、
本タスクのスコープでは実施していない)。

「休符」と「未使用パート」を`flag`だけで区別する方法は見つからなかった
(両方とも`code=0, fnum1=0, fnum2=0`になり、`flag`も曲終了後の休符と未使用パートで
同じ値になるケースがあった)。**`length`フィールドで休符(減衰していく値)と
未使用パート(255=初期値のまま)を区別できる可能性があるが、1サンプルのみの
確認であり、確実な判別式として採用するには追加測定が必要(未解明)**。

## 4. volume / quantize / detune / length 【実測・確定】

`v10 q4 D-18`, `v5 q7 D20`, `v0 q0 D0` の3パターンで確認(FM、part A、ch0)。

- **quantize**: MMLの`q`の値をそのまま反映する(変換なし)。実測3件一致。
- **vol_org**: MMLの`v`の値をそのまま反映する。`cmucom.cpp:2318`
  `vol_org = result->volume - 4; if (vol_org < 0) vol_org = 0;` という既存ソースの
  計算式とも整合する。実測3件一致。
- **volume**: `vol_org + 4`。ソース側コメントの計算式の逆算で、`v=0`のケースは
  `vol_org`側で0にクリップされるため厳密な逆算検証はできなかったが、`v=5,v=10`の
  2件では式が厳密に一致した。
- **detune**: 符号付き16bitとして解釈すれば(`value > 32767` なら `value - 65536`)
  MMLの`D`の値と一致する(`D-18`→65518→-18、`D20`→20、`D0`→0の3件で確認)。
  `cmucom.cpp:2286` で `result->detune = srcp[9] + (srcp[10] << 8);` という
  16bit結合が明示的に行われている箇所と整合する。
- **length**: MMLの`l`(音長)コマンドが直接どの値に対応するかは、今回のテストでは
  検証していない(quantize/volume/detuneのみを対象にした)。`length`フィールド自体は
  Phase 3で「LENGTH COUNTER」として観測しており、ノート再生中は徐々に減っていく
  カウンタ値であることは確認したが、**`l`コマンドの値とlengthフィールドの初期値の
  対応式は未解明**。

- **vnum / vnum_org**: `vnum`は今回のテストでは常に`0`だった(単一音色のみ使用する
  MMLしかテストしていないため、複数音色を使い分けるMMLでの検証が必要。未解明)。
  `vnum_org`は`cmucom.cpp:2323` `v_orig = ext_fmvoice[result->vnum] - 1` の計算式により
  FM音色テーブル経由の値になっており、今回のテストでは`@1`指定時に常に`1`だった
  (これは「FM音色ファイルの1番目のエントリ」を指しているだけで、MMLの`@1`という
  数値と偶然一致しているだけの可能性がある。`@`の値とvnum_orgの対応式そのものは
  未解明)。

## 5. 「演奏中かどうか」の判定材料 【未解明】

FMDSPの`playing`(`pmdweb/src/PmdCore.c:276` `target.playing = source->playing;`、
PMD側はドライバが直接boolを持っている)に相当する単一のフィールドはMUCOM側には
見当たらなかった。試した組み合わせ:

- `code!==0 || fnum1!==0`: 「その曲でそのパートが一度でも音を出したか」の判定には
  使えそうだが(未使用パートは常に0のまま)、「今この瞬間鳴っているか」までは
  判定できない(休符中も同じく0になるため、休符中と未使用パートの違いは別途必要)。
- `length`: 曲終了後や未使用パートで`255`(初期値)、休符中は`110`のような値だった
  ことから、「未使用パート」と「休符中」の切り分けに使えそうな兆候はあるが、
  1サンプルのみでの観測であり確証がない。
- `flag`のbit0(曲終了で追加点灯)は「曲全体が終わったかどうか」の判定材料には
  なりそうだが、パート単位で「今このパートだけ演奏を終えた」かどうかを
  判定できるかは未検証。

**結論: PCHDATAのどのフィールド(の組み合わせ)が「演奏中」判定に使えるかは、
本タスクのスコープでは確定できなかった。追加の測定(曲の途中で特定パートだけ
演奏が終わるMML、ループのあるMML、複数パートが異なるタイミングで
開始・終了するMML等)が必要。**

## 6. PCHDATA -> flat_track_status 写像(設計案)

`flat_track_status`(26フィールド、`pmdweb/src/PmdCore.c:37-43`)側の対応。
**実測で確定した項目のみ「対応あり」とし、それ以外は暫定/未定とする。**

| flat_track_status | 型 | MUCOM PCHDATA 由来 | 状態 |
|---|---|---|---|
| `playing` | int32 | (§5参照。単一フィールドでの判定式が未確定) | **未解明** |
| `info` | int32 | 対応物なし。MUCOMに相当する概念が無い | 常に0で埋める(暫定) |
| `ticks` | int32 | 対応物候補なし | **未解明** |
| `ticks_left` | int32 | `length`(LENGTH COUNTER)が候補だが式は未検証 | **未解明** |
| `key` | int32 | `code + 0x10`(§2参照。オクターブの基準が1違うだけなので式変形は自明だが、この変換自体は未実測) | 実測は`code`のみ。変換式は未検証 |
| `actual_key` | int32 | 対応物候補なし(LFOやデチューン後の実効音程が必要ならdetune等と合成が要るはずだが未検証) | **未解明** |
| `tonenum` | int32 | `vnum`(音色番号) | 実測は常に0だったため式の妥当性のみ(直接対応で問題ないと推測) |
| `volume` | int32 | `vol_org`(§4参照。MMLの`v`値そのもの) | 実測・確定 |
| `gate` | int32 | `quantize`(§4参照) | 実測・確定 |
| `detune` | int32 | `detune`(符号付き16bit解釈。§4参照) | 実測・確定 |
| `status[9]` | int32×9 | 対応物なし(PMD固有のFM音源レジスタダンプ) | 常に0で埋める(暫定) |
| `fmslotmask[4]` | int32×4 | 対応物なし(PMD固有) | 常に0で埋める(暫定) |
| `ppz8_ch` | int32 | 対応物なし(MUCOMにPPZ8相当は無い) | 常に0で埋める(確定方針) |
| `ssg_tone` | int32 | SSGパート(ch3-5)の`code`/`keyon`から導出可能と推測されるが、fnum1/fnum2は使えない(§2参照) | **未解明**(導出式は未検証) |
| `ssg_noise` | int32 | 対応物候補なし | **未解明** |

方針:
- **PPZ8関連(`ppz8_ch`)は常に0で埋める**: MUCOM88にADPCM(K, ch10)はあるが
  PPZ8(SSG拡張PCM)相当の機能は無いため、これは確定方針としてよい。
- **`status[9]`/`fmslotmask[4]`はPMD固有のFM音源レジスタダンプで、MUCOM側に
  直接対応するものが無い**。常に0で埋めるか、そもそもFMDSP描画側で
  MUCOM用の代替描画パスを分けるか、次のステップでの判断が必要。
- **`playing`/`ticks`/`ticks_left`/`actual_key`/`ssg_tone`/`ssg_noise`は
  本タスクでは未解明のまま残った**。パート行(`KN:o4C`表示・鍵盤ハイライト)を
  作るだけであれば`key`(=`code`変換)と休符判定(`fnum1===0 && fnum2===0`)だけで
  最低限は足りるはずだが、「演奏中/停止中」の表示や`ticks`系のプログレス表示までは
  今回の実測だけでは実装できない。

## 7. 未解明のまま残った項目(まとめ)

- `flag`のbit7(LFO)/bit5(LFO CONTINUE)/bit4(TIE)/bit3(MUTE)/bit2(LFO 1SHOT)の意味
- `flag`のbit6の正確な意味(ヘッダコメントの「KEYOFF FLAG」と実測が食い違う)
- 「休符」と「未使用パート」を確実に区別する式
- 「演奏中かどうか」を判定する単一の式(§5)
- `length`(LENGTH COUNTER)とMMLの`l`(音長)コマンドの対応式
- `vnum`/`vnum_org`とMMLの`@`(音色番号)の正確な対応式(複数音色を使うMMLでの検証が必要)
- SSGの`ssg_tone`/`ssg_noise`相当値の導出式
- FMの`fnum2`の内部ビット配置(block/F-Number上位3bitの分離)

## 8. 実装(`mucomweb/html/adapter.js` / `mucomweb/html/index.html`)【2026-08-14】

上記の設計案(§6)を元に実装した確定版。ソースは `mucomweb/html/adapter.js`
(コメントに根拠を書き込んである)。差分・追加のみここに記す。

- **チャンネル→FMDSPスロット対応**: §1実測どおり
  `{0:0,1:1,2:2, 7:6,8:7,9:8, 3:9,4:10,5:11, 10:12}`。ch6(リズム)は
  左10行パートに対応する表示行が無いため写像先なし。
- **key/actual_key**: `code+0x10`(§2実測)。休符(`fnum1===0 && fnum2===0`)
  時は下位4bitを`0xF`に上書き。`actual_key`は`key`と同値(LFO/ベンド適用後の
  実効値に対応するMUCOM側フィールドが無いため。未解明のまま)。
- **volume/gate/detune/tonenum**: `vol_org`/`quantize`/`detune(符号付き16bit)`/`vnum`。
  いずれも§4実測どおりで、近似ではなく直接対応。
- **`playing`(近似・sticky)**: 「この曲でそのパートが一度でも
  `code!==0 || fnum1!==0`を出したか」を曲コンパイル毎にリセットされる
  stickyフラグとして保持。**実機テスト(sampl1.muc)で判明した既知の限界**:
  ADPCM(ch10, Kパート)は再生中もPCHDATAの`code`/`fnum1`が常に0のままであり、
  この近似では常に「未使用パート」(`playing=false`、パート行は`S`表示)と
  誤判定される。ADPCMは音程をFM/SSGと同じcode/fnumの仕組みで表現していない
  (`cmucom.cpp`のADPCM分岐は`chwork`からpan/volを作るだけで、code/fnumに
  関する処理が無い)ためで、単純な取り違えではなく構造的な限界。
  ADPCM用に別のplaying判定式を作る調査は今回のスコープでは実施していない
  (**未解明として残す**)。FM/SSGの各パートについては実測(スクリーンショット、
  下記§9参照)でsticky近似が実際に機能していることを確認済み。
- **`ticks`/`ticks_left`(近似)**: `ticks_left`は`length`(LENGTH COUNTER)を
  そのまま使用。`ticks`は「直前のノート開始(=keyの変化を検出したタイミング)
  以降に観測した`length`の最大値」で代用(対応物なし)。より素性の良い取り方は
  見つからなかった。
- **info/status[9]/fmslotmask[4]/ppz8_ch/ssg_tone/ssg_noise**: すべて0固定
  (対応物なし、§6の方針どおり)。
- **右半分(レベルメーター、PROG/KEY/PAN列)**: `fmdsp/rightpane.js`の
  `drawLevelMeters`をそのまま使用。levelバー本体とFFTスペクトラムは
  leveldata相当のexportがMUCOM側に無いため常に0(空)。PROG(`tonenum`)/
  KEY(`key`)/PANPOTはFM1-6・SSG1-3・ADPCM(LEVEL_COUNT配列のindex0-8,10)を
  PCHDATAから埋めた。RHYTHM(index9)とPPZ8(index11-18)は元々`rightpane.js`側が
  PROG/KEY非表示、またはMUCOM88に対応機能が無いため空のまま(PPZ8は確定方針、
  RHYTHMはPMD側と同じ理由による既存の仕様)。
  - **PANPOTの変換式**: OPNAのL/R選択2bit(`chwork & 0xc0`ないし`chwork & 3`。
    §未掲載だが`cmucom.cpp:2346-2360`参照)を、PMD側`pmdweb/src/PmdCore.c`
    `build_levels()`と同じ`table[4]={5,4,0,2}`でFMDSP PANPOTスプライト番号
    (0-5)へ変換している。同一チップ(OPN系)のレジスタ配置という前提に基づく
    近似で、**MUCOM側のpan値を実測検証したわけではない(未解明)**。
- **コメント欄(曲名/作曲者/コメント)**: `CMucom`クラスに title/composer を
  取得する公開APIが無い(`cmucom.h`の`public:`宣言を確認したが該当メソッド
  なし)ため、コンパイルに使った生MMLテキストをJS側で正規表現走査し
  `#title`/`#composer`/`#comment`行を抽出している。`fmdsp/comment.js`の
  `commentModePmd=false`(MML流儀の3行固定表示)を使用。
  **【2026-08-14更新、詳細は§13】** 当初は非ASCII文字が混ざっている行を
  「化けたものを描くくらいなら空欄にする」方針で描画スキップしていたが、
  これは`response.text()`がCP932の生バイト列をUTF-8として誤解釈していた
  ことが原因だった。`response.arrayBuffer()`で生バイト列を保持する方式に
  改め、ダウンロード直後(未編集)であれば生バイト列から直接CP932バイト列を
  切り出して描画できるようにした(§13)。

## 9. カウンタ類(PASSED TIME/CLOCK/LOOP)について【実装前の調査メモ。実装後は§12参照】

親からの指摘どおり、公開`CMucom::GetStatus()`には
`MUCOM_STATUS_INTCOUNT`(1)/`MUCOM_STATUS_PASSTICK`(2)/`MUCOM_STATUS_COUNT`(5)/
`MUCOM_STATUS_MAXCOUNT`(6)(`cmucom.h:52-57`)が存在し、MUCOM側では
FMDSP右半分のカウンタ類(経過時間/CLOCK/LOOP)に相当する値を**取得可能**
である(PMD側は対応するwasm exportが無く0固定のまま、`pmdweb/src/PmdWeb.cpp`
参照)。実装するなら`MucomWeb.cpp`に`GetStatus(MUCOM_STATUS_xxx)`をラップする
exportを追加し、`mucomweb/html/index.html`の`rightpane.drawDynamic()`呼び出しへ
渡す形になる(→ 2026-08-14に実装、§12)。

## 10. 調査時の注意: cmucom.h/cmucom.cpp はCP932+NEL改行

`upstream/mucom88/src/cmucom.h` / `cmucom.cpp` は **CP932エンコーディングかつ、
行終端にNEL(0x85)が混ざっている**箇所がある。UTF-8ロケールの`grep`はこれを
一切マッチせず、**存在するシンボルでも無言で0件を返す**(誤って「無い」と
判定してしまう罠。本タスクの親が実際に一度踏んだ)。読むときは

```sh
LC_ALL=C tr '\205' '\n' < cmucom.h | LC_ALL=C grep -n '検索語'
```

のようにNEL(0x85 = 8進`\205`)を明示的に改行へ変換してから`grep`に渡すこと。
`LC_ALL=C`はマルチバイト文字をバイト列として扱わせるために必須(UTF-8
ロケールのままだとCP932のバイト列を不正なマルチバイトシーケンスとして
警告・スキップすることがある)。

## 11. 動作確認(2026-08-14実施)

`mucomweb/html/index.html`をビルドし、sampl1.mucをComplie/Playした状態で
実際にスクリーンショットを取り、FMDSP左10行パートが動いていることを確認した。

- FM1-6・SSG1-3の各行: MML再生に応じてKN(音程)・TN(音色番号)・VL/GT値が
  行ごとに異なり、時間経過で変化し、鍵盤ハイライト(緑)も追従することを確認。
  FM4/FM5が一時的に同じ音程を示す場面があったが、これはMML(`H`/`I`パートが
  ユニゾンで書かれている)による正当な一致であり、バグではない。
- ADPCM(K)行: §8に記載の理由により`playing`が常にfalseのままとなり、
  `S`(未使用/停止扱い)表示のまま変化しない。**これは未達として明記する**
  (音自体は鳴っている可能性があるが、PCHDATAのcode/fnumがADPCMでは
  更新されないため、パート行UIでは検出できない)。
- コメント欄: `Sample Music 1` / `Yuzo Koshiro`(`#title`/`#composer`)が
  実際に描画されることを確認。
- 右半分: PROG/KEY/PANPOT列(FM1-6, SSG1-3, ADPCM)がPCHDATA由来の値で
  変化することを確認(ただし目視でのpan値の正しさまでは検証していない、
  §8のPANPOT変換式の限界を参照)。レベルバー本体・FFTスペクトラムは
  意図通り常に空。
- 比較対象として`pmdweb`側も同時に起動し、同じ描画層(フォント・座標)で
  レイアウトが崩れていないことを確認した(`TRACK.`行の数字スプライトが
  小サイズフォントで視認しづらいのはPMD側も同じ挙動であり、本タスクで
  劣化させたものではない)。
- `node tools/verify_trackrow.mjs` / `node tools/verify_cp932_render.mjs`は
  いずれもPASS(`fmdsp/`配下は無変更)。

## 12. カウンタ類(経過時間/CLOCK/LOOP)の実装と実測【2026-08-14】

### 実装

`mucomweb/src/MucomWeb.cpp`の`StatusSnapshot`にグローバルカウンタ3つを追加した
(既存の`static_assert`によるレイアウト固定の作法を踏襲):

```cpp
struct StatusSnapshot
{
    uint32_t frame;
    int32_t passTick;   // GetStatus(MUCOM_STATUS_PASSTICK)
    int32_t intCount;   // GetStatus(MUCOM_STATUS_INTCOUNT)
    int32_t maxCount;   // 曲の総tick数(下記「maxCountの罠」参照、GetStatusでは取れない)
    TrackStatus tracks[MUCOM_MAXCH];
};
```

`PushSnapshot()`で毎フレーム(256サンプル毎)詰めており、リング経由なので
表示側の同期(二分探索によるオーディオ時刻とのスナップショット照合)を壊さない。
embind export `getSnapshotHeaderWordCount()`を追加し、JS側が
`frame`に続くヘッダのワード数(=4)をハードコードしなくて済むようにした
(既存の`getSnapshotEntryByteSize()`系の命名に揃えた)。
描画は`fmdsp/rightpane.js`の既存`drawDynamic()`をそのまま使用しており、
描画層(`fmdsp/`配下)は無変更(`verify_trackrow.mjs`/`verify_cp932_render.mjs`
がPASSすることを確認済み、§11末尾)。

### maxCountの罠(実測で発覚)

`GetStatus(MUCOM_STATUS_MAXCOUNT)`は`CMucom::maxcount`メンバをそのまま返すが、
このメンバは**`CMucom::Compile()`内でのみ計算・代入される**
(`cmucom.cpp:1283`でリセット、`1303`で計算)。`MucomWeb.cpp`の再生用インスタンス
`g_mucom`は`LoadMusic()`+`Play()`だけを呼び、`Compile()`は一度も呼ばないため、
**`g_mucom->GetStatus(MUCOM_STATUS_MAXCOUNT)`は常に0を返す**ことを実測で確認した
(sampl1.muc再生中に確認、コンパイルログには`#MaxCount:3072`と出るのに
スナップショット上のmaxCountは0のままだった)。
対策として、コンパイル専用インスタンス`mucomCompiler`がCompile成功直後に
確定させた`GetStatus(MUCOM_STATUS_MAXCOUNT)`の値をグローバル`g_maxCount`へ
退避し、以後`PushSnapshot()`ではそちらを使うようにした
(`CompileMML()`内、`mucomCompiler.Compile()`成功直後)。

### 実測(壁時計時間との突き合わせ、宣言通り「名前からの推測」はしていない)

sampl1.mucを実際に再生し、`AudioContext.currentTime`(壁時計)と
デバッグ表示上の`passTick`(=`vm->time_master`、`TICK_SHIFT=10`により
`osdep.h:12`で1ms=1024単位の固定小数、`CMucom::RenderAudio()`が
描画済みオーディオ時間をそのまま`vm->UpdateTime()`へ渡している実装
`cmucom.cpp:355-362`)を約2分間、複数時点で比較した:

| 経過(概算) | passTick/1024 (ms) | AudioContext.currentTime (ms) | 差 |
|---|---|---|---|
| ~5s | 4855.0 | 4883 | 28ms |
| ~17s | 16809.0 | 16832 | 23ms |
| ~36s | 35773.0 | 35804 | 31ms |
| ~54s | 54290.0 | 54316 | 26ms |
| ~117s | 116823.0 | 116849 | 26ms |
| ~141s | 141488.0 | 141514 | 26ms |

差はほぼ一定(23-31ms、AudioWorkletの出力レイテンシ相当)で、傾き(進み方)が
壁時計と一致することを確認した。**よって`passTick`は「オーディオレンダリング
済み時間(ms)×1024」であり、`/1024`すれば経過時間(ms)になる**という理解を採用した。
`fmdsp/rightpane.js`の`drawPassedTime(frames)`は実サンプルレートに関わらず
「55467Hz換算の生成フレーム数」を要求する(本家定数、同ファイルのコメント参照)
ため、`round(passTickMs * 55467 / 1000)`をBigIntにして渡す変換関数
(`passTickToGeneratedFrames55467`、`mucomweb/html/index.html`)を実装した。
実際の表示値も検算した(141488ms時点): `frames=7847915` →
`02:21.48`と算出され、実際の経過時間(141.488s = 2分21.488秒)と一致する。

`intCount`(`MUCOM_STATUS_INTCOUNT`)は演奏開始からのINT3(音楽用割り込み)
回数の生カウントで、単調増加することを確認した(296 → 1036 → 2210 → 3356 →
7227 → 8754、上記と同一セッションで経過時間とともに増加)。これを
CLOCK COUNTへそのまま採用した。

`maxCount`(曲の総tick数、上記「maxCountの罠」参照)は再生中一定
(sampl1.mucで3072)であることを確認した。`GetStatus(MUCOM_STATUS_COUNT)`の
実装が`intCount % maxCount`を返す(`cmucom.cpp:534-538`)ことから、
`floor(intCount / maxCount)`がループ回数に相当すると導いた
(名前からの推測ではなく、ソースの剰余演算の定義から機械的に導出した式)。
実測でも`intCount`が`maxCount`(3072)を超えた直後に`loopCnt`が0→1→2と
正しく増分することを確認した(intCount=3356で1、intCount=7227で2、
`floor(7227/3072)=2`で一致)。

### スコープ外のまま残したもの

- **TIMER B CYCLE / CPU POWER COUNT / FRAMES PER SECOND**: タスク指示により
  今回は対応しない。`0`固定のまま。
- 上記いずれも「単位不一致で採用できず0のまま残した」項目ではない
  (すべて実測で意味を確認したうえで採用、または最初からスコープ外)。

## 13. MML の CP932/Shift_JIS 読み込み【2026-08-14】

### 問題と対応

`downloadMML()`が`response.text()`でfetchしていたため、`.muc`(CP932/Shift_JIS)
がUTF-8として誤解釈され、日本語の`#comment`/`#title`等が文字化けしていた
(sampl1.mucはcommentが空のため表面化していなかった)。

- `response.arrayBuffer()`で**生バイトのまま**保持するよう変更。
- textareaの表示用テキストは`new TextDecoder('shift_jis')`でデコード。
- コメント欄描画(`fmdsp/comment.js`の`drawTextCp932`)には**生のCP932バイト列**
  を渡す設計方針を踏襲。ダウンロード直後(textareaが未編集)であれば、保持した
  生バイト列を0x0Aで行分割し(CP932の2バイト文字は先頭0x81-0x9F/0xE0-0xFC・
  2バイト目0x40-0xFCの範囲で0x0A/0x0Dと重ならないため、素朴な分割で安全)、
  `#title`/`#composer`/`#comment`行を**デコード・再エンコードを経由せず**
  直接切り出す(`extractMmlHeaderBytes`、`mucomweb/html/index.html`)。

### 動作確認

`upstream/MucomWeb/mucom88/package/sampl2.muc`/`sampl3.muc`はcommentが空
だったため、日本語コメントを含むローカルサンプル`mucomweb/html/samplja.muc`
(CP932でエンコード、`#title 日本語コメント確認用` / `#composer うらら太郎` /
`#comment これは日本語コメントの表示確認用サンプルです`)を新規作成し、
`sampl1.muc`と同様「ローカル,確認用」のリンクとして常設した。
実際にダウンロード→Compile/Playし、FMDSP画面下部のコメント欄3行すべてに
上記の日本語テキストが文字化けせずに描画されることをスクリーンショットで確認した。

### textarea編集経路(利用者がMMLを書き換えた場合)

`Module.compileMML(mml, rate)`は`std::string`引数であり、emscripten
(embind)がJS文字列をUTF-8へ変換してC++へ渡す。ここは変更していない。
調査の結果、これは**問題ではなくむしろ意図的な設計だった**ことが判明した:
`upstream/MucomWeb/mucom88/src/mucom88config.h`で`MUCOM88WIN`が未定義の
ビルド(=このWebビルド)では`MUCOM88UTF8`マクロが有効になっており
(`cmucom.cpp:CMucom::ProcessHeader()`のコメントにも
`text = MML書式のテキストデータ(UTF8)`と明記されている)、
`CMucom::GetMultibyteCharacter()`はUTF-8の継続バイト規則で多バイト文字を
スキップする実装に切り替わる。**つまりこのフォークのMML compileMMLは
最初からUTF-8入力を前提に作られている**。今回の修正で
textareaの中身が(誤デコードでなく)正しくデコードされたJS文字列になった
ことで、`compileMML`が受け取るUTF-8バイト列も副作用的に正しくなった
(以前は「CP932バイト列をUTF-8として誤読した文字列」を再度UTF-8化して
渡していたため、二重に破損した中身がC++側へ渡っていた)。
compileMML側は今回変更しておらず、ズレは解消済みで残っていない。

一方、**コメント欄描画(CP932生バイトが必要)側は編集後の文字列からは
正しいCP932バイト列を再構成できない**。ブラウザの`TextEncoder`はUTF-8専用で
Shift_JISエンコーダが無いため。textareaを編集した場合(またはダウンロード
なしで手入力した場合)は、従来どおり「非ASCII混入時は空欄にする」
ASCII安全フォールバック(`asciiOnlyCp932Bytes`)を使う。これは制約として
残す(捏造しない方針を優先した)。

## 14. `playing`(chstat)とパンポットの本実装【2026-08-14】

親からの指示により、以下2点をupstream最小パッチ(アクセサ1本)込みで実装した。

### upstreamパッチ

`upstream/MucomWeb/mucom88/src/cmucom.h` の `CMucom` クラス(private `mucomvm *vm`)に
`mucomvm *GetVM(void) { return vm; }` を1行追加。パッチは
`mucomweb/patches/0001-cmucom-expose-vm.patch` としてFMSound repo側で追跡し、
`mucomweb/CMakeLists.txt` のconfigure時に「`git apply --reverse --check`が失敗する
(＝未適用)場合だけ`git apply`する」という冪等ロジックで自動適用する
(適用失敗時は警告でなくビルドを`FATAL_ERROR`で止める)。以下3パターンを
実機確認済み:
1. 未適用状態からconfigure → diffが4行(追加分)になり、そのままビルド成功。
2. 適用済み状態から再度configure(2回目) → diffは4行のまま変化なし
   (二重適用しない)。
3. パッチの検索対象文字列をわざと壊して(`GetChannelData`→
   `GetChannelDataXXXNOTFOUND`)故障注入し、configureが`CMake Error`で
   **確実に停止する**(警告で済まさない)ことを確認してから元のパッチへ戻した。

### `playing`(chstat)の実測結果

`mucomvm::GetChStatus(ch)`(OPNAハードウェアch単位のキーオン状態、0/1)を
`MucomWeb.cpp`の`StatusSnapshot`に`chstat[16]`として追加した(`OpnaChannelCount=16`、
`mucomvm.h`の`OPNACH_MAX`)。**PCHDATAのMMLパートch(A-K=0-10)とは別の番号体系**
であることに注意(以下は全て単発ノートを1パートだけ鳴らすMMLでの実測、
`node`から直接wasmを叩いてスナップショットリングを読む方式。
`tools/probe_mucom_pchdata.mjs`と同じ手法)。

| MMLパート | PCHDATA ch | chstat idx | 実測結果 |
|---|---|---|---|
| A(FM1) | 0 | 0 | `A @1o4c1`で chstat[0]=1 |
| B(FM2) | 1 | 1 | `B @1o4c1`で chstat[1]=1 |
| C(FM3) | 2 | 2 | `C @1o4c1`で chstat[2]=1 |
| H(FM4) | 7 | 4 | `H @1o4c1`で chstat[4]=1 |
| I(FM5) | 8 | 5 | `I @1o4c1`で chstat[5]=1 |
| J(FM6) | 9 | 6 | `J @1o4c1`で chstat[6]=1 |
| K(ADPCM) | 10 | 10 | sampl1.muc(実曲)再生中、ADPCM鳴動区間だけchstat[10]が1になり停止区間で0に戻ることを複数ステップ(20480フレーム刻み)で確認 |
| D(SSG1) | 3 | (無し) | `D @1o4c1`で全16 chstat要素が0のまま変化なし |
| E(SSG2) | 4 | (無し) | 同上 |
| F(SSG3) | 5 | (無し) | 同上 |
| G(リズム) | 6 | (無し) | `G @1o4c1`で全16 chstat要素が0のまま変化なし |

裏付け(ソース側、`upstream/MucomWeb/mucom88/src/mucomvm.cpp` `FMOutData()`):
`case 0x28`(FM KeyOn)で`ch = data & 7`をそのまま`chstat[ch]`のindexに使う
(標準的なOPNA仕様どおりFM1-3は0-2、FM4-6は4-6でindex3は未使用)。ADPCMは
`FMOutData2()`の別経路(`chstat[OPNACH_ADPCM]`, idx10)。**SSGとリズムはchstat[]を
更新するコードパス自体が無い**(`case 0x28`/ADPCM分岐以外でchstat[]へ書き込む
箇所が存在しない)ため、これは実装ミスではなく構造的な制約。

**採用方針**(`mucomweb/html/adapter.js` `CH_TO_CHSTAT`): A,B,C,H,I,J,Kはchstat値を
そのまま「今この瞬間鳴っているか」として使う(sticky不要、real-time)。
D,E,F,G(SSG/リズム)は引き続き旧来の「一度でも非0のcode/fnum1を出したか」の
sticky近似を使う(chstatで判定できないという制約は未解明のまま残る)。

**成果物**: sampl1.mucを実際に再生し、ADPCM(K)行が鳴動区間だけ`playing`表示に
切り替わり(FMDSP左パネルのS表示から実演奏表示へ)、停止区間で元に戻ることを
スクリーンショットで確認した(詳細は§15参照)。これが今回の一番の目的だった
「ADPCM行がSのまま固まる」問題の解消。

### パンポットの実測結果

`mucomvm::GetRegisterMap()`(検証専用に一時的な埋め込みexport
`debugGetReg(int reg)`を追加し、実測後に削除した。本番コードには残っていない)で
実際のOPNAレジスタバイトを直読みし、PCHDATAの`pan`フィールドと突き合わせた。

**FM(A-C, H-J、reg 0xB4-0xB6 / 0x1B4-0x1B6のbit6,7)**: `A @1p0o4c1`〜
`A @1p3o4c1`(part A、reg 0xB4)と`H @1p0o4c1`〜`H @1p3o4c1`(part H、reg 0x1B4)の
両方で、p0-p3の全4値について「PCHDATA.pan」と「regmap[reg]の上位2bit
((regByte>>6)&3)」が完全一致することを実測した(8/8件PASS)。
`upstream/MucomWeb/mucom88/src/fmgen/opna.cpp:575-578`
(`case 0xb4: pan[c] = (data>>6)&3;`)がこの一致の裏付けとなるソース。

bit配置の意味(値そのものの解釈)はfmgenの`OPNABase::Mix6()`
(`opna.cpp:1147-1160`、`idest[c]=&ibuf[pan[c]]`、`dest[0](L出力)=ibuf[2]+ibuf[3]`,
`dest[1](R出力)=ibuf[1]+ibuf[3]`)から機械的に導出した:

| pan値 | MML | 意味 |
|---|---|---|
| 0 | `p0` | 無音(L/Rどちらにも出力しない) |
| 1 | `p1` | 右のみ |
| 2 | `p2` | 左のみ |
| 3 | `p3` | 両方(中央) |

独立検証として、PMD側が使う別実装`upstream/98fmplayer/libopna/opnafm.c`の
`fm->lselect[c]=val&0x80; fm->rselect[c]=val&0x40;`(同じreg 0xB4のcase 0x4)と
`upstream/98fmplayer/fmdsp/fmdsp-pacc.c`の
`table[4]={5,4,0,2}; levels[c].pan=table[lselect*2+rselect]`が、MUCOM側の生値
(bit7<<1|bit6)と同じ合成式であることをソースレベルで確認した。2つの独立した
チップエミュレータ実装が同じレジスタ規約で一致しているため、
`mucomweb/html/adapter.js`の`PAN_TABLE=[5,4,0,2]`(既存、PMD由来)を
そのまま流用してよいと判断した。

**ADPCM(K, reg 0x101 = ADPCM-B Control2)**: sampl1.muc実曲再生中、
`regmap[0x101]`の上位2bitと`PCHDATA.pan`がどちらも再生を通じて終始`3`(中央)で
一致することを確認した。ただし`K @1p<n> r1`のような無音ノートでの単独テストでは
実際のKeyOnが発生せずレジスタ書き込み自体が起きなかったため、
**p0/p1/p2でのADPCMのレジスタ一致は実測できていない(未解明のまま残す)**。
fmgen `opna.cpp:976-977`(`maskl=control2&0x80; maskr=control2&0x40;`)は
FMと同じbit配置だが、これはソース上の構造的な類推であり実測による裏付けではない
ことを明記する。

**SSG(D,E,F)/リズム(G)**: `cmucom.cpp:1621,1625`
(`case MUCOM_CH_PSG...: pan=3; break;` / `case MUCOM_CH_RHYTHM: pan=3; break;`)が
レジスタを一切読まず`pan=3`を無条件代入するハードコードであることをソースで
確認済み。これは「未検証の近似」ではなく実装が断定している値そのものであり、
実測を要しない確定事項として扱った。

### 実装ファイル

- `mucomweb/src/MucomWeb.cpp`: `StatusSnapshot`に`chstat[16]`追加、
  `PushSnapshot()`で`g_mucom->GetVM()->GetChStatus(ch)`を全16ch分格納。
- `mucomweb/html/adapter.js`: `CH_TO_CHSTAT`(PCHDATA ch -> chstat idx)追加、
  `convertChannel(ch, pchData, chstatValue)`が`chstatValue`未定義時のみ
  従来のsticky近似にフォールバック。`PAN_TABLE`は変更なし(裏付けのコメントを
  全面更新)。
- `mucomweb/html/index.html`: `CHSTAT_OFFSET=4`(固定ヘッダの直後)から
  `snapshotHeaderWordCount`手前までを`chstat[]`として読み、
  `CH_TO_CHSTAT[ch]`があるchについてのみ`convertChannel`へ渡す。

## 15. 動作確認スクリーンショット(2026-08-14)

`mcp__Claude_Browser__preview_start`(`mucomweb`、port 8777)でsampl1.mucを
Compile/Playし、約1-2秒間隔で3枚のスクリーンショットを撮ってADPCM(K)行の
`KN:`表示を確認した。`fmdsp/trackrow.js`の描画ロジック(`!playing`なら`S`、
`playing`かつ休符なら`R`、それ以外は音名)を根拠に、以下の遷移を目視確認した:

1. 1枚目: `ADPCM TRACK.0.0 KN: R`(`playing=true`、休符中)
2. 2枚目(約2秒後): `ADPCM TRACK.0.0 KN: S`(`playing=false`、未使用/停止扱い)
3. 3枚目(さらに約2秒後): `ADPCM TRACK.0.0 KN: R`(`playing=true`に復帰)

`S`と`R`が時間経過で入れ替わっていることから、ADPCM行の`playing`が
sticky近似(旧実装。一度立ったら曲終了まで`S`に戻らない)ではなく、
`chstat[10]`由来のreal-time値になっていることを確認した。これが今回の目的
「ADPCM行がSのまま固まる」問題の解消の実機証拠。

自動化クリックはCompile/Playボタンに届かなかった(押しても`snapshot ring:
inactive/empty`のまま変化せず)ため、`document.getElementById('btnCompile').click()`
(JS直接呼び出し)で代替した。これはタスク指示の許容範囲内(合成クリックが
届かない場合の代替手段)であることをここに明記する。
