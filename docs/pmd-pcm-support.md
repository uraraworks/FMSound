# PMD側 PCM(.PPC/.PZI/.PVI)対応とリズム(Gパート)代替波形化 — 調査・実装記録

2026-08-17〜18 にかけて実装した、PMD側のPCM読み込み対応・PCM不足案内・
リズムパート鳴動・同名PCM取り違え修正・ライブラリのPCM保存対応をまとめた記録。
**同じ調査を2度やり直さないための文書**であり、実装の経緯そのままではなく
「次に読む人が知りたい結論」を先に置く構成にしている。

対応するコミット: `cb38f21` `d15acce` `e18fa2e` `d042c1c` `67a1a71` `6de2839`、
およびライブラリのPCM保存対応。

---

## 1. PMD側PCMがそもそも読めなかった理由

### 1.1 発見: `opendir("")` 失敗

upstream(`upstream/98fmplayer/`)の PCM読み込み経路は次の通り:

- `common/fmplayer_file.c` の `loadppc()`/`loadpmdppz()` が、`.M` ヘッダに
  埋め込まれたPCMファイル名を使って `fmplayer_fileread()` を呼ぶ。
- `common/fmplayer_file_unix.c` の `fmplayer_fileread()` は、**「.Mファイルと
  同じディレクトリ」を `opendir`/`readdir` で大文字小文字無視走査**して
  該当ファイルを探す。ディレクトリパス自体は呼び出し元(曲ファイルのパス)から
  導出される。

従来、MEMFS(emscriptenの仮想ファイルシステム)へは曲もPCMもルート直下
(`'/' + name`)へ書き込んでいた。この場合、曲ファイルのdirpathは**空文字**に
なり、`opendir("")` が失敗する。結果として **PCMは常に見つからず、ルート直下
配置ではPMD側のPCMは絶対に鳴らない。**

### 1.2 裏づけた実測

「ルート直下に曲と`.PPC`を両方置いた場合」のADPCM absSumを測定したところ、
**「`.PPC`を一切置かない陰性対照」の absSum と完全一致**した。つまり
ファイル自体は存在していても読み込みは常に失敗しており、見た目上は
「置いても置かなくても同じ(鳴らない)」という無言の失敗だった。

### 1.3 解決

`net/pmd-pcm.js` の `writeSongWithPcm()` が、曲ごとに専用のサブディレクトリを
MEMFS上に作り、曲ファイルとPCMファイルを必ず同居させるように変更した。
これにより `opendir(dirpath)` が正しいディレクトリを指すようになり、
`readdir()` の大文字小文字無視マッチが機能する。

検証: `tools/verify_pmd_ppc_load.mjs`(§5参照)。

---

## 2. upstreamのPCMスロット割り当て

`fmdriver.h` の共通ワーク構造体は4スロットのPCM状態を持つ
(`pcmname[FMDRIVER_PCMCOUNT][9]` / 対応する `pcmtype[]` / `pcmerror[]`)。
PMD(`fmdriver_pmd.c` の `pmd_get_pcm_status()` 相当、6059-6066行付近)での
割り当ては固定:

| slot | 対応形式 | `pcmtype` 文字列 | ソース中の変数 |
|---|---|---|---|
| 0 | `.PPC`(ADPCM) | `"PPC"` | `pmd->ppcfile` |
| 1 | `.PZI`/`.PVI`(PPZ8バンク1) | `"PPZ1"` | `pmd->ppzfile` |
| 2 | `.PZI`/`.PVI`(PPZ8バンク2) | `"PPZ2"` | `pmd->ppzfile2` |
| 3 | `.P86`/`.PPS` | (upstreamは未実装のため常に不使用) | `pmd->ppsfile` |

`pcmname` は `char[9]`(8文字+NUL)固定長。書き込みは `fmdriver_fillpcmname()`
(`fmdriver_common.h`)が行い、**8文字までコピーしてスペースパディング、
拡張子は含まない**(元の実装が8.3形式のファイル名から拡張子部分を
そもそも渡していない)。そのため「同じ曲名で拡張子だけ違うPCM」が複数
存在しても `pcmname` だけからは拡張子を復元できない。

PPZ8は**2バンクまで**(slot 1, 2)。3つ目以降のPPZファイルを曲が参照する
実装上の余地はない。

---

## 3. PMD86を`.M`から判別できない理由

