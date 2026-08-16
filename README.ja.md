# FMSound

[English](README.md)

PC-9801 の **PMD**、PC-8801 の **MUCOM88** — 2つの FM 音源ドライバの MML を
ブラウザだけで演奏できるプレイヤー兼エディタです。ビルド済みの wasm と共通の
Web UI で動き、サーバーは不要です。

### ▶ <https://uraraworks.github.io/FMSound/>

インストール不要で、そのままブラウザで試せます。
（[PMD で開く](https://uraraworks.github.io/FMSound/?driver=pmd) /
[MUCOM88 で開く](https://uraraworks.github.io/FMSound/?driver=mucom)）

**このリポジトリの一番の特徴**は、ただ音を鳴らすだけでなく、
[FMDSP](https://github.com/myon98/98fmplayer) 風の画面で
**パートごとの演奏状態（音色・音程・ゲート・音量）をリアルタイムに描画する**ことです。
スペクトラムアナライザとレベルメーターも本物のドライバの出力から動きます。

## 使い方

1. ページを開くと、既定で同梱サンプル（「エリーゼのために」冒頭）が読み込まれた
   状態になっています。再生ボタンを押すだけで音が出ます。
2. ヘッダーの「音源ドライバ」プルダウンで PMD (PC-9801) / MUCOM88 (PC-8801) を
   切り替えられます（`?driver=pmd` / `?driver=mucom` のURLクエリでも指定可能）。
3. ツールバーのアイコンから「曲を開く」（手元の `.M`/`.m`/`.muc` ファイル、または
   ドラッグ&ドロップ）、「エディタモードへ切替」（MML を直接書いて鳴らす）、
   「ダウンロード」（MML ソース / コンパイル済みバイナリ / asm の db 配列、の3種）
   ができます。
4. `?mml=<URL>` を付けると、指定した URL の MML/曲ファイルを読み込んだ状態で
   開けます。ZIP/LZH で固めた書庫を指定すると中身を展開して曲を選べます
   （読み込むだけで自動再生はしません。ブラウザの制約で音声再生にはユーザー操作が
   必要なため、再生ボタンを押してください）。
5. キーボードショートカット: `⌘/Ctrl+Enter` でコンパイル&再生、`Esc` で停止。

## できないこと（重要）

現状のプレーヤーには、正直に書いておくべき制約がいくつかあります。

- **`#voice` / `#pcm` で指定される外部ファイルを読み込めません。**
  そのため音色が既定のものに、ADPCM が無音になります。読み込んだ MML がこれらを
  参照している場合は、画面上にその旨を表示します（音色とドラムが本来と異なる、
  という注意）。
- **リズムパートは、本物の YM2608 とは異なる代替サンプルで鳴ります。**
  同梱している音源コアは実チップの ROM 由来 PCM を持たないため、フリー素材の
  代替ドラムサンプル（`html/rhythm/2608_*.WAV`、出典は `NOTICE.md` 参照）を
  読み込んで再生しています。作者本人が「本物の YM2608 のリズム音とは根本的に
  波形が異なる」と明言している代替品である点をご了承ください。リズムパートを
  使っている曲を読み込んだ場合、画面上にその旨を表示します。
- **PPZ8・LFO・ポルタメント等、PMD コンパイラ（自作の MML→バイナリ変換）が
  対応する範囲は v1 の基本コマンドまでです。** 詳細は `docs/pmd-compiler-spec.md`
  参照。
- **スマホ・タブレットには未対応です。**

## ⚠ ドライバごとの MML の違い（`t`/`T`/`C` が入れ替わっています）

PMD と MUCOM88 で、**`t` と `T` の意味が逆**です。開発中に2回とも踏んだ罠なので、
必ず確認してください。

| | `t`（小文字） | `T`（大文字） |
|---|---|---|
| **PMD** | テンポ（**2分音符**基準の絶対値。一般的な BPM の**半分**の値） | TimerB の生値 |
| **MUCOM88** | TimerB の生値 | テンポ（BPM 相当） |

さらに **MUCOM88 の `C` はテンポではありません。** 全音符あたりのクロック数（分解能）
の指定で、既定値は 128 です。テンポを変えたいときは `T` を使ってください。

## 今後の予定

- `#voice`/`#pcm` の読み込み対応
- スマホ対応（再生側・編集側の両方）
- アプリ間でのデータ受け渡し（曲データの共有等）

## ライセンスと出典

**FMSound は [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/deed.ja)
（表示 - 非営利 - 継承 4.0 国際）で提供します。** 全文は [`LICENSE`](./LICENSE) を参照してください。

これは自ら選んだ条件ではなく、**同梱している MUCOM88 が CC BY-NC-SA 4.0 で
継承（ShareAlike）が付く**ため、それを取り込んだ FMSound 全体が同じ条件に
揃うことによります。PMD 側の実装の由来（98fmplayer）は BSD 2-Clause なので、
**PMD 部分だけを自由な条件で使いたい場合は、FMSound ではなく 98fmplayer や
本家 PMD を直接参照してください。**

音源ドライバの実装は、以下の上流プロジェクトを wasm へ移植・利用しています。
第三者の著作物に由来する生成物の出所・ライセンス全文は
**[`NOTICE.md`](./NOTICE.md)** にまとめています。

- **PMD**: [98fmplayer](https://github.com/myon98/98fmplayer)（BSD 2-Clause）
- **MUCOM88**: [OPEN MUCOM88](https://github.com/onitama/mucom88) /
  [MUCOM88 on Web](https://github.com/aosoft/MucomWeb)
  （[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/deed.ja) —
  **非商用・継承**が付きます）

同梱サンプル曲（「エリーゼのために」冒頭、ベートーヴェン作曲・パブリックドメイン）の
MML アレンジは本プロジェクトの著作物です。詳細は `NOTICE.md` を参照してください。

ROM イメージ（PC-98 本体 BIOS 等）や市販ソフトウェアのデータは、
本リポジトリに一切含まれていません。

## ビルド手順

このリポジトリは `upstream/`（参照する外部リポジトリ群、79MB）を **追跡していません**
（`.gitignore` 参照）。そのため、クローンしただけではビルドできません。
以下の手順で取得してください。

取得先とリビジョンは [`upstream-revisions.env`](./upstream-revisions.env)
に一元化してあります（GitHub Actions のビルドもここを参照します。固定する
理由もファイル内のコメント参照）。

```bash
set -a; source upstream-revisions.env; set +a

mkdir -p upstream
git clone "$UPSTREAM_98FMPLAYER_REPO" upstream/98fmplayer
git -C upstream/98fmplayer checkout --detach "$UPSTREAM_98FMPLAYER_REV"

git clone "$UPSTREAM_MUCOMWEB_REPO" upstream/MucomWeb
git -C upstream/MucomWeb checkout --detach "$UPSTREAM_MUCOMWEB_REV"
git -C upstream/MucomWeb submodule update --init --recursive
```

ツールチェーンは `PC98/emsdk`（emscripten SDK）を `emsdk` というシンボリックリンク
経由で共有しています。リンク先が無い場合は emscripten SDK を別途取得し、
`emsdk` を有効なパスへ張り直してください。

```bash
# リポジトリのルート(このREADME.mdがあるディレクトリ)を起点にする

# MUCOM88
cd mucomweb
source ../emsdk/emsdk_env.sh
emcmake cmake -S . -B build-web -DWEB_BROWSER=1 -DCMAKE_BUILD_TYPE=Release && cmake --build build-web -j4

# PMD
cd ../pmdweb
emcmake cmake -S . -B build-web -DCMAKE_BUILD_TYPE=Release && cmake --build build-web -j4

# 両ドライバを1ディレクトリへ組み立てる(?driver=切替の実地確認・配信物確認用)
cd ..
tools/build_dist.sh
```

`dist/` が組み立て後の配信用ディレクトリです（GitHub Pages はここを配信する想定）。
ローカルで確認するには、`dist/` を静的サーバーで配信してブラウザで開いてください
（例: `python3 -m http.server 8000 --directory dist`）。

`mucomweb`のconfigure時、`upstream/MucomWeb/mucom88` へ`mucomweb/patches/`配下の
パッチ（アクセサ公開・レベルメーター・リズムパートの`rhythmpath`指定の3本）が
自動適用されます。upstream の作業ツリー自体は変更しないので、追跡やコミットは
不要です。

### GitHub Pages への公開（CI）

`master` への push で [`.github/workflows/pages.yml`](./.github/workflows/pages.yml)
が上記と同じ手順（upstream 取得 → emsdk 導入 → 両ドライバビルド →
`net/config.js` 生成 → `tools/build_dist.sh`）を実行し、`dist/` を
GitHub Pages へデプロイします。中継サーバー URL はリポジトリ変数
`DISK_PROXY_URL`（Settings → Secrets and variables → Actions → Variables）
から注入されます。未設定でもビルド・公開自体は失敗しません（中継しない
だけの動作になります。fork した人が変数を設定しなくても公開できるように
するための既定挙動）。

### 開発ノート

upstream の解析結果、設計判断の経緯、実測で判明した各ドライバの性質などは
[`docs/development-notes.md`](./docs/development-notes.md) にまとめてあります
（このプロジェクトを改造・移植する場合の参考資料です）。
