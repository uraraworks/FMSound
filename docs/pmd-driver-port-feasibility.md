# PMD ドライバ(98fmplayer移植)の8086移植 実現性調査

日付: 2026-08-14。目的: `upstream/98fmplayer/fmdriver/fmdriver_pmd.c`（BSD 2-Clause、6114行）を
PC-98実機(8086/SmallerC small-model)へ移植する規模を実測で見積もる。**作り込みはしていない**（見積もりが目的）。

## (1) 音源への書き込み層

- 音源アクセスは全て `struct fmdriver_work`（`upstream/98fmplayer/fmdriver/fmdriver.h:77-88`）の
  関数ポインタ経由: `opna_writereg`（96箇所中95がこの呼び出し）、`opna_readreg`（1箇所）、
  `opna_status`（2箇所）。すべて `work->opna_writereg(work, addr, data)` の形で、
  `fmdriver_pmd.c` 側は具体的な実装（メモリマップドかI/Oポートか）を一切知らない。
  出典: `fmdriver.h:86-88`, `fmdriver_pmd.c` 全体grep。
- PPZ8(PCM)も同様に `ppz8_functbl` という別の関数テーブル経由（`work->ppz8`, 22箇所）。
- **判定: 薄いシムで差し替え可能。構造への食い込みは無い。** 実機ポートI/O版の
  `opna_writereg`/`opna_readreg` を書いて `fmdriver_work` に差し込むだけで、
  `fmdriver_pmd.c` 本体は無改変で音源アクセス層を満たせる。
- **未確認（推測で書かない）**: PC-98の86音源(OPNA)のI/Oポート番号（`0188h`/`018Ah`系と
  記憶にはあるが本調査では実測・一次資料確認をしていない）。シム実装時に別途要調査。

## (2) SmallerCでの実コンパイル試行（最重要）

`WorkbenchNP2/toolchain/compile-core.mjs` の内部API（`createSmlrpp`→`createSmlrc`→NASM→`createSmlrl`）を
直接呼び出すスクリプトを scratchpad に作成し、`fmdriver_pmd.c` を実際にコンパイルした
（`WorkbenchNP2` は読むのみ、変更なし。実行後 `git -C WorkbenchNP2 status` clean 確認済み）。

### 2-1. プリプロセス段: ヘッダ欠落（機械的に解決可能）

1回目: `fmdriver_pmd.h`/`fmdriver_common.h`/`pmd_ssgeff.h` が見つからない
→ 同ディレクトリの `.h`/`.inc` を includeFiles に追加して解決。
2回目: `stdbool.h`/`stdatomic.h`/`leveldata/leveldata.h` が **SmallerCのincludeに存在しない**
（`toolchain/smallerc-src/v0100/include/` に `stdbool.h`/`stdatomic.h` は無い。`ls` で確認済み）。
→ `ppz8.h:5-7`(`upstream/98fmplayer/fmdriver/ppz8.h`)が
   `<stdbool.h>` `<stdatomic.h>` `"leveldata/leveldata.h"` を要求し、
   `fmdriver.h:6`→`fmdriver_pmd.h:8`→`fmdriver_pmd.c:1` の連鎖で強制的に巻き込まれる
   （PMD本体はPPZ8を関数ポインタ越しにしか使わないのに、型定義のためヘッダだけ引き込まれる）。
→ scratchpad に最小シム（`bool`をintマクロ化、`atomic_flag`を非アトミックintに縮退、
   `leveldata`をロック無しに単純化）を書いて解決。**これは機械的な作業**（C99機能を
   シングルスレッドDOS向けに縮退するだけ）。

この段階まではプリプロセス成功（`out.i` 168,418バイト）。

### 2-2. コンパイル段: `long`型が -seg16 モードで一切通らない（設計変更が必要）

`smlrc -seg16` でのエラー:
```
Error in "/include/ppz8.h" (20:11)
Unexpected token uint32_t
```
`ppz8.h:20`（`struct ppz8_pcmvoice { uint32_t start; ... }`）。

