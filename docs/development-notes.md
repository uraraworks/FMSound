# 開発ノート(旧README)

2026-08-15、README.md を公開向けの内容に書き直すにあたり、それまでの開発ノート
(upstream解析・設計判断・実測で判明した性質・検証環境の癖)をこちらへ退避したもの。
中身は当時のまま(一部見出しのみ整理)。将来同種の作業をするときの参考にする。

---

# FMSound — FM音源MMLプレイヤー Web版

PC-88 / PC-98 の FM音源ドライバ（MUCOM88 / PMD）を wasm 化し、
**パート単位の演奏状態をリアルタイム表示する Web プレイヤー**を作る。

参考にする表示は PC-98 の MMP / FMDSP 系の画面
（FM1-6・SSG が縦に並び、音色番号・音程・ゲート・音量が流れるもの）。

## なぜ _emulator 配下か

- 実態は「レトロ音源チップ（OPNA）を emscripten で wasm 化し、自作 Web フロントを被せる」作業で、
  WebNP2 / WebX68k と同じ性格。
- `_WebService/` は deploy/ を持つサーバー運用型サービスの置き場。本プロジェクトは
  wasm + JS の完全静的アプリでサーバー不要のため、そちらの運用モデルには乗らない。
- MUCOM88 は PC-88、PMD は PC-98 と機種をまたぐため、機種フォルダ（PC98/ X68K/）には入れられない。
  将来 X68K の MDX / ZMUSIC（YM2151）へ広げる場合も、この「FM音源」というくくりなら収まる。

## 構成

```
FMSound/
  emsdk -> ../PC98/emsdk    # ツールチェーンは PC98 と共有（シンボリックリンク・削除厳禁）
  upstream/                 # 参照する外部リポジトリ（いずれも独立 repo）
    mucom88/                # OpenMucom88（Z80 VM + fmgen で本物のドライバを実行）
    MucomWeb/                # 上記の emscripten 移植。export は compileMML/stopMusic のみ
    98fmplayer/              # PMD/FMP をネイティブCで再実装 + libopna + FMDSP可視化
    pmdmini/                 # PMD の小型実装（参考のみ。GPL なのでリンクしない）
  net/                     # URL指定の曲データ取得層（ZIP/LZH展開・SJISファイル名・HTML誤取得検出）
    pmd-pcm.js             # PMD側PCM(.PPC/.PZI/.PVI)をMEMFSへ配置する窓口。曲ごとの
                            #   専用ディレクトリへ書く(ルート直下だとupstreamのPCM探索が
                            #   opendir("")失敗で必ず外れるため。docs/pmd-pcm-support.md §1参照)
```

## 各プロジェクトの要点

### MUCOM88（動的実行アプローチ）

Z80 エミュレータ（`src/Z80/`）＋ fmgen で、当時のドライバ Z80 バイナリ
（`src/bin_17/bin_*.h` に C 配列として埋め込み済み）をそのまま走らせる。
PC-88 エミュレータではなく、Z80 + 16KB×4バンク + OPNA だけの専用 VM。

演奏状態の取得口は**すでに存在する**：

- `src/cmucom.h:454` `int CMucom::GetChannelData(int ch, PCHDATA *result)`
- `src/cmucom.h:295-341` `PCHDATA`（Z80 ワークエリア 38 バイトのデコード結果）
  - `vnum`(音色) / `volume` / `quantize` / `fnum1,fnum2`(音程) / `detune` / `length`
  - `flag`: bit7=LFO, bit6=KEYOFF, bit4=TIE, bit3=MUTE
  - `pan`, `keyon`
- 実装（`src/cmucom.cpp:2255`）は `vm->GetChData(ch)` で Z80 メモリを直読みして展開している。

### PMD / FMP（静的移植アプローチ）

`fmdriver/fmdriver_pmd.c`（約5,900行）はドライバのネイティブC再実装。
**CPU エミュレーションは一切持たない**（Z80/8086 の痕跡ゼロ）。必要なのは `libopna/` のみ。

