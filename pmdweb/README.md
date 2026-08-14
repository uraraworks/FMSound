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

以前は `upstream/pmdmini/PC-98_Hartmann_s_Youkai_GIrl.M`（東方Projectの楽曲のアレンジ、
権利未確認）を同梱していましたが取りやめました。代わりに `html/sample_fur_elise.M`
（ベートーヴェン「エリーゼのために」冒頭、パブリックドメイン曲からの自作MML書き起こし。
詳細は `../NOTICE.md` 参照）を同梱しています。「曲を開く」から手元の `.M`/`.m` ファイルを
読み込むこともできます。

スナップショットは2048エントリ、21トラック、1トラック26個の int32 です。フィールド順は
`playing, info, ticks, ticks_left, key, actual_key, tonenum, volume, gate, detune,
status[0..8], fmslotmask[0..3], ppz8_ch, ssg_tone, ssg_noise` です。
