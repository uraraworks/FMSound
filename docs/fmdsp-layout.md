# FMDSP 画面仕様書（Web再実装用）

## 0. 正典の所在

**この文書は `fmdsp/fmdsp-pacc.c`（2371行）を正典として記述する。** `fmdsp/fmdsp.c`
（旧・ソフトウェアVRAM描画版）は参考・旧実装として扱い、両者が食い違う箇所は明示的に区別する。

根拠（すべて確認済み）:

- `gtk/Makefile.am:15-19` の `FMDSP_SRC` に列挙されているのは `fmdsp-pacc.c` /
  `font_rom.c` / `font_fmdsp_small.c` / `fmdsp_platform_unix.c` / `pacc/pacc-gl.c` の
  5本のみ。**`fmdsp/fmdsp.c` はビルド対象に含まれていない。**
- `gtk/main.c:324` の `fmdsp_update()`（`fmdsp.c` 側API）呼び出しはコメントアウト済み。
- `fmdsp_vram_init()`（`fmdsp.c`側の初期化関数）は宣言・定義以外に呼び出し元が無いデッドコード。
- `fmdsp.c:486` の `work->comment[i]` 直接参照は、現行の `fmdriver.h:109` API
  （`get_comment()` コールバック方式）と食い違っている。`fmdriver_work` 構造体に
  `comment` メンバの定義は無い（本改訂で `fmdsp-pacc.c` を読み再確認済み。§4参照）。
  これは fmdsp.c が API 更新に追随できていない痕跡であり、**旧実装であることの直接証拠**。

対象: `upstream/98fmplayer/fmdsp/fmdsp-pacc.c` / `fmdsp-pacc.h` / `fmdsp_sprites.h`、
`upstream/98fmplayer/fmdriver/fmdriver.h`。`fmdsp.c`/`fmdsp.h` は比較対象としてのみ参照する。
座標・定数はすべて `file:line` で出典を示す。読み取れなかった箇所は「未確認」と明記する。

## 1. 画面全体

- 論理解像度: **640×400**。`PC98_W = 640`, `PC98_H = 400`（`fmdsp-pacc.h:20-21`）。
  fmdsp.h側の同名定数（`fmdsp.h:17-19`）と値は一致。
- 色数: パレットインデックス方式、10色。`FMDSP_PALETTE_COLORS = 10`（`fmdsp-pacc.h:15`）。
  プリセットパレット数 `PALETTE_NUM = 10`（`fmdsp_sprites.h:192-194`、fmdsp.c/pacc共有）。
  `fmdsp_pacc_alloc()` で初期値 `s_palettes[0]` を `target_palette` に設定
  （`fmdsp-pacc.c:1114`）。
- **描画方式がfmdsp.cと根本的に異なる**: fmdsp.cは単一の640×400 VRAMバイト配列に
  直接パレット番号を書き込む方式だったが、pacc版はテクスチャアトラス＋GPU頂点/矩形
  バッファ（`struct pacc_buf`）を使い、`fp->pacc.draw()` でバッファ単位にGPU側へ矩形転送
  する方式（`fmdsp-pacc.c:109-200`の`struct fmdsp_pacc`フィールド一覧、
  `fmdsp-pacc.c:2063-2130`の描画呼び出し列）。1ピクセル単位の直接書き込みは行わない。
  パレットフェード自体は**同一アルゴリズム**（後述）。
- 原点: 左上(0,0)、x右・y下方向が正。`fp->pacc.buf_rect(pc, buf, x, y, w, h)` 系API
  の引数順から確認（例: `fmdsp-pacc.c:1122-1124`）。

### 表示モード（fmdsp.cとの最大の構造差）

fmdsp.cは `enum FMDSP_DISPSTYLE`（ORIGINAL/DEFAULT/OPN/PPZ8/13の5択、単一軸）だったが、
**pacc版はこの5択を廃止し、左パネルと右パネルを独立した2軸で選ぶ方式に置き換えている**:

`enum fmdsp_left_mode`（`fmdsp-pacc.h:26-32`）: パート行（トラック一覧）側のレイアウト。

| 値 | 内容 | 対応する旧fmdsp.c dispstyle |
|---|---|---|
| `FMDSP_LEFT_MODE_OPNA` | FM1-6, SSG1-3, ADPCM (10行) | DEFAULT/ORIGINAL相当 |
| `FMDSP_LEFT_MODE_OPN` | FM1,2,3,FMEX1-3,SSG1-3,ADPCM (10行) | OPN相当 |
| `FMDSP_LEFT_MODE_13` | FM1-6+EX1-3+SSG1-3+ADPCM (13行) | 13相当 |
| `FMDSP_LEFT_MODE_PPZ8` | PPZ8 1-8, ADPCM (10行) | PPZ8相当 |

`enum fmdsp_right_mode`（`fmdsp-pacc.h:34-38`）: 画面右側(x≥320)パネルの内容。

| 值 | 内容 |
|---|---|
| `FMDSP_RIGHT_MODE_DEFAULT` | ロゴ・時刻・SPECTRUM・LEVELメーター等のフル装飾（旧ORIGINAL相当） |
| `FMDSP_RIGHT_MODE_TRACK_INFO` | 左パネルと同じトラック集合のFM/SSG/ADPCM/PPZ8詳細レジスタ表示 |
| `FMDSP_RIGHT_MODE_PPZ8` | PPZ8 1-8のトラック行を右側(x=320)に追加表示 |