`fmdriver/fmdriver.h` に**ドライバ非依存の共通構造体**があり、PMD と FMP の両ドライバが
これを埋める（`pmd_work_status_update()` @ fmdriver_pmd.c:5824 ほか）：

```c
struct fmdriver_track_status {
  bool playing;  uint8_t ticks, ticks_left;
  uint8_t key, actual_key;          // 音程 / LFO・ベンド適用後
  uint8_t tonenum, volume, gate;
  int8_t  detune;
  char    status[9];                // LFO状態の表示文字列
  bool    fmslotmask[4];
  bool    ssg_tone, ssg_noise;
};
```

トラックは21本（FM1-6 + FM3拡張×3 + SSG×3 + ADPCM + PPZ8×8）。

`fmdsp/` が目標そのものの可視化実装（PC-98フォントROM・東雲フォント同梱）。

### net/（URL指定の曲データ取得層）

`fmdsp/` `ui/` と同じ「素のES module・TypeScript/バンドラなし」の共有ディレクトリ。
PC98/WebNP2 の `src/api/{disk-fetch,archive,zip,lzh,archive-util}.ts` の知見を移植したもの
（HTMLページ誤取得の検出・ZIP/LZH展開・SJISファイル名変換）。ZIP/LZH展開後は
`net/song-select.js` の `findSongCandidates()` で `.muc`(MUCOM)等の再生候補と、
同ディレクトリ内の関連ファイル（`voice.dat`/`mucompcm.bin` 等）をまとめて取り出せる。
中継サービスのURLは既定で空（＝中継しない）。有効化するには `net/fetch.js` の
`NET_PROXY_BASE` 定数を書き換える（1箇所のみ）。

## 設計方針

**共通スキーマは `fmdriver_track_status` をそのまま採用する。**
MUCOM の `PCHDATA` はここへ素直に写せる（`quantize`→`gate`、`fnum1/2`→`actual_key`）。
逆向きだと PMD 側の情報が落ちるため、この向きが上位互換。

```
 [MUCOM88 wasm]          [PMD/FMP wasm]
 GetChannelData        fmdriver_track_status
        \                     /
         +--- 薄いアダプタ ---+
                   |
        共通 TrackStatus (TypedArray)
                   |
            Canvas 描画層（1本）
```

## 既知の課題（初期時点）

1. **MucomWeb の export が2本だけ**（`compileMML` / `stopMusic`）。`getChannelData` の追加は容易だが、
   現状は `emscripten_set_main_loop` + OpenAL 構成なので AudioWorklet へ作り直しが要る。
2. **98fmplayer は wasm 対応ゼロ**。ただし fmdriver/ と libopna/ は素の C99 で、
   フロントエンド（sdl/gtk/win32/curses）ときれいに分離されている。
3. **音と表示の同期**が最大の山場。`track_status` はドライバ割り込み時点の状態だが、
   Web Audio は先読みバッファを持つため rAF で素直に読むと表示が音より先行する。
   → レンダリング時刻タグ付きで状態をリングバッファに積み、`currentTime` で引き当てる。
4. **ライセンスが割れている**（方針を先に決めること）
   - `98fmplayer` … BSD 2-Clause（ほぼ自由）
   - `mucom88` … **CC BY-NC-SA 4.0**（非商用・継承）→ 同居させると全体が実質 NC+SA
   - `pmdmini` … **GPL** → リンクしない。参考閲覧のみ

## 進捗（2026-08-04 時点）

### 完了

**MUCOM88 側（`upstream/MucomWeb/`）— 課題1・3 解決済み**

