# pmdweb

98fmplayer の PMD ドライバと libopna を、upstream を変更せず WebAssembly 化したプレイヤーです。

```sh
source ../emsdk/emsdk_env.sh
emcmake cmake -S . -B build-web -DCMAKE_BUILD_TYPE=Release
cmake --build build-web -j4
```

`build-web/` を HTTP サーバーで配信し、`index.html?engine=pmd` を開きます
（1アプリ化により `mucomweb` と UI を共有している。エンジン選択は `?engine=` のクエリで行う。
詳細は `../README.md` 参照）。音源の内部レートは98fmplayer と同じ 55467Hz 固定です。
YM2608 リズム ROM は同梱せず、未ロード時はリズムのみ無音です。

**同梱サンプル曲は現在ありません。** 以前は `upstream/pmdmini/PC-98_Hartmann_s_Youkai_GIrl.M`
（東方Projectの楽曲のアレンジ、権利未確認）をビルド成果物へコピーしていましたが取りやめました。
「曲を開く」から手元の `.M`/`.m` ファイルを読み込んでください。自作サンプルは別タスクで用意します。

スナップショットは2048エントリ、21トラック、1トラック26個の int32 です。フィールド順は
`playing, info, ticks, ticks_left, key, actual_key, tonenum, volume, gate, detune,
status[0..8], fmslotmask[0..3], ppz8_ch, ssg_tone, ssg_noise` です。
