#!/usr/bin/env python3
"""
PMD公式コンパイラ MC.EXE をWebNP2(PC-98エミュレータ)上で動かし、
MML -> .M のコンパイルを行うパイプライン。

前提(この順で先に済ませておくこと。ブラウザ操作はこのスクリプトの範囲外):
  1. mcp_http_bridge.mjs を(直接 or .claude/launch.json 経由の preview_start で)起動し、
     http://127.0.0.1:8765/health が "ok" を返す状態にする。
  2. mcp__Claude_Browser__preview_start / navigate で WebNP2 を
     http://localhost:5173/?bridge=1 (ローカルdevサーバ) で開く。
     ※ 公開ページ(https://uraraworks.github.io/WebNP2/?bridge=1)だとブラウザの
       Private Network Access制限で ws://127.0.0.1:3098 に繋がらない実績あり。
       ローカルdevサーバ + .claude/launch.json に3098番ポートのエントリを追加して
       preview_start でポートフォワーディングさせること(詳細はメモ参照)。
  3. 画面上の「FreeDOS(98) で起動」ボタンをクリックし、A:\\> プロンプトが出るまで待つ。
     (bridgeはnp2の'booted'イベント後にしか接続されないため、起動操作は必須)

このスクリプト自体は、既にbridgeが繋がって(2)(3)まで済んだ状態から:
  - FD2に空FD(FAT12)を挿入
  - MC.EXE と 指定MMLファイルを書き込み
  - "MC <basename>" を実行してコンパイル
  - 生成された .M を取り出してホストに保存
  - 参照用 .M が指定されていればバイト比較

使い方:
  python3 compile_pipeline.py SAMPLE.MML --compare SAMPLE.M --out SAMPLE_out.M
"""
import argparse
import base64
import json
import os
import sys
import time
import urllib.request

BRIDGE_HTTP_PORT = int(os.environ.get("BRIDGE_HTTP_PORT", "8765"))
BASE_URL = f"http://127.0.0.1:{BRIDGE_HTTP_PORT}"
MC_EXE_PATH = os.environ.get("MC_EXE_PATH", os.path.join(os.path.dirname(__file__), "MC.EXE"))


def call(name, arguments=None):
    req = json.dumps({"name": name, "arguments": arguments or {}}).encode()
    r = urllib.request.Request(f"{BASE_URL}/call", data=req, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(r, timeout=30) as resp:
        body = json.loads(resp.read())
    result = body.get("result", {})
    if result.get("isError"):
        text = result.get("content", [{}])[0].get("text", "")
        raise RuntimeError(f"MCP tool '{name}' failed: {text}")
    return result


def call_text(name, arguments=None):
    result = call(name, arguments)
    content = result.get("content", [])
    return content[0]["text"] if content else ""


def health_check():
    with urllib.request.urlopen(f"{BASE_URL}/health", timeout=5) as resp:
        body = resp.read().decode()
    if body != "ok":
        raise RuntimeError(f"bridge not ready: {body}")


def decode_disk_read(text):
    # disk_read_file(base64) のレスポンスは "size=N bytes\n<base64>" 形式。
    lines = text.split("\n", 1)
    b64 = lines[1] if len(lines) > 1 else lines[0]
    return base64.b64decode(b64)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mml", help="コンパイルするMMLファイル(ホスト側パス)")
    ap.add_argument("--mc-exe", default=MC_EXE_PATH, help="MC.EXEのホスト側パス")
    ap.add_argument("--compare", help="バイト比較する参照用.Mファイル(ホスト側パス)")
    ap.add_argument("--out", help="取得した.Mの保存先(省略時は<mml拠点>_out.M)")
    ap.add_argument("--drive", default="fd2", choices=["fd1", "fd2"], help="作業用ディスクを挿す仮想ドライブ")
    args = ap.parse_args()

    health_check()

    mml_name = os.path.basename(args.mml)
    stem = os.path.splitext(mml_name)[0]
    m_name = f"{stem}.M"
    out_path = args.out or os.path.join(os.path.dirname(args.mml) or ".", f"{stem}_out.M")

    drive_num = 1 if args.drive == "fd1" else 2

    print(f"[1/6] {args.drive} に空FD(FAT12)を挿入します")
    call("insert_disk", {"drive": drive_num, "blank": True})

    print(f"[2/6] MC.EXE を書き込みます ({args.mc_exe})")
    with open(args.mc_exe, "rb") as f:
        mc_b64 = base64.b64encode(f.read()).decode()
    call("disk_write_file", {"slot": args.drive, "path": "MC.EXE", "base64": mc_b64})

    print(f"[3/6] {mml_name} を書き込みます")
    with open(args.mml, "rb") as f:
        mml_b64 = base64.b64encode(f.read()).decode()
    call("disk_write_file", {"slot": args.drive, "path": mml_name, "base64": mml_b64})

    drive_letter = "A" if args.drive == "fd1" else "B"
    print(f"[4/6] {drive_letter}: MC {stem} を実行します")
    screen = call_text("type_text", {"text": f"{drive_letter}:\r\nMC {stem}\r\n"})
    if "Compile Completed" not in screen and "compile completed" not in screen.lower():
        print("--- 画面出力 ---")
        print(screen)
        raise RuntimeError("コンパイル完了メッセージが確認できませんでした(エラーの可能性)")
    print("  -> Compile Completed.")

    print(f"[5/6] {m_name} を取り出します")
    read_text = call_text("disk_read_file", {"slot": args.drive, "path": m_name, "encoding": "base64"})
    data = decode_disk_read(read_text)
    with open(out_path, "wb") as f:
        f.write(data)
    print(f"  -> {out_path} ({len(data)} bytes)")

    if args.compare:
        with open(args.compare, "rb") as f:
            ref = f.read()
        if ref == data:
            print(f"[6/6] 一致確認: {args.compare} とバイト完全一致 (どちらも{len(ref)} bytes)")
        else:
            i = 0
            while i < min(len(ref), len(data)) and ref[i] == data[i]:
                i += 1
            print(f"[6/6] 不一致: {args.compare}={len(ref)} bytes / 取得={len(data)} bytes / 最初の差分位置=byte {i}")
            sys.exit(1)
    else:
        print("[6/6] 比較対象未指定のためスキップ")


if __name__ == "__main__":
    main()
