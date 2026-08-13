# 音と表示の同期 — 設計

## 1. 問題の定量化

現状の MucomWeb の音声経路（実測）:

| 項目 | 値 |
|---|---|
| `StreamingPlayer::BufferCount` | 2 |
| 1バッファのサイズ | `min(32000, (sampleRate+3)/4)` |
| → 44.1kHz での実値 | 11025 フレーム = **250ms** |
| キュー全体 | **最大 500ms** |
| ポーリング | `emscripten_set_main_loop(..., 60, 1)` で `AL_BUFFERS_PROCESSED` を監視 |

サンプルレートに関わらず常に 1/4 秒になる作りなので、**表示は音より 250〜500ms 先行する**。
120BPM なら8分音符ぶん。FMDSP 系の表示としては論外の量。

目標は **±10ms 以内**（人間の音映像同期許容が ±20〜40ms、60fps の1フレームが 16.7ms）。

## 2. 中核となる原理

**壁時計を使わない。単一のクロック＝累積フレーム数だけで考える。**

- `renderFrame` … エミュレータが生成し終えたフレーム総数（＝エミュレータ時間）
- `playFrame` … DAC が実際に消費したフレーム総数（＝可聴時間）

表示すべきは常に **`playFrame` 時点の状態**であって、`renderFrame` 時点ではない。
現状の rAF ポーリングは `renderFrame` の最新値を読んでいるので先行する。

## 3. スナップショットをどこで取るか

**rAF では取らない。レンダリングループ内の「ドライバ割り込み処理直後」で取る。**

理由:
- ドライバの状態が変化するのは**タイマー割り込みの瞬間だけ**。間は何も変わらない
- その瞬間なら、対応する `renderFrame` の値が正確に分かる
- 頻度がタイマー割り込みレート（60〜600Hz 程度）で済み、オーディオブロック単位より安い

両エンジンとも、同じ概念位置にきれいなフックがある:

| エンジン | フック位置 |
|---|---|
| MUCOM88 | `mucomvm::RenderAudio()` 内、Z80 タイマー割り込みを処理した直後<br>（`CMucom::RenderAudio` @ cmucom.cpp:651 → `vm->RenderAudio(mix, size)`） |
| PMD/FMP | `libopna/opnatimer.c` の `opna_timer_mix()` → `driver_opna_interrupt()` の直後 |

**98fmplayer は既に同じ場所で同じことをしている。**
`opna_timer_mix_oscillo(timer, buf, samples, struct oscillodata *oscillo)` という
オシロスコープ用データを通すバリアントが存在する（opnatimer.c:74）。
つまり「レンダリング経路に可視化データを相乗りさせる」という設計は myon98 氏が既に採用済みで、
我々はその確立された道に乗るだけでよい。

## 4. データ構造 — タイムスタンプ付きスナップショットリング

```c
typedef struct {
  uint32_t frame;                      // このスナップショット時点の renderFrame
  FMTrackStatus tracks[FM_TRACK_MAX];  // 共通スキーマ（fmdriver_track_status 準拠）
} FMStatusSnapshot;

void fmstatus_push(const FMStatusSnapshot *s);   // レンダラが1ティックごとに呼ぶ
```

- 書き手はレンダラ、読み手は表示側の **single-producer / single-consumer**
- リングサイズ 2048 エントリ（600Hz でも 3.4 秒ぶん）
- 表示側は `playFrame` 以下で最新のエントリを二分探索で引く

### 重要: ステップ1の API 形状はここでは使えない

現在の `GetChannelData()` は `emscripten::val::object()` で **11個の JS オブジェクトを毎回生成**している。
疎通確認には十分だが、これをティックごとに呼ぶとオーディオ経路で毎秒数千回の JS アロケーションが走る。

→ リングは **wasm ヒープ上のフラットな構造体配列**として確保し、
JS 側は `HEAP32.subarray()` でビューを張って読むこと。JS オブジェクトを作らない。

## 5. `playFrame` をどう知るか（本題）

### 案A: AudioWorklet + SharedArrayBuffer（サンプル精度）

- ワークレットが SAB のオーディオリングを drain し、出力済みフレーム数を Atomics で書く
- 表示側は Atomics で読むだけ。誤差ゼロ
- **要 COOP/COEP ヘッダ**（cross-origin isolation）。GitHub Pages では設定できないため
  Service Worker で付与する等の小細工が必要

### 案B: AudioWorklet + postMessage（推奨・まずこれ）

- ワークレットが 10 量子ごと（約 26ms）に `{playFrame, currentTime}` を postMessage
- 表示側はメッセージ間を補間:
  ```js
  const est = playFrame + (ctx.currentTime - msgTime) * sampleRate;
  const audibleFrame = est - ctx.outputLatency * sampleRate;
  ```