原因を切り分けるため、`long a, b` を含むだけの最小Cファイルを同じ `-seg16` で単体テストした
（`scratchpad/pmdcompile/longtest.mjs`）:
```
Error in "in.c" (2:5)
Unexpected token long
```
**`long`キーワード自体が16-bitモード(-seg16, `__SMALLER_C_16__`)でパースエラーになる。**
`toolchain/smallerc-src/v0100/include/stdint.h` を確認すると、`uint32_t`/`int32_t` の
typedefは `#ifdef __SMALLER_C_32__` の中にしかなく、`__SMALLER_C_16__`（small-modelが使う方）
では**32bit整数型そのものが定義されていない**（`stdint.h:53-56`）。
→ **これはヘッダ不足ではなく、SmallerCの16-bitモードの言語仕様上の制約。機械的な修正では
  済まない。**

`fmdriver_pmd.c` 本体だけでも `uint32_t`/`int32_t` の使用箇所は **24箇所**
（`grep -n 'uint32_t\|int32_t' fmdriver_pmd.c`で実測）。単なるカウンタの拡張ではなく、
FM周波数の block/fnum の16bit上位/下位合成（`fmdriver_pmd.c:1879`, `:2024`, `:3207` 等）や
符号付き乗算・16bit右シフト（`:1811`, `:3107-3108`）など、**アルゴリズムの一部として
32bit演算が使われている**。`ppz8.c`/`ppz8.h`（PCM再生のバッファ長・オフセット管理）は
さらに広範囲に32bit値へ依存している。

これを16-bitモードで通すには、`long`が使えない前提で
- hi16/lo16の2つのunsigned(16bit)変数で32bit値を手動エミュレートする（桁上げ・シフトを
  自前で書く）、または
- 該当関数だけアセンブラで書き直す
のどちらかが要り、**「移植」ではなく「該当ロジックの再設計」になる**。これは
「どこまでが機械的な修正で、どこからが設計変更か」の境界線そのもの:
- ヘッダ欠落・C99マクロ縮退（stdbool/stdatomic/leveldata） → **機械的**
- 32bit整数を使うロジック（24箇所+ppz8側多数） → **設計変更**

### 2-3. サイズ実測

**コンパイルが32bit型の壁で止まったため、コード/テーブルサイズの実測（64KBとの比較）は
できなかった。** 32bit演算の書き換えを済ませない限り `smlrc` が `.asm` を出力しないため、
「small modelの64KBに収まるか」は本調査では判定不能（未確認のまま残す）。

## (3) 割り込み・時間駆動

- `pmd_opna_interrupt(struct fmdriver_work *work)`（`fmdriver_pmd.c:5893`）は
  「呼ばれたらOPNAのタイマーステータスをポーリングして`pmd_timer`を回す」実装で、
  **自前で壁時計を持たず、外側から叩かれる前提**（ヘッダのコメントも
  `// set by opna, called by driver in the interrupt functions` と明記、`fmdriver.h:78-79`）。
  → **実機のOPNA Timer B割り込みから直接呼ぶ設計と整合的**で、この点は移植の障害にならない。
- ただし「誰が・どの割り込みベクタで・どの頻度で呼ぶか」の**グルーコード**（IRQハンドラの
  登録、DS/SSの退避復帰、再入防止、スタック切替）は `fmdriver_pmd.c` の外の新規実装が要る。
- **TSR/割り込みハンドラの実績確認**: `docs/pipeline-spike.md`(「TSR自体は...実際にTSR化して
  常駐させた実績はWorkbenchNP2内に無く未検証」)を追認する形で `WorkbenchNP2/README.md` を
  再検索したが、TSR・常駐ドライバに関する記述は見つからなかった（「常駐438KB」の1件は
  文脈上無関係なメモリ使用量の話）。**WorkbenchNP2にTSR/割り込みハンドラの実績はゼロのまま**。

## 結論: (b) は現実的か

**現段階では「現実的」と断言できない。決定的な障害は32bit整数の欠如。**

- 音源I/O層（(1)）は懸念どおり軽い: シム1枚で足りる。
- しかし **SmallerCの16-bitモードが`long`を一切サポートしない**ため、`fmdriver_pmd.c`本体の
  24箇所＋`ppz8.c`/`.h`の広範囲な32bit演算を、手書きhi/lo16 or アセンブラ書き換えで
  全部潰さない限りコンパイルが完走しない。これは「移植作業」の範囲を大きく超え、
  実質的に**該当ロジックをC言語のまま作り直す**規模になる（正確な工数は未計測。
  該当関数を洗い出して1つずつ32bit演算を分解する必要があり、少なくとも週オーダーの
  作業と見積もるのが妥当だが、根拠となる実測値は無い）。
