# net/ 取得層の検証記録(故障注入・実ネットワーク確認)

`net/` (URL指定の曲データ取得層。PC98/WebNP2 の `src/api/{disk-fetch,archive,zip,lzh,archive-util}.ts`
の移植)の検証で行った、故障注入(陽性対照)と実ネットワーク確認の記録。

## 1. 故障注入(陽性対照)

「常にPASSする検査は無意味」という方針(過去に「20/20全滅」で発覚した実績あり、
`docs/right-pane-data.md` 等参照)に従い、以下2箇所で実施した。

### 1a. `looksLikeHtml()` (`tools/verify_net_looks_like_html.mjs`)

- 判定関数を常に `false` を返す壊れた版(`brokenLooksLikeHtml`)に差し替え、
  実際のHTMLバイト列を渡した場合に判定が失敗する(本来 `true` になるべきが `false` のまま)
  ことを確認した → **FAIL(検出成功)**。
- その後、本物の `looksLikeHtml()` に戻して全項目(HTML=true / .muc(CP932)=false /
  LZHバイナリ=false / ZIPマジック=false / Content-Type判定=true)が **PASS** することを再確認した。
- 実行結果: `node tools/verify_net_looks_like_html.mjs` → 全項目PASS(2026-08-14実施)。

### 1b. LZH展開のCRC16検証 (`tools/verify_net_archive.mjs`)

- 自作LZHエンコーダ(`tools/lzh-encoder.mjs`)で組み立てた正常な `.lzh` バイト列のうち、
  `voice.dat` エントリのデータ部の1バイトを反転(XOR 0xFF)して壊し、`extractArchive()` に
  渡した → `LZH: CRC16が一致しません` の例外が飛ぶことを確認した(**検出成功**)。
- 壊していない元のバイト列に戻して、ZIP(store/deflate)・LZHいずれも全エントリが
  バイト一致でPASSすることを再確認した。
- 実行結果: `node tools/verify_net_archive.mjs` → 全項目PASS(2026-08-14実施)。

## 2. 実ネットワーク確認(正直な切り分け)

- **GitHub raw / jsDelivr は実際に fetch して確認した**(取得できることが既知のため)。
  対象: `https://raw.githubusercontent.com/uraraworks/WebNP2/master/package.json` /
  `https://cdn.jsdelivr.net/gh/uraraworks/WebNP2@master/package.json`。
  いずれも `fetchSongBytes()` 経由で取得でき、`looksLikeHtml()` が `false` を返すことを確認した。
- **Google Drive / Dropbox / OneDrive は実物の共有リンクでの検証を実施していない。**
  自前のHTTPサーバ相手だと全部通ってしまい本番で破綻した実績がある(WebNP2側の教訓)ため、
  「取れたふり」を避けるべく今回は以下のみに留めた:
  - OneDriveホストのURLを渡すと、直接fetchを試さず即座に専用エラーメッセージで例外になる
    (分岐ロジックが書かれているとおりに動くことの確認)。
  - 存在しないGoogle DriveファイルIDへの到達確認(HTML誤取得検出ロジックが動くことの確認)。
    これは「実物の共有ファイルが正しく取得できる」ことの証明にはならない。
  - **したがって、Google Drive / Dropbox / OneDrive の実リンクでの取得確認は未実施のまま。**
    次にこれらのホストを使う場合は、実物の共有リンクを1本用意したうえで再検証すること。

### 2026-08-18 追記: Dropboxは実リンクでの検証が完了した

`net/fetch.js` に `rewriteDropboxUrl()` を追加し、取得直前に `www.dropbox.com` /
`dropbox.com` を `dl.dropboxusercontent.com` へ置換する対応を入れた。これに伴い、
上記「Dropboxは実物の共有リンクでの検証を実施していない」は**解消された**。

- 実物の `/scl/fi/...` 形式のファイル共有リンク1本で、**ブラウザで**以下を確認した:
  - `www.dropbox.com` のまま: `dl=0` / `dl=1` いずれも `TypeError: Failed to fetch`
    (ACAOが無くCORSで落ちる)。
  - `dl.dropboxusercontent.com` へ置換: `200` / `content-type: application/zip` /
    1,631,914バイト / CORS通過。`dl=1` は不要(付けても同じ)。
  - アプリ自身の `fetchSongBytes()` を、中継(`NET_PROXY_BASE`)を空にした状態で通し、
    `dl=0` のままの `www.dropbox.com` 共有リンクから 1,631,914バイトのzipを
    端から端まで取得できることを確認した。
- **この判定はブラウザでしか測れない。** curl や Node の `fetch()` はCORSを強制しない
  実装のため、`www.dropbox.com` のままでも成功してしまい、上の失敗を再現できない
  (このドキュメントの趣旨である「観測系そのものが壊れていないか」を疑うべき典型例で、
  curl/Nodeで検証したつもりになると「取れたふり」になる)。
- 検証したのは `/scl/fi/...` 形式のファイル共有リンク1本のみ。**旧 `/s/...` 形式・
  フォルダ単位の共有・パスワード付きリンクは未検証**であり、検証済みだと書かない。
  これらは置換で救えない可能性があるが、直接取得が失敗した場合は従来どおり
  中継(`NET_PROXY_BASE`)へフォールバックする(中継へ渡すのは利用者が入力した
  元のURL)ため、中継が設定されていれば従来どおり取得できる想定。
- **Google Drive / OneDrive は依然として実リンクでの取得確認は未実施のまま**
  (上記の記述のとおり、変更なし)。

## 3. その他の既知の限界

- ZIPの日本語ファイル名判定は general purpose flag の bit11(UTF-8フラグ)を見て
  UTF-8/SJISを切り替える設計(WebNP2から無改変で移植)。**macOSに標準で入っている
  Info-ZIP(Apple版)の `zip` コマンドは、日本語ファイル名をUTF-8バイト列のまま
  格納するがbit11を立てない**ことを本タスクの検証中に実機で確認した(`zip -v` は
  `Zip 3.0, with modifications by Apple Inc.`)。この組み合わせのZIPをそのまま
  `net/zip.js` に渡すと「フラグ無し→SJISとして解釈」され文字化けする。
  これは移植元のWebNP2 zip.ts側から引き継いだ仕様であり、本タスクでは修正していない
  (取得層の移植が目的のため)。`tools/verify_net_archive.mjs` では、UTF-8フラグを
  意図的に立てたZIP(多くの他ツールが実際に出力する形)で検証している。
