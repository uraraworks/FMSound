#!/usr/bin/env python3
"""compile_corpus.py で一度セットアップ済み(MC.EXE書き込み済み)のFD2に対し、
1曲だけ再コンパイルする軽量版。使い方: python3 recompile_only.py <stem>

PMD_CORPUS_DIR: 対象 .mml が置かれ、結果の .M を書き戻すディレクトリ。必須。
"""
import base64, json, os, sys, urllib.request

BRIDGE_HTTP_PORT = int(os.environ.get("BRIDGE_HTTP_PORT", "8765"))
BASE_URL = f"http://127.0.0.1:{BRIDGE_HTTP_PORT}"
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

if not CORPUS_DIR:
    print("エラー: 環境変数 PMD_CORPUS_DIR が未設定です", file=sys.stderr)
    sys.exit(1)

stem = sys.argv[1]
mml_path = os.path.join(CORPUS_DIR, f"{stem}.mml")
guest_name = f"{stem.upper()}.MML"
with open(mml_path, "rb") as f:
    mml_b64 = base64.b64encode(f.read()).decode()
call("disk_write_file", {"slot": "fd2", "path": guest_name, "base64": mml_b64})
screen = call_text("type_text", {"text": f"MC /V {stem.upper()}\r\n"})
if "Compile Completed" not in screen:
    print("FAIL", screen[-600:]); sys.exit(1)
m_name = f"{stem.upper()}.M"
data = decode_disk_read(call_text("disk_read_file", {"slot": "fd2", "path": m_name, "encoding": "base64"}))
out_path = os.path.join(CORPUS_DIR, f"{stem}.M")
with open(out_path, "wb") as f:
    f.write(data)
print(f"OK -> {out_path} ({len(data)} bytes)")