両軸は独立に切替可能（`fmdsp_pacc_set_left_mode()`/`fmdsp_pacc_set_right_mode()`、
`fmdsp-pacc.c:2158-2166`、いずれも`mode_changed=true`を立てるのみ）。
例えば「左=13トラック、右=DEFAULT(ロゴ+メーター)」のような、fmdsp.cの5択では
表現できない組み合わせが可能。**この2軸化がfmdsp.cからの最大の設計変更点。**

## 2. 領域の一覧

`FMDSP_RIGHT_MODE_DEFAULT`（最も装飾の多いモード、旧ORIGINAL相当）を基準に列挙。
x,yは左上原点。出典はすべて`fmdsp-pacc.c`。fmdsp_sprites.hの座標定数(`TIME_X`等)は
**fmdsp.cと共用**しており値は一致することを本改訂で実際にコードを追って確認した
（例: `TIME_X+NUM_W*0`等の式が`fmdsp-pacc.c:1517`と旧`fmdsp.c:823`付近で同一）。

| 領域名 | x,y | w,h | 表示内容 | 出典(fmdsp-pacc.c) |
|---|---|---|---|---|
| ロゴ(FM/DS/P) | (LOGO_FM_X,LOGO_Y) | LOGO_W,LOGO_H | ロゴスプライト、`init_default`で描画（rmode=DEFAULT時のみ） | `1122-1124`; `LOGO_W = LOGO_FM_W+2+LOGO_DS_W+2+LOGO_P_W`(`fmdsp-pacc.c:23`、pacc内でローカル再定義) |
| タイトルテキスト"MUS/IC/F/ILE/SELECTOR/&/STATUS/D/ISPLAY" | TOP_MUS_X等 | - | 個別文字列に分割して描画 | `1125-1160` |
| バージョン表示 | VER_0/1/2_X, TOP_MUSIC_Y | - | `FMPLAYER_VERSION_0/1/2` | `1165-1176` |
| DRIVERラベル+三角 | DRIVER_TEXT_X等 | - | "DR"+"IVER"+三角インジケータ | `1182-1191` |
| CURL(左右装飾) | CURL_LEFT/RIGHT_X, CURL_Y | CURL_W,CURL_H | 装飾スプライト | `1192-1199` |
| PASSED TIME (mm:ss.cc) | TIME_X, TIME_Y | NUM_W*8桁 | `opna->generated_frames`から算出、コロン点滅(sec%2で切替) | `update_default`内`1502-1539` |
| CLOCK COUNT | TIME_X, CLOCK_Y | 8桁 | `work->timerb_cnt` | `1541-1550` |
| TIMER B CYCLE | TIME_X, TIMERB_Y | 3桁 | `work->timerb` | `1552-1561` |
| LOOP COUNT | TIME_X, LOOPCNT_Y | 4桁 | `work->loop_cnt` | `1563-1572` |
| ループ進捗バー | (352,70) | 144(内72*2),4 | `timerb_cnt_loop/loop_timerb_cnt`比率、`work->playing`時のみマーカー表示 | `1595-1609` |
| VOLUME DOWN ラベル | TIME_TEXT_X, VOLDOWN_Y | - | ラベルのみ | `1272-1277`; 値の描画コードは**fmdsp.c同様に見当たらない(未解決のまま)** |
| PGM NUMBER ラベル | TIME_TEXT_X, PGMNUM_Y | - | ラベルのみ、値描画は同様に**未確認** | `1280-1285` |
| CPU POWER COUNT | CPU_NUM_X, CPU_NUM_Y | 3桁 | `fp->cpuusage`(30フレーム毎に`fmdsp_cpu_usage()`で更新) | `1573-1583`, 更新元`2131-2133` |
| FRAMES PER SECOND | FPS_NUM_X, CPU_NUM_Y | 3桁 | `fp->fps`(30フレーム毎`fmdsp_fps_30()`) | `1584-1594`, `2131-2133` |
| CIRCLE(円形アニメ) | CIRCLE_X, CIRCLE_Y | CIRCLE_W,CIRCLE_H | `timerb_cnt/8%8`で8方向切替、一時停止中は`framecnt%32>=16`で消灯コマ(clock=8) | `1611-1623` |
| SPECTRUM(FFT) | SPECTRUM_X, SPECTRUM_Y基準 | 70本×4px, 高さ最大64 | `fft_calc()`結果、ピーク保持(fftcnt)+減衰(fftdropdiv, divtabは後述) | `1625-1659` |
| SPECTRUMラベル群・軸目盛 | SPECTRUM_X相対 | - | "SPECTRUM ANALYzER"/"FREQ"/250,500,1k,2k,4k、チェッカー柄区切り線 | `1368-1434`(`init_default`内、固定描画) |
| LEVELメーター(19ch) | LEVEL_X, LEVEL_Y | LEVEL_W*19, 64 | dB→32段変換(式は後述)、ピーク保持(levelcnt)+減衰(leveldropdiv) | `1660-1805` |
| LEVELラベル(ON/PAN/PROG/KEY) | LEVEL_TEXT_X | - | 行見出し | `1442-1457`(init_default) |
| LEVEL列見出し(FM1/FM4/SSG/RHY/ADP/PPZ) | LEVEL_X+LEVEL_W*n | - | `1458-1481`(init_default) |
| PANPOT表示(19ch) | LEVEL_X+LEVEL_W*c-1, PANPOT_Y | PANPOT_W,PANPOT_H | 5方向+OFF、マスク時は別スプライト(`buf_panpot_5_d`) | `1765-1769` |
| PROG(音色番号、RHYTHM列は打楽器B/S/T表示に置換) | LEVEL_X+LEVEL_W*c, LEVEL_PROG_Y | 3桁 or 3文字 | c==9(RHYTHM)のみ`drum.drums[0..2].playing`のB/S/T表示 | `1770-1783` |
| KEY(現在鍵盤番号、RHYTHMはH/T/R表示) | LEVEL_X+LEVEL_W*c, LEVEL_KEY_Y | 3桁/3文字/"---" | c==9のみ`drum.drums[3..5].playing` | `1784-1804` |
| PLAY/STOP/PAUSE/FADE/FF/REW/FLOPPY インジケータ | PLAY_X等(fmdsp_sprites.h由来) | 各PLAY_W等 | **rmode/lmodeに関わらず常に毎フレーム描画**(fmdsp.cは`style==ORIGINAL`限定だった、後述) | `2121-2130` |
| PLAYING/曲名バー | (0,PLAYING_Y)〜 | PLAYING_W,H + 可変 | "PLAYING"ラベル+"MUSIC FILE"文字列+曲ファイル名 | `mode_update`内`1843-1858`,`1882-1887` |
| PCMタイプ名バー(PCM種類数だけ可変本数、右詰め) | FILEBAR_PCMBAR_X基準、種類数ぶんxoff | FILEBAR_PCM_W刻み | `work->pcmtype[i]`個数ぶん動的生成、`pcmerror[i]`時は`buf_fontm_3`(赤系)に切替 | `1862-1889` |
| コメント欄(可変: 3行固定 or PMDメモ+スクロール) | (0,CHECKER_Y=335) | PC98_W, CHECKER_H=65 | §4参照。fmdsp.cから内容・実装とも刷新 | `2281-2347`; `CHECKER_H/CHECKER_Y` `fmdsp-pacc.h:22-24` |
| パート行(トラック行、10行 or 13行) | (x=0〜, y=TRACK_H*i) | 640(左320,右320), TRACK_H(32)/TRACK_H_S(24) | §3参照 | `init_track_10/13`, `update_track_10/13` |
| トラック右側の音源詳細パネル(rmode=TRACK_INFO時) | x=320, y=TRACK_H*it+2起点 | 320×TRACK_H | FM/SSG/ADPCM/PPZ8のOPNAレジスタ直読み | `update_track_info_10/13`, `580-768` |

