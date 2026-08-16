# MUCOM88 `#voice` タグ(外部音色バンク)実験記録

**これは実験であり製品採用ではない。** 目的は「`#voice <file>` を通せるか」を
測ることで、通ったこと自体は製品への組み込みを約束しない(採否は別途判断)。
このファイルが参照するパッチ
(`mucomweb/patches/0004-compilemml-processheader.patch`)は
**`mucomweb/CMakeLists.txt` からは適用されない**(冪等適用の対象外)。
`html/` `ui/` `net/` の製品側配線・`mucomweb/src/MucomWeb.cpp` 本体は変更していない
(パッチはリポジトリに残すが、適用後は `git apply -R` で作業ツリーへ差し戻し済み)。

## 0. 前提(確定済み事実。再調査不要として引き継いだもの)

- ビルド対象は `upstream/MucomWeb/mucom88`(同梱fork)。`upstream/mucom88`(本家)ではない。
- `CMucom::Init/Reset` は常に埋め込み既定バンク `bin_voice_dat`
  (`upstream/MucomWeb/mucom88/src/bin_voice.h`、8192byte=256スロット×32byte、
  名前はオフセット26-31)をロードする。
- `#voice <file>` は `CMucom::Compile()`
  (`upstream/MucomWeb/mucom88/src/cmucom.cpp:1244-1250`)内で
  `GetInfoBufferByName("voice")` → `LoadFMVoice()` により機能する**が**、
  `infobuf` は `CMucom::ProcessHeader(char *text)`(cmucom.cpp:1140-1172)が
  MMLを1行ずつ走査して `#` 始まりの行を溜め込むまで空(`NULL`または未初期化)のまま。
- `mucomweb/src/MucomWeb.cpp` の `CompileMML()` は `Compile()` を直接呼び、
  `ProcessHeader()` を一度も呼ばない(grepでは行を読み飛ばす既知の落とし穴があるため
  python `decode('cp932')` で確認済み。文字列 "ProcessHeader" は同ファイルに一切出現しない)。
  → **今回のパッチ適用前は `#voice` タグは常に無視される。**

## 1. 【実測】バイト差分

`tools/experiment_voice_bank.mjs` 内で埋め込み既定バンク
(`upstream/MucomWeb/mucom88/src/bin_voice.h` から実測抽出、md5
`91e674c35e030c76ea99dbc23c963592`)と、サンプルMML集システムディスク
`MUCOM88_V1.7_...ACTRAISER` 内の `voicedat`(先頭8192byte、md5
`b7adcf32a1a0e951a3bd51855a9138bb`)を32byte単位のスロットでバイト比較した。

**結果: 256スロット中235スロットで中身が異なった。**
差分バイト量(絶対値和)が最大のスロットの一つとして **slot29** を主実験に使用。

## 2. パッチ内容

`mucomweb/patches/0004-compilemml-processheader.patch`
(experimental、CMakeLists.txtからは自動適用されない)は
`mucomweb/src/MucomWeb.cpp` の `CompileMML()` に

```cpp
mucomCompiler.ProcessHeader(const_cast<char *>(mml.c_str()));
```

を `Compile()` の直前に1行追加するだけ。`CMucom::CompileFile()`
(cmucom.cpp:1356-1358)が実際に使っている呼び出し順序
(`ProcessHeader(mml); Compile(mml, ...);`)をそのまま踏襲した。
シグネチャ(`int ProcessHeader(char *text)`, cmucom.h:245)はソースで確認済み、推測なし。

## 3. 【実測】ビルド

- パッチを `git apply` で `mucomweb/src/MucomWeb.cpp` に直接適用(このファイルは
  submoduleではなくFMSound本体が直接所有するため、0001-0003と異なりsubmodule側
  ではなく本体側に当てる。README.mdの手順どおり `emcmake cmake -S . -B build-web
  -DWEB_BROWSER=1 -DCMAKE_BUILD_TYPE=Release && cmake --build build-web -j4`)。
- **ビルドは成功した**(既存の `build-web/` に対する差分ビルド、所要時間は数秒〜
  1分程度、タイムアウトなしで完了)。

## 4. 【実測】判定実験(`tools/experiment_voice_bank.mjs`)

`VOICE_TEST_DIR=<抽出済みdatファイルのディレクトリ> node
tools/experiment_voice_bank.mjs` で実行。`renderFramesForTest()` が返す
PCM絶対値和(absSum)を指標にした。全7チェック **PASS**。

