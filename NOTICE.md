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

## `pmdweb/html/fmdsp/*.js` の描画ロジック

FMDSP 風の画面描画ロジック(パート行 / コメント欄 / 右半分の各表示)は、
98fmplayer の実装を参考にWeb版へ移植したものである。

## 含まないもの

ROM イメージ(PC-98 本体 BIOS 等)や市販ソフトウェアのデータは、
本リポジトリに一切含まれていない。