- 64KB制約についても「32bit演算を潰した後でないと測れない」ため、**サイズ面の見通しは
  まだ立っていない**（ppz8.c等を含めるとさらに肥大する可能性が高いが未計測）。
- 割り込み駆動の設計自体はドライバ側と整合しており障害にはならないが、
  **TSR実績ゼロ**という別の未検証リスクが残っている。

## (c)（PMD.ASM移植）に倒すべきか

- (c)は元から8086アセンブラ（MASM方言、`docs/pmd-compiler-options.md`で確認済みの
  KAJA氏公開ソース）であり、**32bit整数の壁がそもそも存在しない**（アセンブラなので
  hi/lo16分割は最初から書かれている）。SmallerCの16-bit言語仕様制約を回避できる点で
  (b)より実装難度の予測可能性は高い。
- 一方で(b)を推した本来の理由（BSD 2-Clauseでの再配布のしやすさ）を捨てることになり、
  (c)はKAJA氏の個人的許諾表明のみ（正式なOSSライセンス条項なし、
  `docs/pmd-compiler-options.md`で既出）という利用者への負担が残る。
- **判断材料**: (b)は「ライセンスは綺麗だが今回発見した32bit整数の壁で工数が大きく膨らむ
  可能性が高い」、(c)は「工数は読みやすいがライセンスがグレー」というトレードオフ。
  今回の実測で(b)側のコストが具体的に上がったため、**(c)、または(a)(利用者が公式PMD.COM持参)
  との比較を本格的に見積もり直す価値がある**という以上の断定はできない
  （(c)側の実装量そのものは本調査の対象外で未計測）。

## (追記 2026-08-14) 32ビットモードの検討

前節の「未確認」項目のうち、`-seg32`（32-bitモード）で`long`が使えるかを実測した。
`WorkbenchNP2/toolchain/smlrc-wasm/`のsmlrpp.js/smlrc.jsを直接呼び、scratchpadに
最小テストスクリプトを書いて検証（`WorkbenchNP2`は読むのみ、実行後`git status`clean確認済み）。

### 4-1. `-seg32`/`-huge`で`long`は通る（実測で確認）

`long a, b`を含む最小Cファイルを`-D __SMALLER_C_32__`を渡した上で`-seg32`と`-huge`の
両方でコンパイルしたところ、**両方とも`exit=0`で通った**（`-seg32`: asm 2057バイト、
`-huge`: asm 2273バイト）。`doc/smlrc.md:353-392`によると:
- `-seg32`: 32bit出力だが**Windows/Linux等の保護モード向け**（`smlrl -pe`/`-win`/`-elf`で
  リンクする用途。ドキュメント中の使用例は全てWindows/Linux）。
- `-huge`/`-unreal`: 32bit int/pointerを使うが**16bit実モード(または仮想8086)で動く
  DOS向け**。`smlrl -huge`/`-unreal`で通常のDOS .EXEにリンクされる（`doc/smlrl.md:102-109`）。
  **DPMIやDOSエクステンダは不要**（保護モードに入らないため）。

→ PC-98 DOSで動かしたいなら、選ぶべきは`-seg32`ではなく**`-huge`（または`-unreal`）**。
`-seg32`単体はDOS向けの出力形式ではない。

### 4-2. `fmdriver_pmd.c`本体は`-seg32`/`-huge`のどちらでも同じ箇所で止まる（実測）

前節の手順（ヘッダ欠落解決＋stdbool/stdatomic/leveldataシム）をそのまま流用し、
`-D __SMALLER_C_32__`＋`-seg32`または`-huge`でコンパイルを試みた。
**プリプロセスは通る（168,536バイト）が、コンパイル段で新たな壁に当たった**:

```
Error in "/include/ppz8.h" (34:11)
Unexpected token uint64_t
```

`ppz8.h:32-36`（`struct ppz8_channel`）が`uint64_t ptr/loopstartptr/loopendptr/endptr`を
使っている。**`uint32_t`の壁は`-seg32`/`-huge`で解消したが、`uint64_t`という別の壁が
その先に見つかった。** これは`long`が通るようになったことで初めて到達できた、
前節では未発見だった問題。