- `getChannelData()` embind 追加 → Z80 ワークエリアから JS まで疎通
- CMakeLists を現行 emcc(6.0.5) 対応化。`-s WASM=0`(asm.js) → wasm、`--llvm-lto 1` / `-g4` 撤去
- **OpenAL 撤去 → AudioWorklet 化**（SharedArrayBuffer 不使用 = COOP/COEP 不要）
- スナップショットリング（wasm ヒープ上のフラット配列、2048 エントリ）
- `playFrame` 同期 + 二分探索 + 較正UI

実測: 同期誤差 **残差 2.3ms**、underflow 0、キュー深度 36.9ms、スナップショット精度 4.6ms（256フレーム刻み）

**PMD 側（`pmdweb/`）— 課題2 解決済み**

- 98fmplayer を wasm 化。`libopna` + `fmdriver` + `common/fmplayer_file.c` のみの最小構成
  （GUI/SDL/FMDSP/s98gen/SIMD/ROMローダは除外）
- **upstream 無改変**。`opna_timer_set_mix_callback()` の既存フック機構で足りた
- 21トラックを `fmdriver_track_status` 準拠の共通スキーマでリングへ
- AudioWorklet・同期・較正UI は MucomWeb と同方式

実測: 同期誤差 **残差 4.6ms**、underflow 0、21トラック中16が変化（曲の使用トラック数と一致）

### 両エンジンの性質の違い（実測で判明）

| | MUCOM88 | PMD |
|---|---|---|
| 記録方式 | 256フレームごとの**時間サンプリング** | 割り込みごとの**イベント記録** |
| 粒度 | 常に 4.6ms | 状態変化と1:1（テスト曲で平均 8.69ms 間隔 / 64フレーム格子=1.15ms 解像度） |
| 取りこぼし | 理論上あり得る | **原理的に無い** |

MUCOM が時間サンプリングなのは submodule 非改変の制約。実用上 4.6ms で十分。

### 1アプリ化（2026-08-14 完了）

MUCOM88/PMDは**1つのアプリ**として配信する。音源ドライバの選択はURLクエリ `?driver=pmd` /
`?driver=mucom` で行う（既定値は `pmd`。理由: このツール一式の目的は「Webで PC-98 の
ゲームを作る」ことであり、PC-98の音源ドライバはPMD。MUCOM88はPC-88用で側枝にあたる。
以前は既定が`mucom`だったが、これはMUCOM88側のエディタ機能が単に先に完成していた
という順番の都合であり、目的に照らして`pmd`へ変更した（課題C, 2026-08-14））。

**構成**:

```
FMSound/
  html/                # 共有アプリ本体(mucomweb/pmdweb 両方から使う唯一のソース)
    index.html         # 共通シェル(ヘッダー/canvas/ツールバー/設定/フッター)
    app.js             # 共通ブートストラップ。?driver=を見て mucom-app.js / pmd-app.js を
                        #   動的import(import())する -> 選ばれなかった側のwasmは一切fetchされない
    mucom-app.js        # MUCOM88音源ドライバ固有ロジック(MMLエディタ・コンパイル等)
    pmd-app.js           # PMD音源ドライバ固有ロジック(プレイヤーのみ、エディタは次のタスク)
    mucom-adapter.js, mml-editor.js, mml-tokens.js, mucom-worklet.js, pmd-worklet.js
    samplja.muc                # MUCOM88: 日本語コメント表示の確認用テストファイル(?debug=1限定)
    sample_fur_elise.M         # PMD側の同梱サンプル(エリーゼのために冒頭、NOTICE.md参照)
    sample_fur_elise_mucom.muc # MUCOM88版の同じサンプル(tools/gen_sample_fur_elise.mjsが生成)
  mucomweb/CMakeLists.txt  # ../html を build-web/ へ同期してmucom88.js/.wasmをビルド
  pmdweb/CMakeLists.txt    # ../html を build-web/ へ同期してpmdweb.js/.wasmをビルド
  tools/build_dist.sh      # 両方のbuild-web/からwasmを集め、dist/ を1ディレクトリに組み立てる
                            # (GitHub Pagesはこのdist/を配信する想定)
```

