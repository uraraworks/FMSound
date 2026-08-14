#!/usr/bin/env python3
"""FMSound の中継サーバー設定(net/config.js)を生成する。

出力: net/config.js (このファイルは.gitignore対象。tools/gen_version.pyと同じ作法:
      ビルドのたびに生成し、コミットしない)

方針(2026-08-15 net/配線タスク):
- 中継サーバーのベースURLは環境変数 DISK_PROXY_URL から注入する。
  (WebNP2の VITE_DISK_PROXY / vars.DISK_PROXY_URL と同じ名前の使い方に倣う。
  FMSoundはViteを持たない静的アプリのため、import.meta.envではなくビルド前に
  このスクリプトでJSファイルを生成する方式にする。)
- 環境変数が未設定・空文字の場合は空文字列を書き出す(=中継しない、直接fetchのみ)。
  forkしたリポジトリや手元ビルドでこのスクリプトを一度も実行しなくても
  net/fetch.jsがconfig.jsをimportできるよう、ビルドの最初のステップとして
  必ずこのスクリプトを走らせる(tools/build_dist.sh参照)。値が無くてもビルドは通る。
- gen_version.pyと違い、こちらは環境変数をそのまま使うだけなので「取得失敗」に
  相当する状態は無い(未設定は正常系の一つ)。
"""
import json
import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DST = REPO_ROOT / "net" / "config.js"


def main():
    proxy_base = os.environ.get("DISK_PROXY_URL", "").strip()

    js_lines = [
        "// 自動生成: tools/gen_net_config.py。手編集しないこと。",
        "// 環境変数 DISK_PROXY_URL から生成する(未設定時は空文字列=中継しない)。",
        "// GitHub Actionsではリポジトリ変数 DISK_PROXY_URL をこの名前でビルド環境に渡す",
        "// (tools/build_dist.sh がビルドの最初にこのスクリプトを実行する)。",
        f"export const NET_PROXY_BASE = {json.dumps(proxy_base)};",
        "",
    ]
    DST.parent.mkdir(parents=True, exist_ok=True)
    DST.write_text("\n".join(js_lines), encoding="utf-8")

    if proxy_base:
        print(f"[gen_net_config.py] wrote {DST} NET_PROXY_BASE={proxy_base!r}")
    else:
        print(f"[gen_net_config.py] DISK_PROXY_URL 未設定のため {DST} は空文字列(中継しない)で生成しました")


if __name__ == "__main__":
    main()
