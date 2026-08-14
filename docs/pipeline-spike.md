# WebPaint98 → FMSound → WorkbenchNP2 → WebNP2 パイプライン実験記録

日付: 2026-08-14

目的: FMSoundで作ったPMDの曲データ(`.M`)をWorkbenchNP2でビルドするプログラムに
載せ、WebNP2上で鳴らせるかを端から端まで細く通す。

## (1) WorkbenchNP2が実際にビルドできるもの（事実）

- アセンブラ: **NASM 2.16.03**（wasm版、upstream無改変）。出典:
  `WorkbenchNP2/README.md:35-40`, `:437`
- Cコンパイラ: **SmallerC**（BSD 2-Clause、upstreamパッチ1件）。
  `smlrpp → smlrc -seg16 → NASM -f elf → smlrl -small` で
  16-bit DOS small-model MZ EXEを生成。出典: `README.md:66-67`, `:438`
- 成果物形式: `.asm`は`.COM`（`toolchain/build-com.mjs`）または
  `exebin.mac`使用でMZ `.EXE`（`toolchain/build-exe.mjs`）。`.c`はMZ EXE
  （`toolchain/compile.mjs`）。出典: `README.md:45-48`
- WebNP2での実行経路: 成果物を**PC-98 2HD 1232KB FAT12イメージ(.xdf)**へ
  書き込み、WebNP2のURLクエリ`fd2=`（成果物のみFD、推奨）または`fd1=`
  （起動FDへ同梱、`build-boot-fd.mjs`使用）で渡す。DOSプロンプトで手動実行、
  またはAUTOEXEC自動実行。出典: `README.md:25`, `:361-400`
- ファイル保管庫はIndexedDB内の**文字列専用**ストア（本タスクの前提どおり、
  実装未読ではなく既知情報として引き継いだ）。バイナリ添付不可。

## (2) PMDドライバの扱い（事実）

- `FMSound/upstream/pmdmini`は**PC-98実機用のPMD.COMドライバではない**。
  READMEに明記: 「pmdxmms（Linux XMMSプラグイン）由来、SDL2でホストOS上に
  再生するプレイヤー」（`upstream/pmdmini/README.md`冒頭）。ソースはC++
  （`src/pmdmini.cpp`, `src/pmdwin/`, `src/ymfm/`）で、DOSバイナリは含まれない。
- ローカル環境全体（`_emulator`配下）を検索したが`PMD.COM`等の実機ドライバ
  バイナリは**見つからなかった**。→ **入手できず**。
- WorkbenchNP2側にPMD/常駐ドライバに関する記述は無く、TSR自体は
  `ide/vendor/webnp2/webnp2-embed.js`のペースト用`PASTE.COM`（無関係な別TSR）
  でのみ言及。NASMはTSR作成に必要な機能（`org 100h`, `int 21h AH=31h`等）を
  制限なく扱えるはずだが、**実際にTSR化して常駐させた実績はWorkbenchNP2内に
  無く未検証**。

## (3) 実際にやったこと・到達点

1. `upstream/pmdmini/PC-98_Hartmann_s_Youkai_GIrl.M`（7107バイト、権利不明の
   ためローカル実験専用）をPythonスクリプトで16バイトごとの`db`列に変換し、
   最小asm（`org 100h`→曲データを`db`で埋め込み→メッセージ表示→`int 21h AH=4Ch`
   で終了、PMD再生コードなし）を`/private/tmp/.../pmdspike/spike.asm`
   （**FMSound/WorkbenchNP2いずれのリポジトリにも置かず**scratchpad配下）に生成。
2. `node toolchain/build-com.mjs spike.asm -o spike.xdf`を実行し、**ビルド成功**。
   `7171-byte COM`（データ7107B+コード64B相当）、FAT12 xdfも生成できた。
   → **ソース内`db`配列としての曲データ埋め込みはWorkbenchNP2のビルド段を
   問題なく通過することを確認**。