- `mucomweb/build-web/` `pmdweb/build-web/` は**それぞれ自分の音源ドライバのwasmしか持たない**
  （個別開発・単体確認用。他方の `?driver=` に切り替えると404になるのは既知の制約）。
  **両ドライバを切り替え可能な状態で確認するには `tools/build_dist.sh` で組み立てた `dist/` を見ること**
- 同梱サンプルは自作曲のみで、両ドライバとも同じ曲（エリーゼのために冒頭、
  パブリックドメイン曲からのMML書き起こし）にしている。PMD側は東方Projectアレンジ曲
  （権利未確認）を同梱から外し `html/sample_fur_elise.M` を同梱、MUCOM88側は
  古代祐三氏の従来サンプル（`sampl1.muc`等、GitHubから取得するものも含む）の同梱を
  やめ、同じ曲を移植した `html/sample_fur_elise_mucom.muc` を同梱している
  （`NOTICE.md`、`tools/sample_fur_elise.mml`、`tools/sample_fur_elise_mucom.mml`、
  `tools/verify_sample_fur_elise.mjs`、`tools/verify_mucom_fur_elise.mjs`参照）。
  MUCOM88側の `samplja.muc`（日本語コメント表示の確認用テストファイル）は
  利用者向けサンプルではないため、`?debug=1` のときだけリンクを表示する。

### 公開前の仕上げ（2026-08-16〜17 完了）

- **ADPCM(Kパート)対応。** MUCOM88標準PCMバンク `html/mucompcm.bin` を同梱し、
  曲コンパイル成功のたびに `LoadPCM()` を呼ぶようにした。解決できない `#pcm` は
  無音にならず標準バンクで鳴る（旧記述「無音になる」は誤りだったため
  README/NOTICE.md/help.html を訂正済み）。46曲での実測は
  `docs/mucom-adpcm-corpus-measurement.md`、検出層は `ui/mml-caveats.js`
  （`STANDARD_PCM_BANK_NAME` 判定）。
- **UIの日英対応。** 辞書方式（`ui/i18n.js`）。決定順は
  記憶(localStorage、明示操作時のみ書込) > `?lang=` > `navigator.language`。
  切替は1ボタン（押すと切り替わる先の言語名を表示）。検証: `tools/verify_i18n.mjs` /
  `tools/verify_lang_pref.mjs` / `tools/verify_lang_toggle_label.mjs`。
- **使い方ページ** `html/help.html`（日英、`data-lang` 2ブロック方式）と
  ヘッダーのヘルプボタン。節の集合一致を `tools/verify_help_page.mjs` が検査。
- **スクリーンショット生成** `tools/gen_help_shots.mjs`。npm依存を足さず、
  macOSのChromeをheadlessで起動しCDPをNode組み込みWebSocketで直叩きする方式。
- **ファイル選択/D&Dでの書庫(zip/lzh/d88)対応。** URL読み込みと同じ展開経路を
  共有（`tools/verify_open_file_archive.mjs`）。
- **FMDSPのミュート機能。** トラック行クリック/レベルメータークリック
  （リズムはRHY列）でパート単位ミュート。ホバー枠、3段階の暗色表示
  （通常/ミュート/曲が使っていない、色相を変えず係数乗算で明度のみ落とす）。
  「曲が使っていない」判定はMUCOM88は常時、PMDはこのアプリでコンパイルした
  場合のみ可能（済コンパイル済み`.M`/`.m`読込では不可）。検証:
  `tools/verify_track_click_hit.mjs` ほか `verify_*mute*.mjs`/`verify_*hover*.mjs`
  一式。
- **右ペイン。** FRAMES PER SECOND を実装（ホスト描画ループの実測、ドライバ
  データ不要）。CPU POWER COUNT/VOLUME DOWN/PGM NUMBER は出せない値として
  暗色化（理由の詳細は `docs/right-pane-data.md` §8）。検証:
  `tools/verify_fps_counter.mjs` / `tools/verify_right_pane_unavailable_colors.mjs`。

