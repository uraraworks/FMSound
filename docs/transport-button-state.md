# 再生ボタン(btnPlayPause)まわりの状態整理

2026-08-14、実機報告6件(①〜⑥)を受けて再生ボタン周りの状態管理を整理した記録。
「凝った設計にしない」方針のもと、新しい状態機構は作らず、既存の
`mmlDirty` / `hasCompiled` / `globalThis.{pmd,mucom}AudioState` の3つを
正としたまま、**DOMの更新方法(アイコンの差し替え方)と、それらから導く
派生条件の一本化**だけを行った。PMD(html/pmd-app.js)とMUCOM88
(html/mucom-app.js)は別実装(コンパイラの場所が違う: PMDはJS側、MUCOM88は
wasm側)なので、状態変数自体は別々に持つが、同じ形・同じ考え方に揃えてある。

## 状態の正(単一の情報源)

| 変数 | 保持場所 | 意味 |
|---|---|---|
| `mmlTextarea.value` | DOM(textareaそのもの) | 編集中のMMLソース |
| `mmlDirty` | クロージャ変数 | 直近のコンパイル成功以降、編集されたか |
| `hasCompiled` | クロージャ変数 | 今の内容を一度でもコンパイル成功させたか |
| `globalThis.{pmd,mucom}AudioState.playback` | AudioWorkletが非同期に立てる | 曲がロードされ再生系が生きているか(`hasPlayback`) |
| `globalThis.{pmd,mucom}AudioState.paused` | クロージャ側`setAudioPaused()`が立てる | 一時停止中か |
| `uiMode`(PMDのみ) / `currentUiMode()`(MUCOM) | クロージャ変数 + localStorage | プレイヤー/エディタのどちらの画面か |

ボタンの見た目(アイコン種別・`title`・`.active`・`.dirty`・`disabled`)は
すべてこれらから**都度導出**する。ボタン自身が独自の状態を持つことはない
(=「ボタンが今何のつもりか」を推測する必要がない)。

## 導出ロジック: `needsCompileNow()`

PMD・MUCOM88それぞれの `html/*-app.js` に同名の関数を持つ(考え方が同じなので
名前を揃えたが、モジュールをまたいだ共有はしていない。理由は「凝った設計に
しない」: 2ファイルだけのために抽象化レイヤーを増やすほどではないと判断した)。

```js
// PMD(2026-08-15改訂版。MUCOM88はuiMode/pendingUrlSongの概念が無いぶん単純で、
// 「hasPlayback」の判定だけを持つ相当の実装になっている)。
function needsCompileNow() {
  const hasPlayback = Boolean(globalThis.xxxAudioState?.playback);
  if (hasPlayback) {
    // 既に鳴っている(または一時停止中の)曲があるなら、通常はPause/Resumeのトグル。
    // エディタモードで編集し直された場合だけ再コンパイルする。
    return uiMode === 'editor' && (mmlDirty || !hasCompiled);
  }
  // 曲(pendingUrlSongの未再生バイナリ含む)が無い場合、そちらの再生を優先する
  // (プレイヤーモードの既存挙動: URL/サンプル読み込みの精密なバイト列を
  // テキストの再コンパイルで上書きしない)。
  if (pendingUrlSong && uiMode !== 'editor') return false;
  // 「曲が読み込まれている」と「MMLがある」は別概念: 前者が無いなら後者の有無
  // だけでコンパイル要否を決める(モードを問わない。症状⑦の対処)。
  return mmlTextarea.value.trim().length > 0;
}
```

`updateTransportButtonUI()`(見た目の再計算)と `btnPlayPause` の `click`
ハンドラ(クリック時にどちらの動作をするか)は、**両方ともこの関数の結果だけを
見る**。以前はこの2箇所が別々の条件式(`uiMode === 'editor' && (mmlDirty ||
!hasCompiled)` 等)を持っており、症状⑥(Stop後にPlayが効かない)は
この2つの条件式が食い違っていたために起きていた(表示上は「押せそう」に
見えても、クリックハンドラ側の条件が合わずコンパイル&再生に分岐しなかった、
またはPMDでは表示側の条件がStop後を考慮しておらずボタン自体がdisabledに
なっていた)。

### 症状⑦(2026-08-15): リロードすると再生できなくなる(下書き復元後にPlayが無効)

実機報告: 一度でも使うと下書き(`fmsound-pmd-mml-draft`)が保存され、次回リロード時に
`mmlTextarea.value`へ復元される。しかしPMDは既定がプレイヤーモード(`uiMode !==
'editor'`)で、旧実装の`needsCompileNow()`は**プレイヤーモードでは無条件にfalseを
返していた**(「プレイヤーモードはコンパイル不要、再生専用ボタン」という前提)。
そのため`updateTransportButtonUI()`は「曲が読み込まれている(`hasPlayback`)か」
だけを見る分岐に落ち、下書きが復元されて`mmlTextarea`に中身があっても
`hasPlayback`が偽(何も再生していない)ならPlayボタンは`disabled`のままだった。

