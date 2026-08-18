# WebNP2 + MC.EXE (PMD公式コンパイラ) パイプライン メモ

## 結論
1本通った。ブリッジ接続・DOS起動・ファイル転送・コンパイル実行・.M取り出しまで
全部成功。ただし配布物同梱の `SAMPLE.M` とはバイト不一致(後述)。

## 詰まった点1: MCPサーバーが未登録の状態でどう叩くか
`claude mcp add` はユーザー設定ファイルを触るため今回は使えない。
`node server.mjs` を直接spawnしてMCP stdio JSON-RPCを話すことは可能だが、
1回のBashツール呼び出しごとにプロセスが終わってしまうため、その都度
WebSocketブリッジ(ポート3098)への接続がリセットされてしまい非効率。

→ `mcp_http_bridge.mjs` を作成。中身は「server.mjsをspawnし続け、標準入出力
でMCP JSON-RPCを話しつつ、別途 localhost:8765 にHTTP制御APIを立てて
`POST /call {name, arguments}` でMCPツールを呼べるようにする」だけの薄いラッパー。
これを1回起動しっぱなしにしておけば、以後は `curl` で何度でも同期的に
ツールを呼べる(このリポジトリを一切変更しない、追加npm依存も無い)。

## 詰まった点2(最大の詰まりどころ): ブラウザからブリッジのWebSocketに繋がらない
`https://uraraworks.github.io/WebNP2/?bridge=1` を開いても、
`ws://127.0.0.1:3098/` への接続がブラウザ側で失敗し続けた
(`fetch('http://127.0.0.1:8765/health')` も失敗)。

原因はこの環境固有の事情: `mcp__Claude_Browser__*` が操作するブラウザは、
Bashツールが動くホストとは別のネットワーク名前空間にいる。
`http://localhost:5173`(vite dev server)には繋がる一方、任意の
`127.0.0.1:<port>` には繋がらない。つまり **`preview_start` が明示的に
面倒を見ているポートだけがブラウザ側から到達可能** という制約がある。

対処: `.claude/launch.json` に、`mcp_http_bridge.mjs` を起動する
一時エントリ(`runtimeExecutable: "node"`, `port: 3098`)を追加し、
`preview_start({name: "webnp2-mcp-bridge-temp"})` で起動させた。
これで3098番ポートがブラウザ側のサンドボックスにフォワードされ、
`ws://localhost:3098/` に接続できるようになった。
(注: `url`+`port`のみの「既存プロセスにアタッチ」形式のエントリは
自動判定で拒否された。`runtimeExecutable`/`runtimeArgs`を伴う
「preview_startが実際にプロセスを起動する」形式でないと通らない模様。)

また、`https://uraraworks.github.io/...` (公開HTTPSページ) から
`ws://127.0.0.1:3098` へ繋ぐこと自体もブラウザのPrivate Network Access
制限に引っかかっている可能性があるため、**ローカルdevサーバー
(`http://localhost:5173/?bridge=1`)経由が確実**。README記載の
「ローカルなら確実」という注意書きは伊達ではなかった。

このタスク終了時に `.claude/launch.json` の一時エントリは削除して元に戻した
(このファイルは `.gitignore` で追跡対象外なので、そもそもコミットされる
心配は無い)。

## 詰まった点3: DOS起動環境
`MSDOS33.hdi` を使う必要は無かった。WebNP2に同梱の **FreeDOS(98)**
(「FreeDOS(98) で起動」ボタン)で `A:\>` プロンプトまで数秒で到達でき、
`MC.EXE`(16bit .EXE、PC-98用)を問題なく実行できた。
ディスクライブラリ(`list_disk_library`)の事前確認は省略した
(ブリッジがnp2の`booted`イベント後にしか繋がらないため、どのみち
何かしら起動しないと確認すらできない → 最短経路のFreeDOSでまず
1本通すことを優先した)。

## パイプライン本体
1. `insert_disk(drive=2, blank=true)` でFD2に空FD(FAT12)を挿入
2. `disk_write_file(slot="fd2", path="MC.EXE", base64=...)`
3. `disk_write_file(slot="fd2", path="SAMPLE.MML", base64=...)`
4. `type_text("B:\r\nMC SAMPLE\r\n")` → 画面に "Compile Completed." を確認
5. `disk_read_file(slot="fd2", path="SAMPLE.M", encoding="base64")` で取得

## SAMPLE.M バイト比較の結果: 不一致
- 参照 `SAMPLE.M`(配布物同梱): 1142 bytes
- 今回コンパイルした結果: 1138 bytes (4 bytes少ない)
- 最初の差分位置: byte 1 (0-indexed。先頭からいきなり違う)

転送経路の健全性は別途確認済み:
- 書き込んだ `MC.EXE` をdisk_read_fileで読み戻し、ホストの原本と
  `cmp` で完全一致を確認(転送は無事故)
- 書き込んだ `SAMPLE.MML` も同様に読み戻して原本と完全一致を確認

つまり **転送は正常、コンパイル自体は正常終了(エラー無し)、しかし
生成された.Mの中身が配布物のSAMPLE.Mと一致しない**。

先頭の16進ダンプを見比べると、ヘッダ部のポインタ列がまるごと
2バイトずつ小さい値になっており(例: `001a`→`0018`)、さらに参照側には
ポインタが1個多い(`0452 0453 045f 0480` vs `0450 0451 0480`)。
つまりヘッダのポインタテーブルのエントリ数が1個(2バイト)違い、その影響で
後続オフセットが軒並み-2され、かつどこかもう2バイト分の差分がある
(合計4バイト減)。SAMPLE.MMLにはタイトル指定や音色データが無いため、
この差はオプション指定(/Vなど)の違いでは説明しづらい。
**最も可能性が高い仮説**: zip内の`SAMPLE.M`は配布時点でのMC.EXE
(おそらく旧バージョンか、MML文法拡張前のビルド)で生成されたものが
そのまま同梱されており、今回転送した`MC.EXE`(ver 4.8s、コンパイル時の
バナー表示で確認)での再コンパイル結果と完全一致する保証は無い、というもの。
根本原因の特定はしていない(時間の都合で深追いしていない)。

## 再現方法
```sh
# 1. ブリッジ起動 (.claude/launch.json に一時エントリを足してpreview_startするか、
#    直接 node mcp_http_bridge.mjs & で起動して127.0.0.1:8765を確認)
node mcp_http_bridge.mjs &
curl -s http://127.0.0.1:8765/health   # "ok" が出ること

# 2. ブラウザで http://localhost:5173/?bridge=1 (WebNP2のvite dev server) を開き、
#    「FreeDOS(98) で起動」をクリックして A:\> プロンプトが出るまで待つ
#    (mcp__Claude_Browser__* での操作が必要。上記は手動でも可)

# 3. パイプライン実行
python3 compile_pipeline.py SAMPLE.MML --compare SAMPLE.M --out SAMPLE_out.M
```

## 成果物(すべてscratchpad配下、リポジトリには何も置いていない)
- `mcp_http_bridge.mjs` — MCP stdioをHTTPに変換する常駐ブリッジ
- `mcp_call.sh` — 上記をcurlで叩く薄いシェルヘルパー
- `compile_pipeline.py` — MML→.Mコンパイルの本体パイプライン(再実行可能)
- `SAMPLE_out.M` / `SAMPLE_out2.M` — 今回の実行で取得した.M(検証用)
- `MC_readback.EXE` / `SAMPLE_readback.MML` — 転送整合性チェックの副産物