### 検証環境の注意

ブラウザプレビュー環境の `ctx.outputLatency` は **168ms**（仮想オーディオデバイス）。
実機では 10〜30ms 程度になる。`difference` が 200ms 超でも異常ではなく、
**`difference - outputLatency - キュー深度` の残差で評価すること**。

自動ブラウザ操作でのUI検証では、以下の癖がある(公開前の仕上げタスクで実測、2026-08-15)：

- `computer` ツールの座標クリックが、`ref` ベースのクリック同様に反応しないことがある
  （原因未特定）。反応しない場合は `javascript_tool` で `element.click()` を直接呼ぶと
  確実に検証できる（本物の操作結果は変わらない。あくまで自動操作側の癖）。
- ブラウザの `localStorage` は、同一originの**別タブ・別セッション**が裏で
  `pagehide`/`visibilitychange` の度に自動保存(flush)し続けるため、
  `localStorage.clear()` を呼んでもすぐ別の内容で上書きされることがある。
  下書き(draft)関連の検証をやり直すときは、対象のタブ自身の入力欄を先に空にしてから
  保存させる（他のタブ任せにしない）。
- `toDataURL()` で取得した数万文字のbase64文字列を、ツール呼び出しの往復で
  安定して受け渡せないことがある（出力が意図せず別内容と混ざる形で欠損した）。
  大きなバイナリを画像として保存したい場合は、ブラウザのcanvas経由に頼らず、
  同じ描画コード(fmdsp/以下)をNodeから直接呼んで素のPNGエンコーダで書き出す方が
  確実（`tools/gen_og_image.mjs` 参照）。

## メモ

- OPNA は 98fmplayer が `libopna`（自前実装）、mucom88 が `fmgen`（cisc氏）と別実装。
  fmgen は NP2 系と同系統なので、WebNP2 での知見がそのまま通用する。
  ただし**コードの流用先は無い**（両者とも音源を自前で持っているため）。

## バージョン表示

FMDSP タイトル欄の `Ver YY.MM.DD` とページフッターの識別子は、手動採番ではなく
**git のコミット日時・ハッシュから自動生成**している（`tools/gen_version.py` →
`ui/version.js`、ビルド時刻は使わないので同じコミットなら常に同じ文字列になる）。
更新したい場合は該当コミットを作るだけでよく、直接編集する場所は無い
（詳細: `docs/fmdsp-layout.md` §11）。

## 生成物ファイル一覧

以下は**手で編集しないこと**。元データを変更したら生成スクリプトを再実行する。

| 生成物 | 生成元 | 生成スクリプト |
|---|---|---|
| `ui/version.js` | gitのコミット日時・ハッシュ | `tools/gen_version.py` |
| `html/sample_fur_elise_mucom.muc` | `tools/sample_fur_elise_mucom.mml` | `tools/gen_sample_fur_elise.mjs` |
| `pmdweb/src/rhythm_rom.c` / `pmdweb/src/rhythm_rom.h` | `html/rhythm/2608_*.WAV`（自作リズム波形。実機ROM不使用） | `tools/gen_rhythm_rom.py` |

`pmdweb/src/rhythm_rom.c` は `html/rhythm/2608_*.WAV` をYM2608リズムROM形式
(8KB・ADPCM-A圧縮)へ変換したもので、**WAVファイルを差し替えても
`tools/gen_rhythm_rom.py` を再実行するまでビルドへ反映されない**
（`pmdweb`のビルド自体はWAVファイルを直接参照しない）。領域表・変換方式の
詳細は `docs/pmd-pcm-support.md` §4参照。決定論性（同じ入力から常に同じ
バイト列が出ること）は `tools/verify_rhythm_rom.mjs` が検証している。
