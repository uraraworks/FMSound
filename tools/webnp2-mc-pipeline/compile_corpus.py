#!/usr/bin/env python3
"""corpus一括コンパイル: 1枚のFDにMC.EXEを1回だけ書き込み、複数のMMLを順にMC /V <stem>で
コンパイルして .M を回収する。FMSound corpus作成専用の使い捨てスクリプト。

PMD_CORPUS_DIR: コンパイル対象の .mml が並ぶディレクトリ(結果の .M もここに書き戻す)。
  必須。私物データを扱うため決め打ちのデフォルトは持たない。
  例: PMD_CORPUS_DIR=/path/to/corpus python3 compile_corpus.py
"""
import base64
import json
import os
import sys
import urllib.request

BRIDGE_HTTP_PORT = int(os.environ.get("BRIDGE_HTTP_PORT", "8765"))
BASE_URL = f"http://127.0.0.1:{BRIDGE_HTTP_PORT}"
HERE = os.path.dirname(__file__)
MC_EXE_PATH = os.environ.get("MC_EXE_PATH", os.path.join(HERE, "MC.EXE"))
CORPUS_DIR = os.environ.get("PMD_CORPUS_DIR")


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


def decode_disk_read(text):
    lines = text.split("\n", 1)
    b64 = lines[1] if len(lines) > 1 else lines[0]
    return base64.b64decode(b64)


def main():
    if not CORPUS_DIR:
        print("エラー: 環境変数 PMD_CORPUS_DIR が未設定です", file=sys.stderr)
        sys.exit(1)

    stems = sys.argv[1:]
    if not stems:
        stems = sorted(f[:-4] for f in os.listdir(CORPUS_DIR) if f.endswith(".mml"))

    with urllib.request.urlopen(f"{BASE_URL}/health", timeout=5) as resp:
        assert resp.read().decode() == "ok"

    print("[setup] blank FD2 insert + MC.EXE write")
    call("insert_disk", {"drive": 2, "blank": True})
    with open(MC_EXE_PATH, "rb") as f:
        call("disk_write_file", {"slot": "fd2", "path": "MC.EXE", "base64": base64.b64encode(f.read()).decode()})

    results = {}
    for stem in stems:
        mml_path = os.path.join(CORPUS_DIR, f"{stem}.mml")
        guest_name = f"{stem.upper()}.MML"
        with open(mml_path, "rb") as f:
            mml_b64 = base64.b64encode(f.read()).decode()
        call("disk_write_file", {"slot": "fd2", "path": guest_name, "base64": mml_b64})
        screen = call_text("type_text", {"text": f"MC /V {stem.upper()}\r\n"})
        if "Compile Completed" not in screen:
            print(f"[{stem}] !!! Compile Completed not seen")
            print(screen[-600:])
            results[stem] = {"ok": False, "screen": screen[-600:]}
            continue
        m_name = f"{stem.upper()}.M"
        try:
            read_text = call_text("disk_read_file", {"slot": "fd2", "path": m_name, "encoding": "base64"})
        except RuntimeError as e:
            print(f"[{stem}] !!! disk_read_file failed: {e}")
            results[stem] = {"ok": False, "error": str(e)}
            continue
        data = decode_disk_read(read_text)
        out_path = os.path.join(CORPUS_DIR, f"{stem}.M")
        with open(out_path, "wb") as f:
            f.write(data)
        print(f"[{stem}] OK -> {out_path} ({len(data)} bytes)")
        results[stem] = {"ok": True, "bytes": len(data)}

    print("\n=== summary ===")
    for stem, r in results.items():
        print(stem, r.get("ok"), r.get("bytes", r.get("error", "")))


if __name__ == "__main__":
    main()
