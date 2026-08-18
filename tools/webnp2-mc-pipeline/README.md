# webnp2-mc-pipeline

WebNP2(ブラウザ上のPC-98エミュレータ)+ FreeDOS(98) 上で PMD公式コンパイラ
`MC.EXE` を実際に動かし、自作MMLから**参照用の `.M`**(PMDのバイナリ演奏データ)を
生成するためのパイプライン一式。

`tools/pmd-reference/` に置く参照データ(自作コンパイラ `compiler/pmd_mml_compiler.mjs`
の出力を突き合わせるための「正解」)を再生成・追加するときに使う。

## 前提

- **`MC.EXE` はこのリポジトリに同梱していない。** PMD公式配布物であり、
  第三者著作物のため再配布しない。公式配布元
  (`http://www5.airnet.ne.jp/kajapon/tool.html`)から入手し、手元に置くこと。
- WebNP2本体(`_emulator/PC98/WebNP2`)が必要。`node <WebNP2>/mcp/server.mjs` を
  spawnしてMCPのJSON-RPCをstdioで話すだけなので、**`claude mcp add` によるユーザー設定への
  登録は不要**。
- Claude Code の `mcp__Claude_Browser__*` ツール(WebNP2をブラウザで開いて操作する)が使える環境。

## 全体の流れ

1. `mcp_http_bridge.mjs` を起動する。中身は「WebNP2の`mcp/server.mjs`をspawnし続け、
   標準入出力でMCP JSON-RPCを話しつつ、別途 `127.0.0.1:8765` にHTTP制御APIを立てて
   `POST /call {name, arguments}` でMCPツールを呼べるようにする」だけの薄いラッパー。
   1回起動しっぱなしにしておけば、以後は `curl` (`mcp_call.sh`)や `compile_*.py` から
   何度でも同期的にツールを呼べる。

   ```sh
   node mcp_http_bridge.mjs &
   curl -s http://127.0.0.1:8765/health   # "ok" が出ること
   ```

   デフォルトでは WebNP2 が `_emulator/PC98/WebNP2` (このFMSoundリポジトリの隣)に
   ある前提のパスを使う。違う場所にある場合は `WEBNP2_SERVER_PATH` で明示する:

   ```sh
   WEBNP2_SERVER_PATH=/path/to/WebNP2/mcp/server.mjs node mcp_http_bridge.mjs &
   ```

2. **ブラウザ側でブリッジのポートに繋がるようにする。** `mcp__Claude_Browser__*` が
   操作するブラウザは、Bashツールが動くホストとは別のネットワーク名前空間にいるため、
   `preview_start` が明示的に面倒を見ているポートしかブラウザ側から到達できない。
   `.claude/launch.json` に `mcp_http_bridge.mjs` を起動する一時エントリ
   (`runtimeExecutable: "node"`, `port: 3098`)を追加し、
   `preview_start({name: "..."})` で起動させると、ブリッジのWebSocketポート(3098)が
   ブラウザ側のサンドボックスにフォワードされる。
   (`url`+`port`のみの「既存プロセスにアタッチ」形式は自動判定で拒否される。
   `runtimeExecutable`/`runtimeArgs`を伴う「preview_startが実際にプロセスを起動する」
   形式でないと通らない。)

   また、`https://uraraworks.github.io/...` のような公開HTTPSページから
   `ws://127.0.0.1:3098` へ繋ぐことはブラウザのPrivate Network Access制限に
   引っかかる可能性があるため、**ローカルdevサーバー**
   (例: `http://localhost:5173/?bridge=1`)経由が確実。

3. ブラウザでWebNP2を開き、画面上の「FreeDOS(98) で起動」ボタンをクリックして
   `A:\>` プロンプトが出るまで待つ(bridgeはnp2の`booted`イベント後にしか
   接続されないため、起動操作は必須)。`MSDOS33.hdi` は不要。

4. コンパイルパイプラインを実行する。

   ```sh
   python3 compile_pipeline.py SAMPLE.MML --compare SAMPLE.M --out SAMPLE_out.M
   ```

   内部でやっていること: FD2に空FD(FAT12)を挿入 → `MC.EXE`と指定MMLを書き込み →
   `MC <basename>` を実行してコンパイル → 生成された`.M`を取り出してホストに保存 →
   参照用`.M`が指定されていればバイト比較。

## スクリプト一覧

- `mcp_http_bridge.mjs` — WebNP2 MCPサーバーをstdioで叩くための常駐HTTPブリッジ
- `mcp_call.sh` — 上記を`curl`で叩く薄いシェルヘルパー(`./mcp_call.sh '{"name":"screen_text","arguments":{}}'`)
- `compile_pipeline.py` — MML 1本 → `.M` の基本パイプライン(`MC <stem>`)
- `compile_pipeline_v.py` — 同上、`/V` オプション付き(`MC /V <stem>`)
- `compile_real.py` — 音色データ(`.FF`等)を伴う実データ検証用。`--extra`で追加ファイルを同じFDに置ける
- `compile_corpus.py` — 複数MMLを1枚のFDで連続コンパイルする一括版。`PMD_CORPUS_DIR`(必須、環境変数)で対象ディレクトリを指定
- `recompile_only.py` — `compile_corpus.py`でセットアップ済みのFD2に対し1曲だけ再コンパイルする軽量版。同じく`PMD_CORPUS_DIR`が必須
- `full_report.mjs` — 自作コンパイラ出力 vs 参照`.M`のパート単位一致状況レポート(`node full_report.mjs <mml> <refM> [ff]`)
- `loop_analyze.mjs` — 自作/参照それぞれの`.M`内のループ終端(0xf8)マーカーを列挙して比較(`node loop_analyze.mjs <mml> <refM> [ff]`)

## 落とし穴

- **`/V` オプション必須の場面がある。** `compile_pipeline.py`(素の`MC`)と
  `compile_pipeline_v.py`(`MC /V`)を使い分けること。
- **改行はCRLF必須。** `type_text`でMS-DOS側に送るコマンド文字列は`\r\n`で終端する。
  LFだけだとコマンドが確定しない。
- **Browserペインが非表示だと`requestAnimationFrame`が発火せず、エミュレータが
  1命令も進まない。** 別セッションの画面を前面にしただけでも起きる。`setTimeout`は
  動き続けるため「JSは動いているのにエミュだけ止まる」という紛らわしい壊れ方をする。
  ブラウザタブ(Browserペイン)を裏に回さないこと。
- **転送経路そのものは疑う前に確認すること。** 書き込んだファイルを`disk_read_file`で
  読み戻して原本と`cmp`一致するかを見れば、転送起因かコンパイル起因かを切り分けられる。
- **配布物同梱の参照`.M`が最新の`MC.EXE`の出力と一致するとは限らない。** 実際に
  `SAMPLE.M`(配布物同梱)と手元でコンパイルした結果が4byte(ヘッダのポインタ
  テーブルのエントリ数ぶん)食い違った実績がある。同梱物は古いバージョンの
  `MC.EXE`で生成された可能性があり、根本原因は未特定。参照データを追加する際は
  「配布物のバイナリ」と「今回コンパイルした結果」のどちらを正とするかを明示すること。

## 私物データの扱い

第三者の楽曲(MML本体・`.M`・`.FF`等)はこのリポジトリに一切含めない。
実データで検証したい場合は、`tools/verify_library.mjs`の`MCM_SAMPLE_ZIP`や
`tools/verify_pmd_compiler_oracle.mjs`の`PMD_REF_PAIRS`と同じ作法で、
環境変数経由でホスト側のパスを渡すこと(スクリプト側に決め打ちで埋め込まない)。