### 陽性対照(パッチと無関係。既定バンク内のみで実施)
既定バンクの slot0 (`@0`) と slot29 (`@29`) をそれぞれ `A l4 @n cdefgab` で
レンダリングして比較:

- `@0`: absSum = 4,107,408
- `@29`: absSum = 9,109,162 (**異なる**)

→ 「スロットの中身が違えば absSum が変わる」ことをエンジン側で確認できた
(この対照が取れて初めて、後段の「変わらない」を意味のある否定として読める)。

### 本実験: 同一スロット番号、`#voice` なし/ありの比較
`@29` を、(1) `#voice` タグなし(常に既定バンク) と (2) `#voice
/voicedat_disk.bin`(MEMFSへ書き込んだACTRAISERディスクの `voicedat`)の
2条件でレンダリング:

- `#voice` なし: absSum = 9,109,162
- `#voice` あり(disk voicedat): absSum = 29,405,772 (**異なる**)
- コンパイルログに `#error` なし。ログには `#load:/voicedat_disk.bin (8192)` と
  `Used FM voice:1` が出力され、外部ファイルが読み込まれたことも確認できる。

### 整合性確認(round-trip)
既定バンクそのものをファイル化し `#voice` 経由で読ませた場合、`#voice` なしと
**完全一致**(absSum = 9,109,162 = 9,109,162)。中身が同じなら結果も同じになる、
という当然の性質が壊れていないことを確認した(パッチが妙な副作用を持ち込んで
いないことの裏付け)。

## 5. 【実測】既存検証群への影響

パッチ適用後、`tools/verify_*.mjs` 全34本を実行し、**全34本が exit code 0・
FAIL 0件で通過**した(個別ログは `[FAIL]` 行の有無で判定、grepの2バイト文字
誤認問題を避けるため各スクリプトの標準出力を素通しでカウント)。
`ProcessHeader()` を追加で呼ぶことによる既存挙動への悪影響は確認されなかった。

## 6. 未確認・今回のスコープ外(推測を含む)

- **旧記録(このscratchpadに残っていた `voice_test/` ネイティブ版ハーネスでの
  先行実験)は「ACTRAISERの実曲(`stg001.muc`)で使われている具体的なスロット番号
  (@97/@90/@14/@11/@4/@0/@26等)ではどのデータを与えても `FM Voice not found` で
  失敗した」と記録している。今回の実験(slot29を任意に選んで直接 `@29` で鳴らす)
  はこれと矛盾する結果(成功)になった。** 両者の相違点として考えられる仮説
  (未検証):
  - 実曲が参照する特定スロット番号の `hed` バイト(有効フラグ)が、たまたま
    Z80側コンパイラの検証条件を満たさない値だった可能性(全スロットが
    無条件に有効になるわけではないかもしれない)。
  - ネイティブハーネス側の `CompileFile()` 経路と、今回のwasm側 `CompileMML()`
    +パッチ経路とで、`option` 引数や `CMUCOM_COMPILE_*` フラグの既定値に
    見落としている差がある可能性。
  - この食い違いの真因は**未特定**。「slot29のような単純な指定では通る」ことと
    「特定の実曲の特定スロット指定では過去に落ちた」ことの両方が事実として
    併存しており、後者を今回のパッチ適用後の環境で再現実験していない。
- 個別 `VOICE.n` ファイル(集約 `voicedat` ではなく分割ファイル)の
  スロットへの対応規則は今回も未特定(前回調査からの持ち越し、未解明のまま)。
- 全256スロットのうち235個が異なっていた具体的な楽器名対応は今回は調べていない
  (バイト単位の差分のみ確認、意味的な差の分類は未実施)。

## 7. 結論

**`#voice` タグは、`ProcessHeader()` 呼び出しの欠落さえ埋めれば
(少なくとも今回試した slot29 / ACTRAISERディスクの `voicedat` の組み合わせでは)
機能する。** 外部バンクの読み込みで実測波形(absSum)が変わることを、陽性対照
(既定バンク内でのスロット差)と整合性確認(既定バンクの往復)の両方を伴って
確認した。一方で、旧ネイティブハーネス実験が「実曲の特定スロットでは
依然として失敗する」と記録しており、この食い違いは未解決のまま残る。
**したがって「`#voice` は無条件に生かせる」とまでは言い切れず、
「配線(ProcessHeader欠落)を直せば機能する経路はあるが、特定条件下での
失敗が別に存在する可能性が残っている、未確定」が正確な結論。** 製品コードへの
本採用は、この食い違いを解消してから判断すべき。
