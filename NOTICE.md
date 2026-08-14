# NOTICE

このリポジトリが追跡する生成物には、第三者の著作物に由来するものが含まれる。
出所とライセンスを以下に明記する。

## `pmdweb/html/shinonome.rom`

東雲フォント(Shinonome Font)由来。パブリックドメイン。

- 生成元: `upstream/98fmplayer/fmdsp/fontrom_shinonome.inc`
- 生成器: `tools/gen_fontrom.py`

## `pmdweb/html/fmdsp/sprites.js` / `palette.js` / `font_small.js`

98fmplayer のデータに由来する。

```
BSD 2-Clause License

Copyright (c) 2016, Takamichi Horikawa
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

(全文は `upstream/98fmplayer/LICENSE` を参照。本リポジトリでは `upstream/` を
追跡しないため、著作権表示保持の条件を満たすためここに引用している。)

## `mucomweb` のビルドに含まれる 98fmplayer 由来のコード

`mucomweb`(MUCOM88 on Web)側のFMDSP右半分スペクトラムアナライザ(70ビン)は、
上記と同じ `upstream/98fmplayer/fft/fft.c` / `fft/fft.h`(BSD 2-Clause、無改変)を
`mucomweb/CMakeLists.txt` からビルドに取り込んで実現している。ライセンス全文は
上記の引用と同一。

## `pmdweb/html/fmdsp/*.js` の描画ロジック

FMDSP 風の画面描画ロジック(パート行 / コメント欄 / 右半分の各表示)は、
98fmplayer の実装を参考にWeb版へ移植したものである。

## `html/sample_fur_elise.M`(PMD側の同梱サンプル曲)

- 曲: ルートヴィヒ・ヴァン・ベートーヴェン「エリーゼのために」(Für Elise) WoO 59。
  作曲者の没後長期間が経過しており、曲そのものはパブリックドメイン。
- 参照した楽譜: Mutopia Project (`https://www.mutopiaproject.org/`) の浄書版
  (`エリーゼのために.pdf`)。フッターに
  "Placed in the public domain by the typesetter — free to distribute, modify,
  and perform" と明記されており、版面(エングレービング)自体も自由に利用できる。
- 範囲: 上げ拍(アナクルーシス)+ 4小節分(楽譜冒頭、"Poco moto"の有名な開始フレーズ)。
- **MML アレンジ(音符のパート割り当て・音色定義・伴奏の和音進行)は本プロジェクトの
  著作物**。旋律の音程列は上記楽譜から実測で書き起こしたもので、他人が作成した
  MML/MIDI ファイルは一切参照・使用していない(`tools/sample_fur_elise.mml` 冒頭コメント、
  `tools/verify_sample_fur_elise.mjs` 参照)。
- 生成元: `tools/sample_fur_elise.mml`(MML ソース)→ `tools/gen_sample_fur_elise.mjs`
  (自作 PMD MML コンパイラ、`docs/pmd-compiler-spec.md` 参照)→ `html/sample_fur_elise.M`。

## 含まないもの

ROM イメージ(PC-98 本体 BIOS 等)や市販ソフトウェアのデータは、
本リポジトリに一切含まれていない。