> **2026-08-19 追記**: `.P86` はその後 `net/pmd-p86.js` による疑似
> `.PPC`(ADPCM)変換で対応済みになった。upstream の C 側(このslotの
> 読み込み自体)は依然未実装のままで、以下の記述はその upstream 側の
> 制約について書いたもの。JS側の変換方式・実測の経緯は
> `docs/pmd-p86-support.md` を参照。`.PPS`(PPSDRV用PCM)は今も未対応。

- slot 3 (`pmd->ppsfile`) は `.P86`(PMD86用PCM)・`.PPS`(PPSDRV用PCM)の
  両方を指しうるが、**upstreamはこのslotの読み込み自体を実装していない**
  (`loadppc()`/`loadpmdppz()` に相当する `.P86`/`.PPS` 用のローダが
  `fmplayer_file.c` に存在しない)。
- 曲が実際にPMD86ドライバ向けにコンパイルされたものかどうかは、`struct
  driver_pmd` (`fmdriver_pmd.c`)に該当を示すフィールドが無いため**`.M`
  データからは判別不能**。実機でも、PMD86かどうかは常駐しているドライバ
  本体(PMD86.COM / PMDPPS.COM等、PC-98のメモリに常駐する側)の種別で
  決まるものであり、`.M`ファイル(曲データ)側に埋め込まれる情報ではない。
- そのためPMD86の曲を読み込んでも、slot 0 (`ppcfile`)にファイル名が
  入っていれば `.PPC`(ADPCM)不足として通常どおり案内が出る(実際には
  PMD86向けの`.P86`が必要な曲でも、slot 0 は「PPC」型として現れる)。

### 対応方針(当時。`.P86`はその後対応済み)

- 書庫(zip等)に `.P86` が同梱されており、かつそのファイル名がPCM不足
  メッセージの対象ファイル名と一致する場合は、**PCM不足の案内自体を
  抑止する**(当時は実際には対応していなかったが、必要なファイルは
  同梱されているため誤解を招く「不足」表示をしない、という判断)。
- 単体の`.M`ファイルとして開いた場合(書庫を伴わない)は、PCM不足文言に
  「PMD86/PPSDRVは未対応」の注記を出す。

`.P86` はその後 `net/pmd-p86.js` による疑似`.PPC`変換で対応済みになった
ため、現在この注記が指すのは実質 `.PPS`(PPSDRV)のみ。詳細は
`docs/pmd-p86-support.md` を参照。

検証: `tools/verify_pmd_pcm_missing.mjs`(§5参照)。

---

## 4. リズムROM(Gパート)代替波形の領域表

### 4.1 前提

`pmdweb` は元々 `opna_drum_set_rom()` (`upstream/98fmplayer/libopna/opnadrum.c`)
を一度も呼んでいなかったため、**曲の内容に関わらずリズムパートは常に無音**
だった。**実機ROMは一切使用していない**。既存の自作リズム波形
(`html/rhythm/2608_*.WAV`。出自は `NOTICE.md`。MUCOM88側で既に使用中の
同じ素材)を、YM2608リズムROM形式(8KB、ADPCM-A圧縮)へ変換して
`opna_drum_set_rom()` に渡すことで解決した。

### 4.2 領域表

領域アドレス・division係数(`div`)は `upstream/98fmplayer/libopna/opnadrum.h`
の `OPNA_ROM_*_START`/`OPNA_ROM_SIZE` と、`opnadrum.c` `opna_drum_set_rom()`
内の `part[6]` テーブルからそのまま採った(推測なし)。ベースmixレートは
`opna.c` が `opna_drum_mix()` を `opna_fm_mix()`/`opna_ssg_mix_55466()` と
同じサンプル数で呼ぶ実装と、`opnassg.h` のコメント「7987200/144 Hz」から
特定: **7987200/144 Hz ≒ 55466.67 Hz**。

| 音 | 開始アドレス | 領域バイト数 | div | 実効レート | 元WAV長 | 詰めた後の長さ |
|---|---|---|---|---|---|---|
| BD | 0x0000 | 448 (0x1c0) | 3 | ≒18488.9Hz | 149ms | 48.4ms |
| SD | 0x01c0 | 640 (0x280) | 3 | ≒18488.9Hz | 142ms | 69.1ms |
| TOP | 0x0440 | 5952 (0x1740) | 3 | ≒18488.9Hz | 653ms | 643.7ms |
| HH | 0x1b80 | 384 (0x180) | 3 | ≒18488.9Hz | 92ms | 41.4ms |
| TOM | 0x1d00 | 640 (0x280) | 6 | ≒9244.4Hz | 182ms | 138.2ms |
| RIM | 0x1f80 | 128 (0x80) | 6 | ≒9244.4Hz | 99ms | 27.5ms |