さらに`fmdriver_pmd.c`本体にも実測で**1箇所**`int64_t`の実演算がある
（`fmdriver_pmd.c:1892: int64_t outfreq = freq + det;`、grep実測)。

**SmallerCは`long long`（64bit整数）を言語仕様として一切サポートしていない**
（`doc/smlrc.md:249`: 「Smaller C does not support long long as of now」と明記）。
これは`-seg16`/`-seg32`/`-huge`いずれのモードでも変わらない**言語自体の制約**であり、
`stdint.h`にも`uint64_t`/`int64_t`のtypedefは存在しない（grep実測、0件）。

→ **サイズ実測は今回も未達**（コンパイルが64bit整数の壁で止まるため`.asm`が出ず、
64KB/セグメントとの比較は依然として判定不能）。

### 4-3. 常駐(TSR)＋タイマー割り込みとの両立

`-huge`/`-unreal`は保護モードに入らない（実モード/仮想8086モードのまま）ため、
**DPMIは不要**。割り込みハンドラの登録・スタック退避・再入防止といったグルーコードの
難度は`-seg16`と原理的に同程度と見立てる（保護モード特有のリングやディスクリプタの
考慮は発生しない）。ただし`-huge`はポインタが32bit物理アドレス→far pointer変換を
コンパイラが自動で挟むため、割り込みハンドラ内でのスタック切替・レジスタ退避コードを
手で書く場合に**32bit物理アドレス変換のオーバーヘッドと、それが割り込みの再入禁止区間で
安全か**は未検証（`-seg16`ならこの懸念自体が発生しない）。**未確認のまま残す。**

### 4-4. 結論: 32ビットモードは逃げ道になるか

**部分的には逃げ道になるが、全体の壁は消えない。**

- `-huge`（`-seg32`ではなくこちら）でDOS向けの32bit int実行ファイルは作れる。
  DPMI/DOSエクステンダは不要で、WebNP2のFreeDOS環境で動く見込みは
  （TSR実績ゼロという別リスクを除けば）`-seg16`と同程度と見てよい。
- しかし`fmdriver_pmd.c`＋`ppz8.h`は**32bit整数だけでなく64bit整数(`uint64_t`/`int64_t`)にも
  依存しており、SmallerCは64bit整数を言語として一切サポートしない**。これは`long`の壁と
  違い、**どのモードでも回避不能な壁**（フラグでは解決しない）。
- したがって「(b) BSD版PMDドライバをSmallerCへ移植」の実現性判定は変わらず、
  **32bit整数の壁は`-huge`で解消できるが、その先に64bit整数の壁が新たに見つかった
  ことで、むしろ課題は増えた**。64bit演算箇所（`ppz8.h`側の広範な使用＋
  `fmdriver_pmd.c:1892`）を全てhi/lo32分解またはアセンブラ書き換えする追加作業が
  必要になり、前節で見積もった工数はさらに膨らむ方向にしか動かない。

## 未確認のまま残った点

- PC-98 OPNA(86音源)のI/Oポート番号（推測で書かないため未記載。シム実装時に別途要調査）。
- 32bit演算を全て16bit分解に書き換えた後の実コンパイル結果・コードサイズ・64KBとの比較。
- `ppz8.c`/`ppz8.h`（PCM再生）側の32bit依存箇所の総数（今回は`fmdriver_pmd.c`本体のみ実測、
  ppz8は関数ポインタ越しの型定義部分しか見ていない）。
- (c)（PMD.ASM移植）側の実装工数の実測（本調査は(b)のみが対象）。
- SmallerCが `long` を全くサポートしないのか、何らかのフラグ/バージョンで対応する余地が
  あるのか（`toolchain/smallerc-src/readme.txt`に「32-bit 80386+ assembly code」の記載があり、
  `__SMALLER_C_32__`ビルドなら`long`が使える可能性はあるが、WorkbenchNP2の`compile.mjs`が
  使っているのは`-seg16`（16bitモード）と確認しただけで、32bitモード自体を試していない）。
  → **下記(追記)で実測済み。`-huge`で`long`は通ることを確認した。**
- TSR/割り込みハンドラの最小サンプルをWorkbenchNP2上で実際に書いて動かす検証（本調査は
  既存ドキュメントの再確認に留めた）。

