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

## `html/sample_fur_elise_mucom.muc`(MUCOM88側の同梱サンプル曲)

上記 `html/sample_fur_elise.M` と同じ曲・同じ音符を MUCOM88 の MML 文法へ移植したもの。
権利関係(曲自体はパブリックドメイン、MML アレンジは本プロジェクトの著作物)も同じ。
生成元: `tools/sample_fur_elise_mucom.mml` → `tools/gen_sample_fur_elise.mjs`
(MUCOM88 自身がテキスト MML を直接コンパイルするため、事前コンパイルは不要でそのまま
コピーしている)。以前は MUCOM88 側だけ古代祐三氏の従来サンプル(`sampl1.muc` 等)を
同梱していたが、2026-08-15 に方針を変更し、両ドライバとも自作曲のみを同梱するように
した(`tools/verify_mucom_fur_elise.mjs` 参照)。

## `ui/mucom-voice-table.js`(MUCOM88既定音色バンクの名前一覧)

MUCOM88のZ80コンパイラは `@"名前"` 形式の音色参照で非ASCIIバイト(半角カナ等)を扱えず
必ずコンパイルエラーになる(実測で確定。`@番号` の数値指定は全件通る)。この制約を
避けるため、`@"名前"` を該当スロットの `@番号` へ事前置換する機能
(`ui/mucom-voice-resolve.js`)が参照する「スロット番号 -> 音色名」表。

MUCOM88由来のデータ。CC BY-NC-SA 4.0。

- 生成元: `upstream/MucomWeb/mucom88/src/bin_voice.h`(`bin_voice_dat`、既定音色バンク
  8192バイト=256スロット×32バイト。名前は各スロットのオフセット26-31の6バイト、
  `upstream/MucomWeb/mucom88/src/voiceformat.h` の `MUCOM88_VOICEFORMAT.name[6]` と対応)
- 生成器: `tools/gen_mucom_voice_names.py`

## `html/rhythm/2608_BD.WAV` ほか5本(MUCOM88リズム(G)パート用の代替波形)

MUCOM88のリズム(G)パートを鳴らすために同梱している6本のPCMサンプル
(`2608_BD.WAV` / `2608_SD.WAV` / `2608_TOP.WAV` / `2608_HH.WAV` / `2608_TOM.WAV` /
`2608_RIM.WAV`)。

- 原題: 「YM2608風リズム音源音色データ Ver.2.0」
- 作者: メモル (Takanori YOSHIMURA)
- 配布元: `http://sound.jp/jaime/fmp_top.html`
- **YM2608実チップのROMから吸い出したデータではない。** 同梱テキスト
  (`2608modoki2.txt`)に作者自身が明記しているとおり、「手持ちの音源から音色を
  集め、YM2608のリズム音に似せてエディットし」た独自制作の代替音であり、
  「本物のYM2608のリズム音とは根本的に波形が異なる」ことも作者本人が明言している。
  この事実は隠していない。README.md/README.ja.md の「できないこと」節、
  `html/help.html` の「制約と注意」節に明記している(2026-08-16以前は再生中の
  画面上にも毎回この注意を表示していたが、リズムが「無音」から「鳴るが波形が
  違う」へ実害が下がったため画面表示は取りやめた。`ui/mml-caveats.js`
  冒頭のコメント参照。制約自体は変わっていない)。
- 配布条件(原文引用): 「配布・転載・ソフトへの組み込み等、有償無償にかかわらず
  ご自由にどうぞ。」
- 本リポジトリでは元のファイル名(`2608_bd.wav`等、小文字)を、読み込み側
  (`upstream/MucomWeb/mucom88/src/fmgen/opna.cpp` `OPNA::LoadRhythmSample()`)が
  要求する大文字表記(`2608_BD.WAV`等)へリネームしただけで、データ自体は無改変。
  `2608_RYM.WAV`(RIMのフォールバック名、upstream側のパス連結バグにより
  `rhythmpath`が効かない)は使わず、常に一次候補の`2608_RIM.WAV`名で配置している
  (詳細は`mucomweb/patches/0003-mucomvm-rhythm-path.patch`のコメント参照)。
- 上記「含まないもの」(ROM/市販ソフトウェアのデータを含まない)という既存方針と
  矛盾しない(ROM由来ではなく作者独自制作のため)。

## `html/mucompcm.bin`(MUCOM88 Kパート(ADPCM)用の標準PCMバンク)

MUCOM88パッケージ同梱の標準PCMバンク(`upstream/MucomWeb/mucom88/package/mucompcm.bin`)を
無改変でコピーしたもの。サイズ63,640バイト、md5 `db66206edef7a3cbff79a72576d23aa6`。

- ライセンス: `upstream/MucomWeb/mucom88/package/license.txt` により CC BY-NC-SA 4.0
  (Copyright 1987-2019 Yuzo Koshiro ほか。adpcm converter は gasshi 2018)。
- FMSoundはMUCOM88同梱コード・データを既に含んでいることを理由にプロジェクト全体を
  CC BY-NC-SA 4.0としている(このファイルも同じ配布元・同じライセンスのため、新たな
  制約を追加するものではない)。

## 含まないもの

ROM イメージ(PC-98 本体 BIOS 等)や市販ソフトウェアのデータは、
本リポジトリに一切含まれていない。