## 3. パート行の内訳

- 標準10トラック表示: 1行 = **32ドット** (`TRACK_H=32`, `fmdsp_sprites.h:2`、fmdsp.cと共有)
- 13トラック(`FMDSP_LEFT_MODE_13`)表示: 1行 = **24ドット** (`TRACK_H_S=24`,
  `fmdsp_sprites.h:3`)、鍵盤高さも `KEY_H_S=KEY_H-8=9` (`fmdsp_sprites.h:29`)

### トラック数とテーブル対応

`FMDRIVER_TRACK_NUM=20`のトラックスロット。`track_type_table[FMDRIVER_TRACK_NUM]`
（`fmdsp-pacc.c:26-51`）でスロット種別と表示用連番を定義。**この配列はfmdsp.c側の
`track_type_table`(`fmdsp.c:125-150`)とは別に独立定義されているが、内容(FM1〜9スロット、
SSG1-3、ADPCM、PPZ8_1-8の順・番号付け)は一致することを確認した。** つまり2ファイルは
このテーブルを共用しておらず、それぞれが独自に同じ値を保持している。

lmodeごとの表示テーブル対応（旧`track_disp_table_default`は`track_disp_table_opna`に改名）:

| lmode | テーブル | 内容 |
|---|---|---|
| `FMDSP_LEFT_MODE_OPNA` | `track_disp_table_opna`(`fmdsp-pacc.c:53-65`) | FM1-6,SSG1-3,ADPCM (10行) |
| `FMDSP_LEFT_MODE_OPN` | `track_disp_table_opn`(`fmdsp-pacc.c:66-78`) | FM1,2,3,FM3EX1-3,SSG1-3,ADPCM (10行) |
| `FMDSP_LEFT_MODE_PPZ8` | `track_disp_table_ppz8`(`fmdsp-pacc.c:79-90`) | PPZ8_1-8,ADPCM (10行) |
| `FMDSP_LEFT_MODE_13` | `track_disp_table_13`(`fmdsp-pacc.c:91-106`) | FM1-6+EX1-3(9)+SSG1-3(3)+ADPCM(1)=13行 |

`FMDSP_RIGHT_MODE_PPZ8`選択時は上記とは別に`track_disp_table_ppz8`をx=320側にも
描画できる(`init_track_10(fp, track_disp_table_ppz8, 320)`, `mode_update`内`1913-1915`)。

### 1行内のレイアウト(y=0起点、xは絶対座標)

fmdsp_sprites.hの`TDETAIL_*`定数群を使用しており、値・意味ともfmdsp.cと一致することを確認。

| 要素 | x | 出典(fmdsp-pacc.c) |
|---|---|---|
| トラック番号(2桁数字) | NUM_X, NUM_X+NUM_W | `update_track_without_key`内`472-485` |
| トラック情報1/2行目(EFF/EX/PPZ8/PDZF/ノイズ周波数/FM3EXスロット) | TINFO_X | `486-521` |
| ラベル行(TRACK./KN:/TN:/Vl:/GT:/DT:/M:) | TDETAIL_X等 | `init_track_without_key`内`412-438` |
| 鍵盤(ピアノロール, 8オクターブ) | KEY_X〜, KEY_LEFT_X | `init_track_10/13`, `update_track_10/13` |
| ゲージバー(ノートゲート経過) | BAR_L_X, BAR_X〜 | `561-577` |
| KN(現在キー文字列 or "S"(停止)/"R"(休符)) | TDETAIL_KN_V_X | `522-541`; **fmdsp.cと同じ意味だが停止時"S"表示ロジックがここに明示** |
| TN/Vl/GT/DT/M | TDETAIL_{TN,VL,GT,DT,M}_V_X | `542-556` |
| DTの符号アイコン | TDETAIL_DT_S_X | `557-563` |