## (追記 2026-08-14) `-huge` での全体コンパイル

前節(4-2)で見つかった`uint64_t`/`int64_t`の壁を実際に取り除き、`fmdriver_pmd.c`本体が
`-huge`で最後まで通るかを実測した。作業ファイルは全て
`scratchpad/pmdcompile/`（`src/`に`upstream/98fmplayer/fmdriver/*.{c,h,inc}`のコピー、
`shim/`に差し替えヘッダ）に置き、`WorkbenchNP2`・`upstream`はどちらも読むだけ
（作業後`git -C WorkbenchNP2 status`・`git -C FMSound status`とも clean を確認済み）。

### 5-1. `ppz8`は「切り離せる」——ただし切り離せるのは型定義であって実装ではない

`fmdriver_pmd.c`全体を実測grepしたところ、`work->ppz8`（不透明ポインタ）と
`work->ppz8_functbl->関数(...)`（関数ポインタ経由の呼び出し）だけが使われており、
**`struct ppz8`のフィールドを直接参照する箇所（`ppz8->xxx`や`ppz8.xxx`）は0件**だった
（`grep -n 'ppz8->\|\.ppz8\.'`で確認）。`ppz8_init`/`ppz8_mix`/`ppz8_pvi_load`等の
実体関数や`enum ppz8_interp`・`struct ppz8_pcmvoice`等の型も`fmdriver_pmd.c`からは
一切参照されていない。

これを踏まえ、本物の`ppz8.h`（`uint64_t`を使う`struct ppz8_channel`や
`stdbool.h`/`stdatomic.h`/`leveldata.h`依存を含む）を、`struct ppz8`を前方宣言のみの
不透明型にし、`struct ppz8_functbl`は`uint32_t`以下の型だけで再構成したシム
（`scratchpad/pmdcompile/shim/ppz8.h`）に差し替えた。これで`fmdriver_pmd.c`単体の
コンパイルからは`uint64_t`・`stdatomic.h`・`leveldata.h`への依存が消えた。

**ただし**これは「PPZ8機能を切り離せる」という意味ではない。`work->ppz8`が非NULLで
実際にPPZ8実装（`ppz8.c`）と組み合わせて動かす場合、`ppz8.c`自身は本物の
`struct ppz8_channel`（`uint64_t ptr`等、固定小数点の再生位置管理に64bit幅を使っている）
に依存しており、**`uint64_t`の壁は`ppz8.c`側にそのまま残る**。今回シムで迂回できたのは
あくまで「`fmdriver_pmd.c`が`ppz8.c`の実装を知らずに関数ポインタ越しにしか触らない」
という構造を使って、`fmdriver_pmd.c`単体のコンパイル確認から`ppz8.c`を除外しただけ。
`ppz8.c`自体のSmallerC移植性は本調査の対象外で未確認のまま。

### 5-2. `fmdriver_pmd.c:1892`の`int64_t`は「32bit加算のオーバーフロークランプ」

該当行（PPZ8チャンネルへの周波数出力`pmd_ppz8_freq_out`内）:
```c
det += part->detune;
det *= freq >> 8;
int64_t outfreq = freq + det;
if (outfreq < 0) outfreq = 0;
if (outfreq > INT32_MAX) outfreq = INT32_MAX;
part->output_freq = outfreq;
```
`freq`は`uint32_t`（PPZ8用の周波数値、`actual_freq`とその上位16bitの合成）、
`det`はLFO・ポルタメント由来のデチューン値（`int32_t`）。**int64_tへの拡張は
「freq + detが32bit符号付き範囲を超えないかを安全に判定するためだけ」**で、
音程を決めるロジック自体は単純な加算とクランプであり、64bit精度の演算結果を
使っているわけではない（出力は最終的に`INT32_MAX`でクランプされる`int32_t`相当の値）。

