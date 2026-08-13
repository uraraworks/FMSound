// コメント欄(曲名・作曲者・編曲者・メモ)の描画。
// 出典: docs/fmdsp-layout.md §5、実描画は upstream/98fmplayer/fmdsp/fmdsp-pacc.c の
// fmdsp_pacc_comment_draw() (2281-2347)、三角マーカーは draw_tri() (2273-2279)。
//
// 本家は専用テクスチャ comment_tex_buf(PC98_W x CHECKER_H)へ一旦描いてから
// (0, CHECKER_Y) に合成するが、Web版は単一の vram にそのまま描く。そのため
// 本家の座標(comment_tex_buf内のローカル座標)には CHECKER_Y を足して screen
// 座標に変換する。

import { drawText, drawTextCp932 } from './font.js';

// fmdsp-pacc.h:22-23: CHECKER_H = (16+3)*3+8, CHECKER_Y = PC98_H - CHECKER_H
// (PC98_H=400 は vram.js の PC98_H と同値)。
export const CHECKER_H = (16 + 3) * 3 + 8; // = 65
export const CHECKER_Y = 400 - CHECKER_H; // = 335

// fmdsp_sprites.h:44 `COMMENT_H = 19,`
export const COMMENT_H = 19;

// fmdsp-pacc.c:2273-2279 (draw_tri) の移植。直角三角形(3x3、右下が直角)を
// 1色で塗る。本家は `buf[(y+yi)*width+x+xi] = 1;` で1bppテクスチャに描いてから
// 別途色付けするが、Web版は最初からパレットindex(color)を直接置く。
export function drawTri(vram, x, y, color) {
  for (let yi = 0; yi < 3; ++yi) {
    for (let xi = 0; xi <= yi; ++xi) {
      vram.setPixel(x + xi, y + yi, color);
    }
  }
}

// bytesFor(line) -> Uint8Array(CP932) | null を呼び出し側から渡してもらう。
// (Module.getCommentLength/getCommentPointer + HEAPU8 のラップは index.html 側の責務。
//  comment.js は emscripten Module を直接知らない)
//
// commentModePmd: work->comment_mode_pmd (bool)
// commentOffset: PMDメモモードのスクロール位置(呼び出し側が保持する状態)
// smallFont: ラベル用 font_fmdsp_small 相当 (SmallFont)
// bigFont: 本文用 shinonome 16px相当 (FmdspFont, fp->font16に対応)
// color: パレットインデックス。本家はテクスチャの1bppマスクに後段で色を
//   乗せる方式(comment_tex_bufは0/1のみ)なので単色。fmdsp-pacc.c 2064系の
//   buf_font_1相当としてラベル・本文とも同色(COLOR_LABEL=1)を既定にする。
export function drawComment(
  vram, smallFont, bigFont, bytesFor, commentModePmd, commentOffset, color = 1
) {
  if (commentModePmd) {
    for (let i = 0; i < 3; ++i) {
      const n = i + commentOffset;
      const rowY = CHECKER_Y + COMMENT_H * i;
      if (n === 0) {
        const bytes = bytesFor(0);
        if (bytes) {
          // fmdsp-pacc.c:2295-2302: "MUS"/"IC"/"T"/"ITLE" をラベルとして分割描画。
          drawText(vram, smallFont, 'MUS', 14, rowY + 12, color);
          drawText(vram, smallFont, 'IC', 28, rowY + 12, color);
          drawText(vram, smallFont, 'T', 40, rowY + 12, color);
          drawText(vram, smallFont, 'ITLE', 44, rowY + 12, color);
          drawTri(vram, 65, rowY + 15, color);
          drawTextCp932(vram, bigFont, bytes, 80, rowY + 4, color, 0);
        }
      } else if (n === 1) {
        // fmdsp-pacc.c:2307-2325: COMPOSER(左, maxwidth=224) / ARRANGER(右)。
        const composer = bytesFor(1);
        if (composer) {
          drawText(vram, smallFont, 'COMPOSER', 24, rowY + 12, color);
          drawTri(vram, 65, rowY + 15, color);
          drawTextCp932(vram, bigFont, composer, 80, rowY + 4, color, 224);
        }
        const arranger = bytesFor(2);
        if (arranger) {
          drawText(vram, smallFont, 'ARRANGER', 312, rowY + 12, color);
          drawTri(vram, 353, rowY + 15, color);
          drawTextCp932(vram, bigFont, arranger, 368, rowY + 4, color, 0);
        }
      } else {
        // fmdsp-pacc.c:2326-2335: MEMO(n+1行目、#Memo以降のオフセット)。
        const bytes = bytesFor(n + 1);
        if (bytes) {
          drawText(vram, smallFont, 'MEMO', 44, rowY + 12, color);
          drawTri(vram, 65, rowY + 15, color);
          drawTextCp932(vram, bigFont, bytes, 80, rowY + 4, color, 0);
        }
      }
    }
  } else {
    // fmdsp-pacc.c:2337-2345: 3行コメント固定表示。ラベル・三角なし。
    for (let i = 0; i < 3; ++i) {
      const bytes = bytesFor(i);
      if (bytes) {
        drawTextCp932(vram, bigFont, bytes, 0, CHECKER_Y + COMMENT_H * i + 5, color, 0);
      }
    }
  }
}

// fmdsp-pacc.c:2354-2365 (fmdsp_pacc_comment_scroll) の移植。
// commentModePmdでない場合は無視、down方向は次行の存在確認をしてから進める。
// 呼び出し側が保持する commentOffset を受け取り、新しい値を返す
// (本家はfp->comment_offsetを直接書き換えるが、Web版は状態をindex.html側に置く)。
export function commentScroll(commentOffset, down, commentModePmd, bytesFor) {
  if (!commentModePmd) return commentOffset;
  if (down) {
    if (bytesFor(commentOffset + 2 + 1 + 1)) return commentOffset + 1;
    return commentOffset;
  }
  if (commentOffset > 0) return commentOffset - 1;
  return commentOffset;
}