`update_track_without_key`(`fmdsp-pacc.c:467-578`)は毎フレーム呼ばれ、上記すべてを
stream系バッファ(`buf_font_1_d`等、§5参照)に描き直す。

FMオペレータパラメータ詳細(`update_track_info_fm`, `fmdsp-pacc.c:580-632`):
- 4スロット(si=0..3)を6ドット間隔で縦に並べる(`y+2+si*6`)。TLバー(`buf_vertical_3`,幅128)
  とTL+EGバー(`buf_vertical_2`)を重ね描き、現在TL位置に1px幅の白マーカー(`buf_vertical_7`)。
- ENV状態文字列(ATT/DEC/SUS/REL)、EG値(16進3桁)、fnum(16進4桁、FM3のみスロット毎+チャンネル共通の2種)。
- SSG(`update_track_info_ssg`, `634-645`): レベルバー(envleveld*2)+周期(16進3桁)。
- ADPCM(`update_track_info_adpcm`, `647-659`): "VOL DELTA START PTR END"見出し+値。
- PPZ8(`update_track_info_ppz8`, `661-685`): "PAN VOL FREQ PTR END LOOPS LOOPE"+値、
  PAN文字列は`L`/`R`+符号数値または`--`。

## 4. データ源の対応表(fmdsp.cからの変更点を中心に記載)

| 画面表示 | データ源 | 備考 |
|---|---|---|
| コメント欄(曲名・作曲者・編曲者・メモ) | `work->get_comment(work, line)` コールバック(`fmdriver.h:109`) | **fmdsp.cの`work->comment[i]`直接参照(`fmdsp.c:486`)は現行APIと不整合であることを確認。pacc版はget_comment()のみを使用しており、この経路の食い違いはfmdsp.cのバグ・追随漏れと確定した(旧文書の「未確認」項目を解決)。** |
| コメント欄の表示形式切替 | `work->comment_mode_pmd`(bool, `fmdriver.h:94-96`) | false=3行コメント固定表示、true=PMDメモモード(タイトル/作曲者/編曲者/複数行メモをスクロール表示)。§にて詳述 |
| その他(トラック番号・KN/TN/Vl/GT/DT/M・ticks・playing・SSG/FM3EX/PPZ8種別・マスク状態・FMオペレータTL/EG/fnum・SSGレベル周期・ADPCM/PPZ8詳細・ファイル名/PCM名/エラー・タイマー各種・再生状態・CPU/FPS・FFT・LEVEL・PANPOT) | `fmdriver_track_status`, `struct opna`, `struct ppz8`, `fmdriver_work`他 | **データ源・フィールド名はfmdsp.cと同一であることを確認。式もほぼ同一**(例: LEVELのdB変換式は`20*log10(level/32768)`を48dBレンジ・32段で正規化、`fmdsp-pacc.c:1732-1734`、fmdsp.c側の同等式と一致) |

## 5. コメント欄の詳細(fmdsp.cから全面刷新された領域)

fmdsp.cは曲ロード時に`work->comment[0..2]`を一度だけ描画するだけの単純な3行表示だったが、
pacc版は`work->comment_mode_pmd`で2つの表示モードを持ち、うち片方はスクロール可能。

- 実描画は`fmdsp_pacc_comment_draw()`(`fmdsp-pacc.c:2281-2347`)。結果は
  `fp->comment_tex_buf`(`PC98_W*CHECKER_H`バイト、`fmdsp-pacc.c:179`)に描かれ、
  次の`fmdsp_pacc_render()`呼び出し時に`comment_tex_buf_changed`フラグを見て
  `tex_comment`テクスチャへアップロードされる(`2281-2347`で毎回セット、
  `1923-1927`でアップロード)。**この関数自体は毎フレーム呼ばれない**(後述§6)。
- `comment_mode_pmd == false`(3行コメントモード): `get_comment(work,0..2)`の3行を
  `(0, COMMENT_H*i+5)`に直接描画するのみ。タイトルラベルもスクロール三角も無し
  (`comment_prev_avail`/`next_avail`を強制false、`fmdsp-pacc.c:2337-2345`)。
- `comment_mode_pmd == true`(PMDメモモード): `comment_offset`(int)を起点に3行の
  スクロール窓を表示。
  - 窓内0行目が`comment_offset==0`のときのみ"MUSIC TITLE"ラベル+`get_comment(work,0)`
    (タイトル)を表示(`2290-2306`)。
  - 窓内1行目が`n==1`のとき、"COMPOSER"(x=24)+`get_comment(work,1)`と
    "ARRANGER"(x=312)+`get_comment(work,2)`を左右に並べて表示(`2307-2325`)。
  - それ以外の行は"MEMO"ラベル+`get_comment(work, n+1)`(メモ本文、`fmdriver.h:107`の
    `line 3: #Memo 1st line`以降に対応、n+1でオフセット)(`2326-2335`)。
  - `comment_prev_avail = (comment_offset != 0)`、
    `comment_next_avail = get_comment(work, comment_offset+2+1+1)`の存在確認
   (窓の1行先を覗いて次があるかを判定)(`2287-2289`)。
  - 各行冒頭に小さな三角形マーカー(`draw_tri()`, `fmdsp-pacc.c:2273-2279`)をラベルの
    右に描画。
  - 文字描画は`fp->font16`(外部から`fmdsp_pacc_set_font16()`でセットする16px相当フォント)
    を使用しており、ラベル文字列自体は組み込み`font_fmdsp_small`。