これを、64bit整数を使わずに同じクランプ結果を得られるよう、符号なし演算の
ラップアラウンド検出に書き換えた:
```c
int32_t outfreq;
if (det >= 0) {
  uint32_t sum = freq + (uint32_t)det;
  if (sum < freq || sum > (uint32_t)INT32_MAX) {
    outfreq = INT32_MAX;
  } else {
    outfreq = (int32_t)sum;
  }
} else {
  uint32_t sub = (uint32_t)0 - (uint32_t)det;  /* -det をdet==INT32_MINでもUB無しで計算 */
  if (sub > freq) {
    outfreq = 0;
  } else {
    outfreq = (int32_t)(freq - sub);
  }
}
part->output_freq = outfreq;
```
`sum < freq`は「符号なし加算で桁上がりが起きた（= 数学的な真値がuint32_tの範囲を
超えた）」ことの標準的な検出方法で、元の`int64_t`版と同じ条件で`0`/`INT32_MAX`へ
クランプする。`det`が`INT32_MIN`の場合の単項マイナスは符号あり整数のオーバーフロー
（未定義動作）になるため、`(uint32_t)0 - (uint32_t)det`という符号なし減算で計算し回避した。
**桁あふれの可能性について**: `freq`自体が`actual_freq_upper`の値次第で理論上
`INT32_MAX`を超えうる（元コードもこのケースをクランプ対象にしていた）。書き換え後の
コードもこのケースを正しくクランプする（`det=0`でも`sum(=freq) > INT32_MAX`ならクランプ）
ことをコード上のロジックで確認済み。**ただし実際に鳴らして音程が正しいかは未確認**
（このロジックの正しさの主張は上記のコード上の対応関係のみに基づく）。

`ppz8.h`シム化により`ppz8.h`側の`uint64_t`（`struct ppz8_channel`の4フィールド）は
`fmdriver_pmd.c`のコンパイルパスから除外されたため、上記1箇所の書き換えだけで
`fmdriver_pmd.c`本体からの64bit整数演算は消えた。

### 5-3. `-huge`でのコンパイル実測: 新たに2つの壁が見つかり、いずれも回避

1. **`inline`キーワード非対応**: `doc/smlrc.md`に明記の通り（「**inline**, **_Bool**」は
   非サポート）、`fmdriver_common.h`の`static inline`関数5個（`read16le`/`read32le`/
   `u8s8`/`u16s16`/`fmdriver_fillpcmname`）がエラーになった
   （`Error in "/include/fmdriver_common.h" (6:14): Unexpected token inline`）。
   → `static inline` → `static`に機械的に置換して解決（SmallerCはそもそもインライン展開を
   しないコンパイラなので、`static`だけで意味は保たれる。5箇所、`sed`一発）。
2. **`Identifier table exhausted`（新発見、`-seg16`/`-seg32`検証では未到達だった壁）**:
   `inline`修正後、`-huge`コンパイルは`Identifier table exhausted`で失敗した。
   `smallerc-src/v0100/smlrc.c:191`で`MAX_IDENT_TABLE_LEN`は
   `(4096+1024+512) = 5632`バイトに固定定義されており（`smlrc.c:190-191`）、
   これは**識別子（変数名・関数名・構造体メンバ名等）の名前文字列を格納する
   コンパイラ内部テーブルの総バイト数**で、コマンドラインフラグでの変更手段は無い
   （`smlrc.c`の引数パース部を全数確認したが該当オプションは存在しない。ソース側の
   `#define`を書き換えて`smlrc`本体をリビルドしない限り拡張できない）。
   `fmdriver_pmd.c`（6114行）だけで、この5632バイトの識別子名前表を使い切ってしまう。
   **切り分け実験**: `fmdriver_pmd.h`＋`fmdriver_common.h`のヘッダだけ（関数本体なしの
   `main`のみ）を同条件でコンパイルしたところ`exit=0`で問題なく通った
   （`scratchpad/pmdcompile/try4_headers_only.mjs`で実測）。つまり**ヘッダ側の型・宣言群
   だけでは枯渇しない。`fmdriver_pmd.c`本体（6114行の関数群・ローカル変数・静的関数名の
   総量）が原因**であることを確認した。
   → **今回はこの壁を機械的に回避する試みはしていない**（`fmdriver_pmd.c`を複数の
   翻訳単位に分割する必要があり、それ自体が構造への手を入れる作業になるため、
   本調査のスコープ外と判断）。

### 5-4. 結論: `-huge`で`fmdriver_pmd.c`はコンパイルできたか