3. `python3 http.server`にCORSヘッダを付けたローカルサーバでxdfを配信し、
   `webnp2-dev-5273`（`http://localhost:5273/?freedos=1&run=1&fd2=...`）を
   ブラウザで開いた。FreeDOS起動メッセージ（XMS driver等）までは表示された。
4. **DOSプロンプトへ到達する前に画面が停止し、そこから先を確認できなかった。**
   `_webnp2_disk_access_count()`が5のまま変化せず、`_webnp2_dbg_regs_size`等の
   デバッグAPIが数秒後には`undefined`になる（ページ/wasmモジュールの入れ替わりを
   示唆）という不安定な挙動を観測した。原因切り分け中に気づいたのは、
   **このブラウザタブが本タスクと別セッションの自動操作に複数回横取り・close
   されていた**こと（tabIdを固定しても数秒でorigin/titleが別サイト
   `localhost:8777`(FMSound)に変わる事象を計5回観測）。したがって観測した
   「フリーズ」がWebNP2固有の問題か、共有ブラウザの競合によるものかを
   **切り分けられていない**。
5. 結論として**音は出せていない**。PMD再生コードそのものも未実装（ドライバが
   無いため実装しても検証不能なので後回しにした）。

## 次に必要なもの（優先度順）

1. **[最優先] ブラウザ検証環境の専有**。共有プレビューブラウザではなく、
   本タスク専用タブ/プロファイルでWebNP2の起動〜DOSプロンプト到達を
   再検証する必要がある。それができない限り(3)のboot段の成否自体が未確定。
2. **PMD.COM（またはPMD86.COM）実機ドライバ本体の入手**。配布条件の判断は
   本タスク対象外だが、無いと(2)後半（常駐・再生指示）の検証に進めない。
3. ドライバが無い前提での代替: `pmdmini`のC++再生ロジックを参考にした
   自作ミニマムFM再生ルーチン（ドライバ常駐無し、直接OPNAレジスタ制御）を
   asmで書き、`.M`を解析して鳴らす案。工数は大きいがドライバ入手不要。
4. WorkbenchNP2でのTSR（常駐化）実績確認・最小TSRサンプルでの動作検証
   （現状は未実績、NASM自体の機能としては対応と推測されるのみ）。

## (4) FMSoundの出力形式の見当

- 実測ベースで「ソース内`db`配列としての埋め込み」は少なくとも
  **ビルドパイプライン（NASM wasm→COM→FAT12）は通る**ことを確認済み
  （7107バイトで問題なし）。
- 形式は**asmの`db`列が第一候補**。理由: WorkbenchNP2はNASMのみが確立した
  Cコンパイラ経路より枯れており、`build-com.mjs`のCLI/IDE両方で検証済みの
  経路。CはSmallerCのsmall-modelで単一セグメント64KB制約があり、大きな
  曲データ配列を扱うにはASM側の`db`の方が制約が少ないと見られる（未検証の
  見立て）。
- ラベル名は`song_data:`のような単純な識別子で問題なし（今回`song_data`/
  `song_data_end`で通した）。
- 分割の要否: 今回の7107バイト単曲では不要だった。ただしWorkbenchNP2は
  「1ファイル＝1プログラム」制約（`#include`不可、複数ファイル不可、
  README.md:14-16）があるため、**曲データはプログラム本体と同一ファイル内に
  埋め込む前提**になる。長大な曲や複数曲を扱う場合、1ファイルのサイズ上限
  （wasm NASMの実用上限は未計測）に達する可能性があり、そこは**未確認**。

## 未確認・未到達点まとめ

- WebNP2上でDOSプロンプトに到達できるか（ブラウザ競合により未確定）
- 曲データを含むCOMが実機相当環境で正常に読み込まれるか
- PMDドライバの入手可否そのもの（ローカルには無い）
- ドライバがあった場合の常駐化・INT呼び出し手順（一次情報未確認）
- wasm NASMの1ファイルあたりの実用サイズ上限