- API:
  - `fmdsp_pacc_comment_reset(fp)`: `comment_offset=0`にして再描画。曲ロード時に呼ぶ
    想定(fmdsp.cの`fmdsp_vram_init`一回描画に相当する呼び出しタイミングだが、
    呼び出し元はfmdsp-pacc.c内には無く**未確認**、GTKフロントエンド側と推測)。
  - `fmdsp_pacc_comment_scroll(fp, down)`: `comment_mode_pmd`でない場合は無視。
    `down==true`で次行があれば`comment_offset++`、`false`で`comment_offset>0`なら`--`。
    再描画も同時に行う。**fmdsp.cには存在しない新機能。**
  - 三角インジケータの点滅表示(`comment_prev_avail`/`next_avail`があるときのみ)は
    `fmdsp_pacc_render()`側で`framecnt%32<16`の間だけ描く(`2047-2062`)。

## 6. 更新頻度・ダーティ管理(pacc基準で刷新)

fmdsp.cは単一VRAM配列への都度上書きだったが、pacc版は**GPUバッファの2階層(static/stream)
＋モード変更フラグ**による構造化されたダーティ管理を持つ。

### バッファの2分類

`fmdsp_pacc_init_buf()`(`fmdsp-pacc.c:985-1086`)で生成される`struct pacc_buf`は
`pacc_buf_mode_static`と`pacc_buf_mode_stream`の2種:

- **static系**(`buf_font_1`,`buf_font_2`,`buf_font_7`,`buf_key_left/right/bg`,
  `buf_logo`,`buf_ver`,`buf_text`,`buf_tri`,`buf_curl_left/right`,
  `buf_play/stop/pause/fade/ff/rew/floppy`,`buf_comment`,`buf_playing`等):
  **モード変更時(`mode_changed==true`)のみ**`mode_update()`(`1808-1919`)内で
  `buf_clear()`→再構築される。ラベル文字列・アイコン背景・鍵盤地板など「値が変わらない」
  要素が該当。fmdsp.cの`style_updated`フラグによる全消去+再初期化に相当する仕組みだが、
  対象がVRAM全体ではなくバッファ単位に細分化されている。
- **stream系**(`buf_font_1_d/2_d`,`buf_num`,`buf_dt_sign`,`buf_solid_*_d`,
  `buf_vertical_2/3/7`,`buf_horizontal_2_d/7_d`,`buf_circle`,`buf_panpot_1_d/5_d`,
  `buf_comment_tri_d`,`buf_key_mask`,`buf_key_mask_sub`等):
  **`fmdsp_pacc_render()`の冒頭で毎回無条件に`buf_clear()`され
  (`fmdsp-pacc.c:1953-1970`)、その後同一フレーム内で全内容を描き直す。**
  数字・トラック詳細・鍵盤ハイライト・レベルメーター・FFT・パンポット等、
  「毎フレーム変わりうる」要素はすべてここに属する。fmdsp.cの「対象領域を毎フレーム
  全部上書き」という力技方式と実質的に同じ結論だが、pacc版では
  static/streamの分離によって「本当に変わる部分」だけがGPU側に毎フレーム送られる
  （静的な背景・ラベルはGPUメモリに保持されたまま再送されない）。

### `fmdsp_pacc_render()`(`fmdsp-pacc.c:1921-2136`)内の処理順序

1. `comment_tex_buf_changed`なら`tex_comment`へアップロード(`1923-1927`) —
   **comment_reset/scroll呼び出し時のみtrueになる。曲ロード・スクロール操作以外では
   再描画されない**(fmdsp.cの「曲ロード時1回のみ」という設計思想を踏襲しつつ、
   スクロール操作という新トリガーが追加された)。
2. パレットフェード: `curr_palette`を`target_palette`へ最大`FADEDELTA=16`/フレームで
   線形補間(`1928-1947`)。**アルゴリズムはfmdsp.cの`fmdsp_palette_fade`
   (`fmdsp.c:504-523`)と同一(差分量16も一致)。**
3. `mode_changed`なら`mode_update()`でstatic系バッファを再構築(`1949-1952`)。
4. stream系バッファを全クリア(`1953-1970`)。
5. `opna_get_mask()`/`ppz8_get_mask()`からミュート状態を再計算(`1971-2000`)。
6. lmode/rmodeに応じて`update_track_10/13`・`update_default`・
   `update_track_info_10/13`を呼び、stream系バッファへ毎フレーム描き直す(`2001-2046`)。
7. コメントのスクロール三角を`framecnt%32<16`の間だけ描画(`2047-2062`)。
8. パレット色ごとにバッファをGPUへdraw(`2063-2112`)。
9. **PLAY/STOP/PAUSE/FADE/FF/REW/FLOPPYインジケータをlmode/rmodeに関係なく無条件に
   毎フレーム描画(`2113-2130`)。fmdsp.cではこれらは`style==FMDSP_DISPSTYLE_ORIGINAL`
   限定だった(`fmdsp.c:808`)。pacc版ではこの条件分岐が消えており、常時表示に変更されている。**
10. 30フレームに1回`fmdsp_cpu_usage()`/`fmdsp_fps_30()`でCPU/FPS値を更新(`2131-2134`)。
11. `framecnt++`(`2135`)。

### 未解決のまま残った項目

- VOLUME DOWN / PGM NUMBER の**値**を描画するコードは`fmdsp-pacc.c`内にも見当たらない
  (ラベルのみ`init_default`で描画、`1272-1285`)。fmdsp.c同様に未確認のまま。
- `fmdsp_pacc_comment_reset()`の呼び出し元（曲ロード時にどこから呼ばれるか）は
  `fmdsp-pacc.c`内には存在せず、GTKフロントエンド側(`gtk/main.c`等、未読)と推測されるが未確認。