**できなかった。** `int64_t`の書き換えと`inline`の機械的置換で従来の壁は超えたが、
**`Identifier table exhausted`という、SmallerCコンパイラ自体の固定内部リソース
（5632バイトの識別子名前表）に起因する新しい壁で止まった。** これは`-seg16`/`-seg32`/
`-huge`のどのモードでも同じ値（`MAX_IDENT_TABLE_LEN`はモード非依存の定数）であり、
**32bit/64bit整数の話とは独立した、別種の制約**。

したがって:
- **サイズ実測（コード/データが64KBに収まるか）は今回も未達**。`.asm`が出力されない
  ため測定不能（`out3.asm`は生成されていないことを確認済み。
  `scratchpad/pmdcompile/out3.i`は166,534バイトのプリプロセス結果のみ残っている）。
- 識別子テーブルの壁を超えるには、`fmdriver_pmd.c`を複数の`.c`ファイルへ分割し、
  現在`static`な関数・変数の一部を`extern`化する必要がある。これは
  「機械的な修正」の範囲を超え、**ファイル構成そのものの再設計**になる
  （かつ分割後は今度は`MAX_GLOBALS_TABLE_LEN`——`cgx86.c:43`で
  `MAX_IDENT_TABLE_LEN`と同値と定義——の制約が新たに効いてくる可能性があり、
  「分割すれば必ず収まる」という保証も無い。これは未確認）。

## 結論の更新: (b)の見通し

**従来の結論（32bit/64bit整数の壁）に加えて、識別子テーブル枯渇という第三の壁が
新たに実測で確認された。** 3つの壁の関係:

1. `long`（32bit整数）の壁 → `-huge`／`-unreal`で**解消済み**（実測確認）。
2. `long long`（64bit整数）の壁 → `ppz8.h`を不透明型シムに差し替え、`fmdriver_pmd.c`側の
   唯一の実演算箇所(`:1892`)を32bit安全な書き換えに直すことで、**`fmdriver_pmd.c`単体に
   関しては解消済み**（実測確認）。ただし`ppz8.c`本体側は未解決のまま。
3. **識別子テーブル枯渇（新発見）→ 未解決**。`fmdriver_pmd.c`（6114行）を単一の翻訳単位
   としてコンパイルする限り、SmallerCの固定5632バイト予算を超える。回避には
   ファイル分割という設計変更が要る。

**(b)は依然として「現実的」と断言できない。** むしろ、1と2の壁を実際に取り除いたことで
初めて3番目の壁が見え、**まだ壁の全体像が確定していない**（3を超えた先にさらに別の壁が
無いとは言えない）ことが分かった、というのが今回の実測の到達点。

## 次に確かめるべきこと（(b)の可否確定に向けて）

- **識別子テーブル枯渇の正確な発生量**: `fmdriver_pmd.c`のどこまでの行数・関数数で
  枯渇するかを二分探索的に実測し、「分割するなら何個の`.c`ファイルに、どういう単位で
  切ればよいか」の見積もりを作る。
- **分割後の`MAX_GLOBALS_TABLE_LEN`（`cgx86.c:43`、`MAX_IDENT_TABLE_LEN`と同値）の影響**:
  現状`static`な関数・変数を`extern`化すると、リンク時にグローバルシンボルとして
  積み上がる。分割すれば本当に解決するのか、それとも別の場所でまた枯渇するのかを
  実測する必要がある。
- **`ppz8.c`本体側の`uint64_t`依存の実測**: 今回は`fmdriver_pmd.c`が`ppz8.c`の型を
  知らないという構造を使って迂回しただけで、PPZ8（PCM音源）を実際に鳴らすには
  `ppz8.c`自身の64bit整数依存（固定小数点の再生位置`ptr`等）を解決する必要がある。
  未着手・未計測。
- **TSR/割り込み**: 今回のスコープ外だが、`-huge`が実モード/仮想8086モードのままである
  ことを確認できた（DPMI不要）点は、TSR化の設計を考える上でのプラス材料として
  次回に持ち越せる。ただし「識別子テーブル枯渇を解決してファイル分割した後の
  コード配置が、TSR常駐部とどう共存するか」は全くの未検証。
- **(c)（PMD.ASM移植）との比較**: 今回の実測で(b)側に新たな壁（識別子テーブル）が
  見つかったことで、(c)との工数比較の必要性はさらに高まった。(c)側の実装量は
  引き続き本調査の対象外で未計測。