ROM全体は8KB(0x2000)固定で、上表の6領域で埋まる(RIMのみ末尾がROM終端)。
領域サイズは固定のため、元WAVがそれより長い場合は詰めて(トリムして)
エンコードしている。**MUCOM88側は同じWAVファイルを直読みしており、この
尺の詰めを行っていないため、同じ素材でも同一の音にはならない。**
切り口のクリックノイズ回避に4msのフェードアウトを追加している。

実装調査で判明した副次的な事実: `opnadrum.c` の復号側の停止条件は、
各領域の**最終1バイトを実際には復号しない**(1バイト早く止まる)。
これに合わせ、エンコーダも1バイト短い範囲で符号化するよう調整した
(`tools/gen_rhythm_rom.py` の `region_bytes()` docstring参照)。

### 4.3 エンコーダの実装方針

ADPCM-Aの復号アルゴリズム(steps[49]テーブル・step_inc[8]・12bit wrapする
差分積分器)は `opnadrum.c` の復号処理をそのまま読み取り値をコピーし、
その**逆写像**(目標波形に最も近い出力になるnibbleを16通りから貪欲選択する
適応的ADPCMエンコーダ)として実装した(`tools/gen_rhythm_rom.py`)。
推測でパラメータを決めた箇所はない。

---

## 5. 検証スクリプト一覧と陽性対照

| スクリプト | 目的 | 陽性対照(症状で確実に落ちることの確認) |
|---|---|---|
| `tools/verify_pmd_ppc_load.mjs` | `.PPC`が本番経路(`writeSongWithPcm()`→`playMusic()`)で実際に読めること | 同じ曲と`.PPC`を**ルート直下**に置いた配置ではabsSumがほぼ0になることを確認(§1.2の不具合状態を意図的に再現) |
| `tools/verify_pmd_pcm_missing.mjs` | PCM不足時に利用者へ理由が表示されること | `describePmdPcmStatus()`が空配列を返すよう入力を意図的に壊し、本来の主張(不足メッセージが出ること)を検査する側が確実にFAILすることを確認 |
| `tools/verify_pmd_rhythm.mjs` | リズムROMがwasm(`PmdCore.c`)へ結線されたこと | `Module.testResetDrumNoRom()`(`opna_drum_set_rom()`を呼ばない、結線前の状態を再現するテスト専用API)の直後は同じ手順でabsSumが0であることを確認 |
| `tools/verify_rhythm_rom.mjs` | 生成した8KB ROMの往復精度・決定論性 | ROMの特定領域を意図的にゼロで潰すと、その音の検査だけが落ちることを確認。復号側は自作コードではなく upstream `opnadrum.c` の実物をビルドしたネイティブハーネス(`tools/rhythm_rom_decode_harness.c`)を使う(自作エンコーダを自作デコーダで検証しない原則) |
| `tools/verify_library.mjs` | ライブラリ(IndexedDB)がPCMを保持し、選び直しても曲が正しく鳴ること | (詳細は `net/library.js` 側のコメント参照。本文書はPCM本体側の記録のため実装ファイルの詳細には立ち入らない) |

---

## 6. その他の不具合: 同名PCMの取り違え

書庫がサブフォルダ構成で、**同名だが中身の違うPCMファイル**を複数の
ディレクトリに含む場合(実データで発覚)、basename化して1つに絞る従来の
`collectPmdPcmFiles()` は「entries内で後に出現した方」を無条件に採用して
いたため、選んだ曲とは無関係な別ディレクトリのPCMバンクを読み込んで
しまっていた。**音自体は出るため、無音と違い気づきにくい不具合**だった。

`collectPmdPcmFiles(entries, songEntryName)` に第2引数(選ばれた曲の書庫内
エントリ名)を追加し、同名候補があれば曲と同じディレクトリのものを優先する
形に修正した。

---

## 7. データの扱いについて

本記録の実測(§1.2のabsSum一致、§2〜4の各種確認)はすべて手元の環境で
行ったものであり、**検証に使った実データ(書庫・曲ファイル)はリポジトリに
一切含めていない**。本文書でも曲名・作者名など実データの中身には触れず、
ファイルの拡張子構成と測定値の記録にとどめている。