- `fp->font16`(コメント欄PMDモードで使う16pxフォント)が`fmdsp_pacc_set_font16()`で
  どこから何を渡されるか(フォントデータの実体)は未確認。

## 7. スプライト一覧(pacc版での実使用を確認したもの)

`fmdsp_pacc_init_tex()`(`fmdsp-pacc.c:799-978`)での`memcpy`元を実際に確認した結果、
以下は**fmdsp.cと共通のスプライト配列がそのまま再利用されている**ことを確認:
`s_key_left/right/bg/mask`, `s_num`, `s_num_bar`, `s_num_colon`, `s_dt_sign`, `s_ver`,
`s_text`, `s_filebar_tri`, `s_curl_left/right`, `s_play/stop/pause/fade/ff/rew`,
`s_floppy`, `s_panpot`(6種, `922`), `s_comment_tri`(2種, `924-925`), `s_playing`,
`s_logo_fm/ds/p`, `s_circle`(9方向, `964-977`)。

pacc固有の追加テクスチャ生成(スプライトデータそのものではなく、フォントからの
動的テクスチャ化):
- `tex_font`/`tex_fontm`: `font_fmdsp_small`/`font_fmdsp_medium`をビットマップ→
  1bppテクスチャに変換(`tex_from_font()`, `fmdsp-pacc.c:202-218`)。fmdsp.c側に
  この変換ロジックがあるかは未確認(比較未実施)。
- `tex_checker`: 2x2の市松模様をコード上で直接生成(`862-867`)、コメント欄背景に使用。

## 8. pacc固有の定数・仕組み(fmdsp.cに対応物が無い、または見出せなかったもの)

- `KEY_S_OFF_Y = 4`(`fmdsp-pacc.c:22`、`fmdsp_sprites.h`ではなくfmdsp-pacc.c内の
  ローカルenumで定義): 13トラックモード(`FMDSP_LEFT_MODE_13`)の鍵盤描画でのみ使用
  (`init_track_13`の`446-450`、`update_track_13`の`722-736`)。`KEY_H_S=9`は
  `KEY_H=17`より短いため、鍵盤マスクテクスチャ(高さ`KEY_H*12`で確保、`tex_key_mask`,
  `810-811`)から縦4pxオフセットした位置を切り出して使う仕組み。fmdsp.c側は
  `vramblit_key()`に同等の第2引数(8 or 6、色選択用)を渡しているだけで(`fmdsp.c:801-806`
  付近)、縦方向オフセットに相当する処理は無い —
  **これはpacc版のテクスチャアトラス方式に固有の実装都合であり、fmdsp.cには意味的な
  対応物が無いと判断した。**
- `FADEDELTA = 16`(`fmdsp-pacc.c:18`): fmdsp.cの同種の定数(ハードコード値16、
  `fmdsp.c:504-523`内)と値は一致するが、pacc側は名前付き定数として明示されている。
- `mode_changed`/`fmdsp_pacc_set_left_mode`/`set_right_mode`/`update_file`
  (`fmdsp-pacc.c:2158-2170`)によるモード管理API群: fmdsp.cの`fmdsp_dispstyle_set()`
  (`fmdsp.c:1211-1216`)を2軸化した上位互換だが、API形状自体は完全に別物。
- `comment_offset`/`comment_prev_avail`/`comment_next_avail`とスクロールAPI: §5参照、
  fmdsp.cに対応物なし。

## 9. Web再実装で問題になりそうな点(pacc基準に更新)

1. **static/streamの2階層ダーティ管理の再現**: 単純な「毎フレーム全部描き直す」
   実装でも動作はするが、pacc版の設計意図(背景・ラベルはモード変更時のみ再構築、
   数値・動的部分のみ毎フレーム再構築)を汲むなら、Canvas実装でも「静的レイヤー
   (mode変更時のみ再描画、オフスクリーンCanvasに保持)」と「動的レイヤー(毎フレーム)」
   を分離した方が実装の見通しが良い。
2. **lmode×rmodeの2軸モデル**: fmdsp.cの5値dispstyleをそのまま移植するのではなく、
   `fmdsp_left_mode`(4値)×`fmdsp_right_mode`(3値)の直交構造として設計する必要がある。
   状態は最大12通りだが、実際に意味を持つ組み合わせ(例:
   lmode=PPZ8 かつ rmode=PPZ8は右にもPPZ8を出す形で許容されている)を精査すること。
3. **PMDメモモードのスクロールUI**: `comment_mode_pmd`時のタイトル/作曲者/編曲者/
   複数行メモの表示切替とスクロール操作(`comment_offset`)は新規に設計が要る
   インタラクティブ要素。3行固定モードとは表示ロジックが全く別なので、
   共通コンポーネント化する場合はモード切替の境界を明確にすること。
4. **PLAY/STOP等アイコンが常時表示に変更された**: fmdsp.c基準で「ORIGINALスタイル限定」
   と実装すると、pacc版の実際の挙動(常時表示)と食い違う。Web版でどちらの挙動を
   採用するかは要判断(本書はpacc=現行仕様として常時表示を正とする)。
5. **SJIS/CP932混在文字列描画+ANSIエスケープシーケンス読み飛ばし**
   (`font_putline`, `fmdsp-pacc.c:2186-2267`): 半角/全角判定・タブ展開に加え、
   `ESC`/`CSI`/`SYNC`のエスケープシーケンス状態機械を持つ(`2199-2229`)。
   `fmdriver.h:99`のコメント"may contain ANSI escape sequences"に対応する実装が
   pacc側には確認できた。fmdsp.c側の同等関数(`fmdsp_putline`,`fmdsp.c:74-123`)に
   同じ機構があるかどうかは**比較未実施**。
