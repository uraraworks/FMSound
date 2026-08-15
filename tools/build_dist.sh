#!/usr/bin/env bash
# 1アプリ化した FMSound を GitHub Pages 想定の単一ディレクトリ(dist/)へ組み立てる。
#
# 前提: mucomweb/build-web と pmdweb/build-web が両方ビルド済みであること
# (このスクリプト自体はビルドしない。README.md の検証手順参照)。
#
# dist/ には mucom88.js/.wasm と pmdweb.js/.wasm の両方が並ぶ(=どちらのエンジンで
# 開き直しても404にならない)が、ページ本体(html/app.js)は ?driver= に応じて
# 動的import(import())で片方のエンジンモジュールしか評価しないため、
# 実行時にロードされるwasmは常に選ばれた側の1本だけになる。
#
# 実行: tools/build_dist.sh
set -euo pipefail
cd "$(dirname "$0")/.."

MUCOM_BUILD="mucomweb/build-web"
PMD_BUILD="pmdweb/build-web"
DIST="dist"

if [ ! -f "$MUCOM_BUILD/mucom88.wasm" ]; then
  echo "error: $MUCOM_BUILD/mucom88.wasm が無い。先に mucomweb をビルドすること。" >&2
  exit 1
fi
if [ ! -f "$PMD_BUILD/pmdweb.wasm" ]; then
  echo "error: $PMD_BUILD/pmdweb.wasm が無い。先に pmdweb をビルドすること。" >&2
  exit 1
fi

# net/config.js(中継サーバーURL)を環境変数 DISK_PROXY_URL から生成する。
# ui/version.jsと同じ作法(tools/gen_version.py)。DISK_PROXY_URL未設定でも空文字列で
# 生成され、ビルド自体は通る(中継しないだけ。forkしたリポジトリ向けの既定挙動)。
python3 tools/gen_net_config.py

rm -rf "$DIST"
mkdir -p "$DIST"

# 共通シェル・エンジンモジュール・共有描画層・共有UI・共有PMD MMLコンパイラ・net層
# (曲データの取得/書庫展開。html/app.jsから見た相対パスは常にこのディレクトリ直下を
# 前提にしているため、サブディレクトリへ逃がさずルート直下へ置く)。
cp -R html/. "$DIST/"
cp -R fmdsp "$DIST/fmdsp"
cp -R ui "$DIST/ui"
cp -R compiler "$DIST/compiler"
cp -R net "$DIST/net"

# MUCOM88側のwasm。同梱サンプル(sample_fur_elise_mucom.muc/samplja.muc)はhtml/直下に
# あり、上のcp -R html/. で既にコピー済み(課題D、2026-08-15: 古代祐三氏のsampl1/2/3.mucの
# 同梱はやめた。方針は「同梱するのは自作曲のみ、両ドライバとも同じ曲」)。
cp "$MUCOM_BUILD/mucom88.js" "$MUCOM_BUILD/mucom88.wasm" "$DIST/"

# PMD側のwasm。同梱サンプル曲は無し(pmdweb/README.md参照)。
cp "$PMD_BUILD/pmdweb.js" "$PMD_BUILD/pmdweb.wasm" "$DIST/"

# 課題A(2026-08-15): GitHub Pagesはレスポンスヘッダのキャッシュ制御を我々が
# 設定できない(実測: HTML/JS/wasmいずれもcache-control: max-age=600)ため、
# 「更新のたびにURLを変える」方式で確実に新しい版を届ける。既存のビルドID
# (tools/gen_version.py、コミットハッシュ)を流用し、静的importのURLへ
# ?v=<hash> を機械的に付与する。詳細はtools/apply_cache_bust.py参照。
python3 tools/apply_cache_bust.py "$DIST"

echo "[build_dist.sh] $DIST/ を組み立てた。"
