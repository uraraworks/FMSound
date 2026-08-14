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

rm -rf "$DIST"
mkdir -p "$DIST"

# 共通シェル・エンジンモジュール・共有描画層・共有UI・共有PMD MMLコンパイラ(html/app.jsから見た相対パスは
# 常にこのディレクトリ直下を前提にしているため、サブディレクトリへ逃がさずルート直下へ置く)。
cp -R html/. "$DIST/"
cp -R fmdsp "$DIST/fmdsp"
cp -R ui "$DIST/ui"
cp -R compiler "$DIST/compiler"

# MUCOM88側のwasmとサンプルMML(東方Projectとは無関係、Yuzo Koshiro氏の同梱サンプル)。
cp "$MUCOM_BUILD/mucom88.js" "$MUCOM_BUILD/mucom88.wasm" "$DIST/"
cp "$MUCOM_BUILD/sampl1.muc" "$MUCOM_BUILD/sampl2.muc" "$DIST/"

# PMD側のwasm。同梱サンプル曲は無し(pmdweb/README.md参照)。
cp "$PMD_BUILD/pmdweb.js" "$PMD_BUILD/pmdweb.wasm" "$DIST/"

echo "[build_dist.sh] $DIST/ を組み立てた。"