- 誤差は数ms。**目標の ±10ms を満たす**
- SAB 不要 ＝ COOP/COEP 不要。GitHub Pages にそのまま置ける

### 案C: OpenAL のまま（非推奨）

emscripten の OpenAL は Web Audio の薄いラッパで、`AL_SAMPLE_OFFSET` の粒度が粗い。
2バッファ構成のままバッファを小さくするとドロップアウトする。**採らない。**

### 結論

**案B で始める。** サンプル精度が必要になったら案A へ移行する（リング構造は共通なので移行は局所的）。

これに伴い **OpenAL は捨てて AudioWorklet に移行する**。
これは README の課題1（AudioWorklet 化）と同じ作業なので、同時にやるのが正しい。

## 6. 遅延そのものを減らす

同期とは独立に、レンダリング粒度を落とす:

- 現在: 11025 フレーム/ブロック（250ms）
- 変更後: 1024〜2048 フレーム/ブロック（23〜46ms）
- ワークレット化後はリング深度が実効レイテンシになる。**目標 50〜100ms**

## 7. 共通化の設計

C 側の契約を1本に定め、エンジンごとにアダプタを書く:

```
[MUCOM]  PCHDATA              --adapter-->  FMTrackStatus
[PMD]    fmdriver_track_status --adapter-->  FMTrackStatus   (ほぼ恒等)
                                   |
                         fmstatus_push(frame, tracks)
                                   |
                          wasm ヒープ上のリング
                                   |
                    JS: HEAP32 ビュー + playFrame で二分探索
                                   |
                              Canvas 描画
```

## 8. 落とし穴（実装時に必ず踏む）

1. **停止・シーク時にリングを無効化する。** しないと古いスナップショットが引かれ続ける
2. **バックグラウンドタブで rAF が止まる**が音は進む。復帰時に溜まった分を再生し直さず、
   `audibleFrame` 以下の最新へ即ジャンプすること
3. **リングのオーバーラン**。読み手が遅れたらクラッシュせず最新へクランプ
4. **`ctx.outputLatency` が 0 や undefined のブラウザがある。**
   `baseLatency` → 固定値の順にフォールバックし、**耳で微調整できるよう調整値を露出しておく**
   （実測で合わせるのが最終的に一番早い）
5. **スナップショットのコスト**: 11ch × 15 int = 660 バイト/ティック。600Hz で約 400KB/s。
   フラット配列なら問題ないが、JS オブジェクト化すると破綻する（→ 4章）

## 9. 段階

| 段階 | 内容 | 検証 |
|---|---|---|
| 2-a | AudioWorklet 化（OpenAL 撤去）。同期はまだ無し | 音が出続ける・途切れない |
| 2-b | wasm ヒープ上のスナップショットリング + `fmstatus_push` | ティックごとに frame が単調増加 |
| 2-c | ワークレットから `playFrame` を postMessage、二分探索で引く | 先行が 250ms → 10ms 台に |
| 2-d | 耳で微調整（`outputLatency` 補正値） | 目視と聴感が一致 |

段階 2-a と 2-b は独立なので並行して進められる。

## 10. 段階 2-a / 2-b の実装メモ

- AudioWorklet は 2048 フレームの transferable `ArrayBuffer` をキューイングする。44.1kHz の目標深度は4096フレーム（92.9ms）、補充閾値は1792フレーム（40.6ms）。
- `playFrame` はワークレット内で128フレーム量子ごとに加算するが、段階 2-c までは送出しない。
- MUCOM88 サブモジュールを変更しないため、スナップショットは `CMucom::RenderAudio(..., 2048)` の直後に取得する。frame 精度は2048フレーム境界。
- 1エントリは664バイト（frame 1語 + 11ch × 15語）。track の順序は `length, vnum, volume, quantize, detune, fnum1, fnum2, code, flag, pan, keyon, alg, chnum, vnum_org, vol_org`。
- JS は `getSnapshotRingPointer()` と `getSnapshotEntryByteSize()` から `Module.HEAP32.subarray()` を作る。`getSnapshotWriteIndex()` は累積書き込み数で、最新 slot は `(writeIndex - 1) & 2047`。停止中は `0xffffffff`、開始直後の空状態は `0`。

## 11. 段階 2-a / 2-b の実測結果と、残った精度問題

### 実測（55467Hz, sampl2.muc, Chrome）

