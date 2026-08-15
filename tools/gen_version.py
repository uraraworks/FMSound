#!/usr/bin/env python3
"""FMSound自身のバージョン表示用JSファイルを生成する。

出力: ui/version.js (このファイルは.gitignore対象。mucomweb/CMakeLists.txtの
      generate_version ターゲットからビルドのたびに実行される)

方針(2026-08-14 コーディネータ指示による仕様変更):
- 手動インクリメントはしない。
- ビルド時刻(壁時計)は使わない。ビルドのたびに成果物の文字列が変わってしまうと、
  「配布物が本当にコミットXのものか」を後から確認できなくなる
  (docs/fmdsp-layout.mdおよびfeedback_stale_artifact_from_verification_step相当の
  事故を作り込まないため)。
- 情報源はgitの「コミット日時(コミッターdate)」と「コミットハッシュ」のみ。
  同じコミットから何度ビルドしても必ず同じ文字列になることが要件。
- 取得に失敗した場合(gitが無い/リポジトリでない等)は、黙って空欄や'00'等の
  もっともらしい値で埋めない。'??'/'unknown'とはっきりわかる形にする。

生成する2つの表現:
  FMSOUND_VERSION_FIELDS: rightpane.js の drawTitle() へそのまま渡す3要素配列。
    ["YY","MM","DD"] の日付のみ(コミットハッシュは幅の制約でFMDSP側の3枠には
    入らない。docs/fmdsp-layout.md「VER_0/1/2_Xの逸脱」参照)。
  FMSOUND_VERSION_FOOTER: ページフッター用の完全な識別子。
    "YYYY-MM-DD HH:MM JST (ハッシュ7桁)"。同日に複数回コミットした場合に
    区別するための一意な識別子として使う(不具合報告用)。国内利用者が多いため
    日本時間(JST=UTC+9固定)で表示する(2026-08-14 変更。以前はUTC表示だった)。
  FMSOUND_VERSION_OK: 取得に成功したかどうかのbool。
  FMSOUND_BUILD_ID: コミットハッシュ短縮7桁のみ(2026-08-15追加)。
    tools/apply_cache_bust.pyが静的import分のURLへ ?v=<hash> を付与するのに対し、
    app.js内の動的import(driver選択でmucom-app.js/pmd-app.jsを切り替える箇所)は
    パスが実行時に組み立てられ静的なテキスト置換では書き換えられないため、
    この値をコードから直接importして使う(同じ「コミットハッシュ」という情報源
    なので二重管理ではない)。
"""
import json
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DST = REPO_ROOT / "ui" / "version.js"

# 日本時間(UTC+9)をtimezone.utc/localtime()に頼らず固定オフセットで表す。
# datetime.now()やastimezone()なしのlocaltime相当は使わない: ビルドした
# マシンのTZ設定次第で結果が変わってしまい、「同じコミットからは必ず同じ版が
# 出る」性質(tools/verify_version_determinism.mjs)が壊れるため。日本には
# 夏時間が無いのでUTC+9固定で年間を通じて正しい。
JST = timezone(timedelta(hours=9))


def run_git(args):
    return subprocess.run(
        ["git", *args],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()


def main():
    ok = True
    error = None
    try:
        # --date=format はgitのバージョン/ロケールに挙動差があるため使わない。
        # unix秒(%ct、コミッターdate)を取ってPython側でUTC固定変換する方が
        # 環境非依存で確実。
        commit_ts_str = run_git(["log", "-1", "--format=%ct"])
        commit_hash = run_git(["rev-parse", "--short=7", "HEAD"])
        if not commit_ts_str or not commit_hash:
            raise RuntimeError("git出力が空でした")
        commit_ts = int(commit_ts_str)
        # fromtimestamp(ts, tz=JST) はUTC単位時刻(ts)からJST固定オフセットへの
        # 変換であり、ホストのローカルタイムゾーン設定は一切参照しない
        # (localtime()を使わない、上のJST定義のコメント参照)。
        dt = datetime.fromtimestamp(commit_ts, tz=JST)
        fields = [dt.strftime("%y"), dt.strftime("%m"), dt.strftime("%d")]
        footer = f"{dt.strftime('%Y-%m-%d %H:%M')} JST ({commit_hash})"
        build_id = commit_hash
    except Exception as e:  # noqa: BLE001 - ビルドを止めず'unknown'で明示する方針
        ok = False
        error = str(e)
        fields = ["??", "??", "??"]
        footer = "unknown"
        build_id = "unknown"

    js_lines = [
        "// 自動生成: tools/gen_version.py。手編集しないこと。",
        "// git のコミット日時(JST=UTC+9固定, コミッターdate)とコミットハッシュから生成する。",
        "// ビルド時刻(壁時計)は使わない: 同じコミットから何度ビルドしても",
        "// 同じ文字列になることを保証するため(tools/verify_version_determinism.mjs参照)。",
        f"export const FMSOUND_VERSION_FIELDS = {json.dumps(fields)};",
        f"export const FMSOUND_VERSION_FOOTER = {json.dumps(footer)};",
        f"export const FMSOUND_VERSION_OK = {json.dumps(ok)};",
        f"export const FMSOUND_BUILD_ID = {json.dumps(build_id)};",
        "",
    ]
    DST.parent.mkdir(parents=True, exist_ok=True)
    DST.write_text("\n".join(js_lines), encoding="utf-8")

    if ok:
        print(f"[gen_version.py] wrote {DST} fields={fields} footer={footer!r}")
    else:
        print(
            f"[gen_version.py] git情報の取得に失敗したため'unknown'で出力しました: {error}",
            file=sys.stderr,
        )


if __name__ == "__main__":
    main()