6. **FFT/LEVELのピーク保持減衰アルゴリズム**: `divtab[16] = {32,16,8,8,4,4,4,4,
   2,2,2,2,2,2,2,2}`(`fmdsp-pacc.c:1645-1648`および`1748-1751`、FFT用・LEVEL用で
   同一テーブルを別々に保持)。fmdsp.c側の値と一致することを確認済み。単純な線形減衰に
   置き換えず、このテーブルをそのまま移植すべき点はfmdsp.c基準から変わらない。
7. **VOLUME DOWN/PGM NUMBERの値表示は依然として実装箇所不明**: fmdsp.c/pacc.c
   両方でラベルのみ確認でき、値の描画コードは発見できなかった。Web版で必要なら
   別途仕様確認(実機/実プレイヤーでの挙動観察)が要る。

## 10. フォント取り違え点検(2026-08-14)

### 経緯

FMDSPタイトル"MUSIC FILE SELECTOR & STATUS DISPLAY"が文字同士めり込んで読めない
不具合の原因調査から、`fmdsp/rightpane.js`が`buf_font_2`相当の描画に
**MEDIUM_FONT(font_fmdsp_medium, 6x8, 送り6px)を誤って使っていた**ことが判明した。
`buf_font_2`という名前から連想しやすいが、実際は下記の通り3つの`buf_font_*`が
すべて同じ`font_fmdsp_small`(5x6, 送り5px)由来である。

### 出典による裏取り

- `fmdsp-pacc.c:799-801`(`fmdsp_pacc_init_tex`): `tex_font = tex_from_font(...,
  &font_fmdsp_small)`、`tex_fontm = tex_from_font(..., &font_fmdsp_medium)`の
  2種類のテクスチャのみ存在。
- `fmdsp-pacc.c:986-999`(`fmdsp_pacc_init_buf`):
  - `buf_font_1 = gen_buf(tex_font, ...)` (small)
  - `buf_font_1_d = gen_buf(tex_font, ...)` (small)
  - `buf_font_2 = gen_buf(tex_font, ...)` (small) ← **ここが取り違えの元**
  - `buf_font_2_d = gen_buf(tex_font, ...)` (small)
  - `buf_font_7 = gen_buf(tex_font, ...)` (small)
  - `buf_fontm_2 = gen_buf(tex_fontm, ...)` (medium)
  - `buf_fontm_3 = gen_buf(tex_fontm, ...)` (medium)

  つまり`buf_font_*`(末尾が数字だけ)は全部small、`buf_fontm_*`(fontmと明記)だけが
  medium。数字の1/2/7は色番号(パレットindex)であってフォントサイズとは無関係。
- 送り幅の実装根拠: `pacc/pacc-gl.c:283-295`(`pacc_buf_vprintf`)の
  `int w = pb->tex->w / 256;` はテクスチャ幅をそのままグリフ送り幅として使う。
  small=5px、medium=6px。

### 点検範囲と結論

`init_default`(`1121-1435`)/`update_default`(`1501-1808`)、すなわち
`FMDSP_RIGHT_MODE_DEFAULT`(本モジュールのスコープ、ファイル冒頭コメント参照)内で
使われる`buf_font_*`を全数点検した結果:

| 呼び出し箇所 | 使用バッファ | 実体 | rightpane.js側(修正前) | 修正後 |
|---|---|---|---|---|
| タイトル("MUS"〜"ISPLAY"、バージョン欄) `1125-1176` | `buf_font_2` | small | MEDIUM_FONT(誤) | SMALL_FONT |
| DRIVERラベル `1182-1191` | `buf_font_7` | small | SMALL_FONT(元から正しい) | 変更なし |
| PASSED TIME〜PGM NUMBER各ラベル `1197-1285` | `buf_font_2` | small | MEDIUM_FONT(誤) | SMALL_FONT |
| CPU POWER COUNT/FRAMES PER SECOND `1296-1319` | `buf_font_2` | small | MEDIUM_FONT(誤) | SMALL_FONT |
| SPECTRUM ANALYZER見出し `1366-1378` | `buf_font_7` | small | SMALL_FONT(元から正しい) | 変更なし |
| FREQ/250/500/1k/2k/4k目盛 `1379-1405` | `buf_font_1` | small | SMALL_FONT(元から正しい) | 変更なし |
| ON/PAN/PROG/KEY, FM1〜PPZ列見出し, 0/-48目盛 | `buf_font_1`/`buf_font_7` | small | SMALL_FONT(元から正しい) | 変更なし |

**結論: 取り違えは3関数(`drawTitle`/`drawTimeLabels`/`drawCpuFpsLabels`)の
計21箇所。すべて「upstreamはsmallなのに我々がmedium(MEDIUM_FONT)を使っていた」
という同一方向の誤り。逆方向(upstreamがmediumなのに我々がsmallだった箇所)は
0件。** 理由は単純で、`FMDSP_RIGHT_MODE_DEFAULT`スコープ内にはmedium
(`buf_fontm_2`/`buf_fontm_3`)を使う描画が1つも存在しないため、逆方向の誤りが
そもそも起こりえない。