| 項目 | 結果 |
|---|---|
| AudioWorklet 供給 | `requested == rendered`、不足なし |
| アンダーフロー | 起動時の 2944 のみ。**3秒間で増加ゼロ**（定常状態はクリーン） |
| キュー深度 | 2944 フレーム ≒ **53ms**（目標 50〜100ms 内） |
| frame の増加 | 3秒で 82 ブロック、**きっちり 2048 ずつ単調増加** |
| 停止時 | `writeIndex` が `0xffffffff` に戻る（落とし穴1クリア） |
| コンソールエラー | なし |

音声基盤としては合格。**ただし精度が目標に届いていない。**

### 問題: スナップショット精度 36.9ms（目標 ±10ms）

submodule 非改変の制約から、スナップショットが `RenderAudio(buf, 2048)` の直後、
すなわち **2048 フレーム境界でしか取れていない**。

```
2048 / 55467 = 36.9ms
```

1章で定めた目標 ±10ms を満たさない。二分探索を実装しても**精度がここで頭打ちになる**。
さらに 36.9ms の間にドライバのタイマー割り込みは複数回発生しているため、
**その間の音符変化が潰れて最後の状態しか残らない**（16分音符 = 150BPM で 100ms なので目に見えて雑になる）。

### 対策: サブブロック分割（submodule 改変不要）

`CMucom::RenderAudio(buf, size)` は任意の `size` で呼べる。
**ワークレットへ渡すブロックは 2048 のまま、内部を 256 フレーム × 8 回に分割**し、
その都度スナップショットを取る。

```
現在: RenderAudio(buf, 2048)          → snapshot 1回 → 36.9ms 精度
変更: RenderAudio(buf + i*256, 256)×8 → snapshot 8回 →  4.6ms 精度
```

| | 現在 | 変更後 |
|---|---|---|
| 精度 | 36.9ms | **4.6ms**（目標クリア） |
| スナップショット頻度 | 27/秒 | 217/秒 |
| リング 2048 の保持時間 | 75秒 | **9.4秒**（十分） |
| メモリ | 1.36MB | 1.36MB（不変） |
| 音声側の構成 | — | **一切変更しない**（実証済みの安定性を壊さない） |

**この修正は 2-c の実装前に入れること。**
後回しにすると、同期がズレたときに補正値のせいかブロック粒度のせいか切り分けられなくなる。

### 将来: さらに精度が要るなら

真の割り込み単位（ドライバのタイマーレート）で取りたい場合は submodule の改変が必要になる。
ただし 4.6ms は 60fps の1フレーム（16.7ms）より細かいので、**表示用途では十分**。
PMD 側（98fmplayer）は `opna_timer_mix()` 内で割り込み単位のフックが自然に取れるため、
そちらは最初から真の割り込み精度にできる。

## 12. 段階 2-c / 2-d の実装メモ

- 2048 フレームの transferable とキュー設定は維持し、MUCOM のレンダリング呼び出しだけを 256 フレーム×8回へ分割する。各呼び出し直後に `renderFrame` を256進めてスナップショットを取る。
- ワークレットは実際にキューから出力したフレームだけ `playFrame` へ加算する。起動時の underflow 無音を楽曲時間へ含めないため、定常時は `renderFrame - playFrame` がキュー残量と対応する。
- 10量子ごとに量子末尾に対応する `{playFrame, contextTime}` を送り、メイン側は `AudioContext.currentTime` で補間する。遅延値は `outputLatency`、`baseLatency`、0 の順で選ぶ。
- 表示側は保持中の論理インデックス範囲だけを二分探索し、範囲外の `audibleFrame` は最古／最新へクランプする。バックグラウンド復帰時も最新のクロック推定から直接選び直す。
- UI の「同期較正」は -200〜+200ms、初期値0ms。「同期表示」を外すと比較用にリング最新値を表示する。

## 13. PMD WebAssembly 実装結果

- `pmdweb` は 98fmplayer の `libopna`、PMD/FMPドライバ、PPZ8、共通ファイルローダを直接参照し、フロントエンドとリズムROMローダを含めない。
- `opna_timer_set_int_callback()` へ pmdweb 側のラッパを設定し、ドライバ割り込み直後に `opna.generated_frames` と21トラックの状態を採取する。同一sampleでTimer A/Bが発火した場合は同じframeの最終状態へ統合する。
- PMDのframeは64フレーム格子（55467Hzで約1.154ms）。テスト曲3秒のNodeレンダリングでは349件が厳密増加し、音声は非ゼロ、16本の使用トラックで状態変化を確認した。
- int32フィールド順は `playing, info, ticks, ticks_left, key, actual_key, tonenum, volume, gate, detune, status[0..8], fmslotmask[0..3], ppz8_ch, ssg_tone, ssg_noise`（26語）。
- リズムROM未設定時は libopna のnull波形チェックによりリズムだけ無音になる。
