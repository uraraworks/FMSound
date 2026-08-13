# pmdweb

98fmplayer の PMD ドライバと libopna を、upstream を変更せず WebAssembly 化したプレイヤーです。

```sh
source ../emsdk/emsdk_env.sh
emcmake cmake -S . -B build-web -DCMAKE_BUILD_TYPE=Release
cmake --build build-web -j4
```

`build-web/` を HTTP サーバーで配信し、`index.html` を開きます。音源の内部レートは
98fmplayer と同じ 55467Hz 固定です。YM2608 リズム ROM は同梱せず、未ロード時はリズムのみ無音です。

スナップショットは2048エントリ、21トラック、1トラック26個の int32 です。フィールド順は
`playing, info, ticks, ticks_left, key, actual_key, tonenum, volume, gate, detune,
status[0..8], fmslotmask[0..3], ppz8_ch, ssg_tone, ssg_noise` です。