medium(`buf_fontm_2`/`buf_fontm_3`)の実際の使用箇所は`mode_update`内
`fmdsp-pacc.c:1879-1884`(PCM種類名`work->pcmname[i]`とファイル名`work->filename`
の描画、`pcmerror[i]`時は`buf_fontm_3`の赤系に切替)のみで、これは
`FILEBAR`領域(PLAYING_Y付近)の動的表示であり、`docs/fmdsp-layout.md`§2の
「PCMタイプ名バー」行が指す機能。本Web版ではこの機能自体が未実装
(`fmdsp/`配下に`pcmname`/`filename`を扱うコードが無いことをgrepで確認済み)。
そのため今回の修正で`MEDIUM_FONT`はrightpane.js内で完全に不要となり、
`font_small.js`の`FONT_MEDIUM`importごと削除した。将来PCM名/ファイル名表示を
実装する際に、この`buf_fontm_2/3`の対応を再度参照すること。

### 検証

- 数値: `tools/verify_rightpane_title_spacing.mjs`(タイトル9断片+バージョン欄の
  間隔を「開始X+文字数×送り幅」で計算し、隣接要素との差が想定通りか機械検査。
  故障注入で送り幅を6px(修正前相当)にすり替えると検査がFAILすることを確認済み)。
- 目視: `tools/render_rightpane_preview.mjs`で修正前後を比較。修正前は
  "MUSICFILESELECTORSTATUSDISPLAYer123"のように断片同士がめり込んでいたが、
  修正後は"MUSIC FILE SELECTOR & STATUS DISPLAY Ver 26.08.14"、
  "PASSED TIME"/"CLOCK COUNT"/"TIMER CYCLE"/"LOOP COUNT"/"VOLUME DOWN"/
  "PGM NUMBER"/"CPU POWER COUNT"/"FRAMES PER SECOND"のいずれも隣接語との
  重なりなく読めることを確認した。

## 11. バージョン表示の仕様(2026-08-14)

98fmplayer自身のバージョン(`FMPLAYER_VERSION_0/1/2`)を出す元々の設計は、
MUCOM88/PMDを鳴らしている本Web版には意味が無いため、**FMSound自身のバージョン**
に差し替えた。詳細な生成ロジックは`tools/gen_version.py`のdocstring、表示側の
配線は`fmdsp/rightpane.js`の`drawTitle()`コメントおよび
`mucomweb/html/index.html`参照。ここでは上流からの座標逸脱のみ記録する。

### VER_0/1/2_Xの逸脱(上流からの唯一の座標変更点)

上流(`fmdsp_sprites.h:126-128`)は1桁の数字を想定して間隔7px
(`TOP_VER_X+15`, `+7`, `+7`)で設計されている。本Web版は「gitコミット日付
YY.MM.DD」の2桁×3フィールドを表示するため、1フィールド2文字(10px)+区切り2px
=12px間隔が必要。そのため`VER_1_X`/`VER_2_X`のみ上流の`+7`を`+12`に変更した
(`VER_0_X`自体は上流と同じ`TOP_VER_X+15`=576のまま)。

**上流からの座標逸脱はこの2箇所(`VER_1_X`,`VER_2_X`の加算値)だけ。** 他の座標
定数(TOP_MUS_X等9個、TOP_VER_X、CURL/TIME/CPU/FPS/SPECTRUM/LEVEL系すべて)は
上流と完全一致のまま変更していない。

ピリオドの扱いは上流の書式`"%s." / "%s." / "%s"`(`fmdsp-pacc.c:1165-1176`)を
そのまま踏襲し、`${version[0]}.` `${version[1]}.` `${version[2]}`で描画する
(`fmdsp/rightpane.js`の`drawTitle()`)。間隔計算(576/588/600)はピリオドを含めず
2桁の数字部分だけで行っている。これは上流自体が「1文字+ピリオド=2文字ぶんの幅」を
7px(=1文字ぶんより2px広いだけ)に収める設計になっており、ピリオドのグリフが
5pxセルの左寄りにしか点を持たないため文字同士の実ピクセルは重ならない、という
upstreamの比率をそのまま2桁化して踏襲したもの。終端は`VER_2_X(600)+2桁*5px=610`
で、キャンバス幅`PC98_W=640`に収まることを`tools/verify_rightpane_title_spacing.mjs`
で数値確認済み。

### 生成方法

`tools/gen_version.py`がgitのコミット日時(JST=UTC+9固定, コミッターdate)と
コミットハッシュから`ui/version.js`を生成する(ビルド時刻=壁時計は使わない。
同じコミットから何度ビルドしても同じ文字列になることが要件。localtime()は
使わずJSTを固定オフセットで扱うため、ビルドマシンのタイムゾーン設定にも依存しない。
`tools/verify_version_determinism.mjs`が`TZ`環境変数を変えても出力が変わらない
ことを確認する)。`mucomweb/CMakeLists.txt`の
`generate_version`ターゲット(ALL付き、`sync_html`より先に実行されるよう
`add_dependencies`で順序付け)がビルドのたびに実行する。生成物は
`.gitignore`対象(`/ui/version.js`)。

取得に失敗した場合(gitが無い/リポジトリでない等)は、`FMSOUND_VERSION_FIELDS`は
`['??','??','??']`、`FMSOUND_VERSION_FOOTER`は`'unknown'`と、**はっきりわかる形**
で出力する(黙って空欄や尤もらしい値で埋めない方針)。

### 表示は2箇所

- FMDSPタイトル欄(`VER_0/1/2_X`): 日付のみ`YY.MM.DD`(`FMSOUND_VERSION_FIELDS`)。
  幅の制約により時刻・ハッシュは入らない。
- ページフッター(`mucomweb/html/index.html`の`#fmsoundVersionFooter`):
  完全な識別子`YYYY-MM-DD HH:MM JST (ハッシュ7桁)`(`FMSOUND_VERSION_FOOTER`)。
  同日に複数回コミットした場合に区別するための一意識別子として、不具合報告時に使う。
  国内利用者が多いため日本時間(JST)で表示し、基準が分かるよう`JST`と明記する。
