#!/usr/bin/env python3
"""dist/ 配下の自前コードが参照するローカルリソースURLへビルドID(?v=<hash>)を
付与し、更新のたびにURLそのものを変えることでブラウザ/CDNキャッシュを迂回する。

背景(2026-08-15、iPhone利用者からの「line 22 が...で始まる必要があります」報告):
- GitHub Pages はレスポンスヘッダ(cache-control等)を我々が設定できない
  (実測: HTML/JS/wasmいずれも Fastly が cache-control: max-age=600 を付与)。
  ヘッダ側で制御できない以上、「更新のたびにURLを変える」しか確実な手段が無い。
- Service Worker は導入しない(更新事故の元になりうるため、今回は見送り)。

対象: 静的import宣言(`from '...'`)の相対パス、および index.html の
      <script src>/<link href>。いずれも「./」「../」で始まり.js/.mjs/.cssで
      終わるものだけを対象にする(絶対URLやog:image等は触らない)。

対象外(意図的): mucomweb/pmdweb がビルドするemscripten生成グルー
(mucom88.js/pmdweb.js)とその.wasm。内部でimport.meta.url等からロード元
ディレクトリを自前計算しており、クエリ文字列付与で壊すリスクがあるため
(=このファイル自体は書き換えない)。これらは upstream のピン留めリビジョンが
変わった時だけ内容が変わる低頻度の更新であり、GitHub PagesのTTL(実測10分)の
範囲で許容する。

ビルドIDの出所: tools/gen_version.py と同じ「コミットハッシュ(短縮7桁)」。
同じコミットからは常に同じ値になる(determinism要件はtools/gen_version.pyの
コメント参照)。ここでは値を使い回すのではなく同じgitコマンドで独立に
再計算しているだけで、情報源は同一。
"""
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# emscripten生成グルー。クエリ文字列を付けると内部のlocateFile計算を壊しかねない
# ため対象外にする(コメント参照)。
EXCLUDE_JS_NAMES = {"mucom88.js", "pmdweb.js"}

IMPORT_RE = re.compile(
    r"""(from\s*)(['"])(\.\.?/[^'"]+\.(?:mjs|js))(\?[^'"]*)?\2"""
)
HTML_RE = re.compile(
    r"""(src|href)=(["'])(\./[^"']+\.(?:js|mjs|css))(\?[^"']*)?\2"""
)


def get_build_id():
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--short=7", "HEAD"],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        if not out:
            raise RuntimeError("git rev-parse が空でした")
        return out
    except Exception as e:  # noqa: BLE001
        print(f"[apply_cache_bust.py] コミットハッシュの取得に失敗: {e}", file=sys.stderr)
        return None


def bust_js(text, build_id):
    def repl(m):
        prefix, quote, path, existing_q = m.group(1), m.group(2), m.group(3), m.group(4)
        return f"{prefix}{quote}{path}?v={build_id}{quote}"

    return IMPORT_RE.sub(repl, text)


def bust_html(text, build_id):
    def repl(m):
        attr, quote, path, existing_q = m.group(1), m.group(2), m.group(3), m.group(4)
        return f'{attr}={quote}{path}?v={build_id}{quote}'

    return HTML_RE.sub(repl, text)


def main():
    if len(sys.argv) != 2:
        print("usage: apply_cache_bust.py <dist-dir>", file=sys.stderr)
        sys.exit(1)
    dist = Path(sys.argv[1]).resolve()
    if not dist.is_dir():
        print(f"error: {dist} が無い", file=sys.stderr)
        sys.exit(1)

    build_id = get_build_id()
    if build_id is None:
        print(
            "[apply_cache_bust.py] ビルドIDを取得できないためキャッシュ無効化を"
            "スキップした(gitが無い等の環境向けフォールバック。配布物自体は動く)。",
            file=sys.stderr,
        )
        return

    js_count = 0
    for path in dist.rglob("*"):
        if not path.is_file():
            continue
        if path.suffix in (".js", ".mjs") and path.name not in EXCLUDE_JS_NAMES:
            text = path.read_text(encoding="utf-8")
            new_text = bust_js(text, build_id)
            if new_text != text:
                path.write_text(new_text, encoding="utf-8")
                js_count += 1

    html_count = 0
    for path in dist.rglob("*.html"):
        text = path.read_text(encoding="utf-8")
        new_text = bust_html(text, build_id)
        if new_text != text:
            path.write_text(new_text, encoding="utf-8")
            html_count += 1

    print(
        f"[apply_cache_bust.py] build_id={build_id} JS/MJS書き換え={js_count}件 "
        f"HTML書き換え={html_count}件"
    )


if __name__ == "__main__":
    main()