原因は「曲が読み込まれている」(`hasPlayback`/`pendingUrlSong`)と「MMLがある」
(`mmlTextarea.value`)を同じ条件式の中で区別せずに扱っていたこと。上のコード例の
とおり、`hasPlayback`が無い場合にかぎり`pendingUrlSong`→`mmlTextarea`の順で
フォールバックするよう分離した。`pendingUrlSong`(URL指定/サンプル読み込みの
未再生バイナリ)を優先する順序は変えていないため、既定サンプルの読み込みや
`?mml=`読み込みの挙動に影響は無い(手元検証・verify_net_url_load.mjs等で確認)。

## 状態を変える経路の一覧

| 経路 | 変える変数 | 備考 |
|---|---|---|
| ページ読み込み(自動保存からの復元) | `mmlTextarea.value` | `mmlDirty`/`hasCompiled`は変えない(=読み込んだだけでは「未コンパイル」表示になる。既存挙動) |
| サンプルリンクをクリック | `mmlTextarea.value`, `mmlDirty=false` | PMD: 症状①の対処でプレイヤーモードでも編集欄を静かに更新するようにした(コンパイルはしない)。エディタモードでは従来通り即コンパイル。MUCOM88: モードに関係なく常に読み込んで即コンパイル(元からの挙動) |
| 「曲を開く」/ドラッグ&ドロップ(バイナリ) | 再生状態のみ(`playBytes`) | エディタのMMLソースには触れない(コンパイラを経由しないバイナリ再生のため) |
| MML欄への入力 | `mmlDirty=true`(`markMmlDirty()`) | 一度trueになったら次の成功コンパイルまでfalseに戻らない |
| Clear MML | `mmlTextarea.value=''`, `input`イベント経由で`mmlDirty=true` | 症状②: 表示上の「●」は`mmlDirty && 中身が空でない`のときだけ出すので、Clear直後は出ない |
| 再生ボタン(`needsCompileNow()`がtrue) | `compileAndPlay()`実行 → 成功時`mmlDirty=false`, `hasCompiled=true` | |
| 再生ボタン(`needsCompileNow()`がfalse) | `AudioContext.suspend()/resume()` + `paused` | 一時停止/再開のトグルのみ。コンパイルはしない |
| 停止ボタン / エディタOFF→ON遷移時の自動停止(課題E) | `Module.stopMusic()` → 非同期に`playback`が消える | `hasPlayback`がfalseになった時点で`needsCompileNow()`がtrueに戻り、次のPlayクリックは自動的に再コンパイル経由になる(症状⑥の対処) |
| モード切替ボタン(プレイヤー⇔エディタ) | `uiMode`, localStorage | PMDのみ`needsCompileNow()`の判定に影響(プレイヤーモードでは常にfalse) |

## 症状③⑥の共通の根(ボタンDOMの作り直し)

`updateTransportButtonUI()` は再生中、`requestAnimationFrame`ループ
(`updateChannelStatus()`)から**毎フレーム(約60回/秒)**呼ばれる。以前は
呼ばれるたびに無条件で

```js
btnPlayPause.replaceChildren(svgIcon(...));
```

を実行しており、アイコンの種類が変わっていなくても**新しいSVG要素に
差し替えていた**。実測(`isConnected`で確認): ボタンの子要素(アイコン)は
毎フレーム別ノードに入れ替わっており、これは体感で言うと「ボタンの中身が
常に作り直されている」状態だった。

利用者の実クリックはブラウザ内部で
`mousedown`(押した瞬間の対象要素を記録)→`mouseup`(離した瞬間の対象要素を
確認)→両者が同じ要素/祖先関係にあれば`click`を発火、という手順を踏む。
押した瞬間の対象がアイコンの`<svg>`(=ボタンの見た目のほぼ全面)だった場合、
mousedownからmouseupまでの間(人間の操作では十数ms〜)に一度でも
`replaceChildren()`が挟まると、押した瞬間の要素はDOMから外れてしまい、
ブラウザは`click`を発火できない。これが「実クリックでは無反応、しかし
`⌘/Ctrl+Enter`(`btnPlayPause.click()`を直接呼ぶ経路)なら効く」の正体
(症状③)。⑥も同じ経路で同時に踏んでいた。

対処: アイコンの種別(`'play'` / `'pause'`)を`lastPlayIconKey`に記録し、
**前回と変わったときだけ**`replaceChildren()`する。`title`・`aria-label`・
`classList`の更新は元々冪等な操作(同じ値を再設定しても新規ノードを
作らない)なので変更していない。

## 検証方法についての注記

`element.click()` はブラウザのmousedown/mouseup経由のヒットテストを
経由しないため、症状③⑥のようなDOM差し替えバグを再現しない。検証は
`dispatchEvent`ベースの合成クリック、または本ツール環境の
`left_click_drag`(同一座標への「押して少し待ってから離す」操作、
複数のrAFフレームを挟む)で行う必要がある。詳細は作業ログ(コミット
メッセージ)参照。
