#!/usr/bin/env python3
"""実データ検証用: 任意の付随ファイル(FF/PPC等)を同じFDに置いた上でMC.EXEを実行する版。"""
import argparse
import base64
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from compile_pipeline import call, call_text, decode_disk_read, health_check  # noqa: E402


def write_file(drive, host_path, guest_name):
    with open(host_path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode()
    call("disk_write_file", {"slot": drive, "path": guest_name, "base64": b64})
    print(f"  wrote {guest_name} ({os.path.getsize(host_path)} bytes) <- {host_path}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mml", help="MMLファイル(scratchpad内、8.3準拠のファイル名)")
    ap.add_argument("--extra", action="append", default=[], help="追加で置くファイル(host path)。8.3名で置く")
    ap.add_argument("--mc-exe", default=os.path.join(os.path.dirname(__file__), "MC.EXE"))
    ap.add_argument("--compare", help="比較対象.M")
    ap.add_argument("--out", required=True)
    ap.add_argument("--drive", default="fd2", choices=["fd1", "fd2"])
    args = ap.parse_args()

    health_check()
    drive_num = 1 if args.drive == "fd1" else 2
    drive_letter = "A" if args.drive == "fd1" else "B"

    print("[1] blank FD insert")
    call("insert_disk", {"drive": drive_num, "blank": True})

    print("[2] write MC.EXE")
    write_file(args.drive, args.mc_exe, "MC.EXE")

    mml_name = os.path.basename(args.mml)
    stem = os.path.splitext(mml_name)[0]
    print(f"[3] write {mml_name}")
    write_file(args.drive, args.mml, mml_name)

    for extra in args.extra:
        gname = os.path.basename(extra)
        print(f"[3b] write extra {gname}")
        write_file(args.drive, extra, gname)

    print(f"[4] {drive_letter}: MC {stem}")
    screen = call_text("type_text", {"text": f"{drive_letter}:\r\nMC {stem}\r\n"})
    print("--- screen ---")
    print(screen)
    if "Compile Completed" not in screen:
        print("!!! Compile Completed が確認できませんでした")
        sys.exit(2)

    m_name = f"{stem}.M"
    print(f"[5] read {m_name}")
    text = call_text("disk_read_file", {"slot": args.drive, "path": m_name, "encoding": "base64"})
    data = decode_disk_read(text)
    with open(args.out, "wb") as f:
        f.write(data)
    print(f"  -> {args.out} ({len(data)} bytes)")

    if args.compare:
        with open(args.compare, "rb") as f:
            ref = f.read()
        if ref == data:
            print(f"[6] MATCH: {args.compare} と完全一致 ({len(ref)} bytes)")
        else:
            i = 0
            while i < min(len(ref), len(data)) and ref[i] == data[i]:
                i += 1
            ctx_ref = ref[max(0, i - 4):i + 12].hex()
            ctx_out = data[max(0, i - 4):i + 12].hex()
            print(f"[6] MISMATCH: ref={len(ref)}B out={len(data)}B first_diff=byte {i}")
            print(f"    ref  around diff: {ctx_ref}")
            print(f"    out  around diff: {ctx_out}")


if __name__ == "__main__":
    main()
