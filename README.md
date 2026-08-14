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
    MucomWeb/               # 上記の emscripten 移植。export は compileMML/stopMusic のみ
    98fmplayer/             # PMD/FMP をネイティブCで再実装 + libopna + FMDSP可視化
    pmdmini/                # PMD の小型実装（参考のみ。GPL なのでリンクしない）
  net/                     # URL指定の曲データ取得層（ZIP/LZH展開・SJISファイル名・HTML誤取得検出）
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
`NET_PROXY_BASE` 定数を書き換える（1箇所のみ）。UIへの配線は別タスクで行う。

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

## 既知の課題

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

MUCOM88/PMDは**1つのアプリ**として配信する。音源ドライバの選択はURLクエリ `?driver=mucom` /
`?driver=pmd` で行う（既定値は `mucom`。理由: MUCOM88側が先に完成しており、素のURL
`?driver`なしでアクセスする既存ユーザーの体験を変えないため）。

**構成**:

```
FMSound/
  html/                # 共有アプリ本体(mucomweb/pmdweb 両方から使う唯一のソース)
    index.html         # 共通シェル(ヘッダー/canvas/ツールバー/設定/フッター)
    app.js             # 共通ブートストラップ。?driver=を見て mucom-app.js / pmd-app.js を
                        #   動的import(import())する -> 選ばれなかった側のwasmは一切fetchされない
    mucom-app.js        # MUCOM88音源ドライバ固有ロジック(MMLエディタ・コンパイル等)
    pmd-app.js           # PMD音源ドライバ固有ロジック(プレイヤーのみ、エディタは次のタスク)
    mucom-adapter.js, mml-editor.js, mml-tokens.js, mucom-worklet.js, pmd-worklet.js, samplja.muc
    sample_fur_elise.M   # PMD側の同梱サンプル(エリーゼのために冒頭、NOTICE.md参照)
  mucomweb/CMakeLists.txt  # ../html を build-web/ へ同期してmucom88.js/.wasmをビルド
  pmdweb/CMakeLists.txt    # ../html を build-web/ へ同期してpmdweb.js/.wasmをビルド
  tools/build_dist.sh      # 両方のbuild-web/からwasmを集め、dist/ を1ディレクトリに組み立てる
                            # (GitHub Pagesはこのdist/を配信する想定)
```

- `mucomweb/build-web/` `pmdweb/build-web/` は**それぞれ自分の音源ドライバのwasmしか持たない**
  （個別開発・単体確認用。他方の `?driver=` に切り替えると404になるのは既知の制約）。
  **両ドライバを切り替え可能な状態で確認するには `tools/build_dist.sh` で組み立てた `dist/` を見ること**
- MUCOM88側は `sampl1.muc` 等の従来サンプルを同梱。PMD側は東方Projectアレンジ曲
  （権利未確認）を同梱から外し、代わりに自作サンプル `html/sample_fur_elise.M`
  （エリーゼのために冒頭、パブリックドメイン曲からのMML書き起こし）を同梱している
  （`NOTICE.md`、`tools/sample_fur_elise.mml`、`tools/verify_sample_fur_elise.mjs`参照）

### 検証手順（確立済み）

```bash
# リポジトリのルート(このREADME.mdがあるディレクトリ)を起点にする
# MUCOM88
cd mucomweb
source ../emsdk/emsdk_env.sh
emcmake cmake -S . -B build-web -DWEB_BROWSER=1 -DCMAKE_BUILD_TYPE=Release && cmake --build build-web -j4

# PMD
cd ../pmdweb
emcmake cmake -S . -B build-web -DCMAKE_BUILD_TYPE=Release && cmake --build build-web -j4

# 両ドライバを1ディレクトリへ組み立てる(?driver=切替の実地検証・GitHub Pages配信物確認用)
cd ..
tools/build_dist.sh
```

- プレビュー用サーバは `_emulator/PC98/.claude/launch.json` に登録済み
  （`mucomweb` = port 8777、`pmdweb` = port 8778、統合`dist/` = port 8779「fmsound-dist」）
- `mucomweb`のconfigure時、`upstream/MucomWeb/mucom88/src/cmucom.h`へ
  `mucomweb/patches/0001-cmucom-expose-vm.patch`（`CMucom::vm`を読むアクセサ1行）が
  冪等に自動適用される（`git apply --reverse --check`で未適用時のみ適用、
  適用失敗時はビルドを止める）。upstream作業ツリー自体は素のまま追跡不要
- MUCOM の MML は **Shift_JIS**。`new TextDecoder('shift_jis')` でデコードして textarea へ入れる
- `mucomweb`のエディタモードは既定でデバッグ表示（生PCHDATAテーブル・同期情報行）を隠す。
  URLに `?debug=1` を付けると表示される（例: `http://localhost:8779/?driver=mucom&debug=1`）
- PMDの動作確認用データは `upstream/pmdmini/PC-98_Hartmann_s_Youkai_GIrl.M`
  （ビルド成果物には同梱しない。upstream/直下から直接読む用途のみ、`tools/verify_right_pane_data.mjs`参照）
- **AudioContext はユーザー操作が要る。** JS から `compileMML()`/`playMusic()` を呼ぶだけでは
  音が出ない（リングは進むので「動いてるように見えて無音」になり紛らわしい）。実際にボタンをクリックすること
- **frame 刻みの測定は時間サンプリングでは不可。** サブブロックが1バーストで処理されるため
  2048 の塊に見える。リングの連続エントリを直接読むこと

### 検証環境の注意

ブラウザプレビュー環境の `ctx.outputLatency` は **168ms**（仮想オーディオデバイス）。
実機では 10〜30ms 程度になる。`difference` が 200ms 超でも異常ではなく、
**`difference - outputLatency - キュー深度` の残差で評価すること**。

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
