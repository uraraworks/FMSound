// 課題D: ツールバーのダウンロードボタンから出す3種類(MMLソース/コンパイル済み/
// asmのdb配列)の配線。ポップオーバーの見た目・構造はエンジンに依らず共通なので
// ここへ寄せ、データの取得だけを呼び出し側(html/pmd-app.js・html/mucom-app.js)から
// コールバックで受け取る。

import { encodeCp932, isAsciiOnly } from './cp932-encode.js';
import { bytesToAsmDb } from './asm-db.js';
import { t } from './i18n.js';

function downloadBytes(bytes, filename, mime) {
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // revoke を遅らせる: 一部ブラウザは click() 直後の同期revokeでダウンロードが
  // 始まる前にURLを失効させることがある(実測ではなく既知のブラウザ実装差異への
  // 保険。過度な遅延にはしない)。
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/**
 * @param {Object} opts
 * @param {string} opts.driverKey        - 'pmd' | 'mucom'(要素idの衝突回避用)
 * @param {string} opts.mmlFilename      - MMLソースの既定ファイル名
 * @param {string} opts.compiledFilename - コンパイル済みバイナリのファイル名
 * @param {string} opts.compiledLabel    - UI表示用のラベル(例: '.M' / '.mub')
 * @param {string} opts.asmFilename      - asm db配列のファイル名
 * @param {string} opts.asmLabel         - asmラベル名(識別子)
 * @param {() => string} opts.getMmlText - 現在のMMLソース文字列を返す
 * @param {() => (Uint8Array|null)} opts.getCompiledBytes - 直近コンパイル済みバイト列(無ければnull)
 */
export function createDownloadMenu(opts) {
  const {
    driverKey, mmlFilename, compiledFilename, compiledLabel,
    asmFilename, asmLabel, getMmlText, getCompiledBytes,
  } = opts;

  const popover = document.createElement('div');
  popover.className = 'settings-popover download-popover hidden';
  popover.id = `downloadPopover-${driverKey}`;
  document.body.appendChild(popover);

  function handleMmlDownload(ascii) {
    const text = getMmlText();
    if (ascii) {
      // ASCIIのみならCP932/UTF-8のどちらでバイト化しても結果は同じなので、
      // 選択肢自体を出さない(課題Dの指示どおり)。
      downloadBytes(new TextEncoder().encode(text), mmlFilename, 'text/plain');
      return;
    }
    const checked = popover.querySelector(`input[name="mmlEncoding-${driverKey}"]:checked`);
    const encoding = checked ? checked.value : 'cp932';
    if (encoding === 'utf8') {
      const utf8Name = mmlFilename.replace(/\.mml$/i, '.utf8.mml');
      downloadBytes(new TextEncoder().encode(text), utf8Name, 'text/plain;charset=utf-8');
      return;
    }
    const { bytes, unmappable } = encodeCp932(text);
    if (!bytes) {
      // 課題D: どの文字が変換できないかを具体的に示す(黙って化けさせない)。
      alert(t('download.cp932UnmappableAlert', { count: unmappable.length, chars: unmappable.join(' ') }));
      return;
    }
    downloadBytes(bytes, mmlFilename, 'text/plain');
  }

  function render() {
    const text = getMmlText();
    const ascii = isAsciiOnly(text);
    const compiled = getCompiledBytes();

    popover.innerHTML = `
      <p class="settings-popover-title">${t('download.title')}</p>
      <div class="download-section">
        <p class="download-section-title">${t('download.mmlSection')}</p>
        ${ascii ? '' : `
        <div>
          <label class="download-radio"><input type="radio" name="mmlEncoding-${driverKey}" value="cp932" checked> ${t('download.encodingDefault')}</label>
          <label class="download-radio"><input type="radio" name="mmlEncoding-${driverKey}" value="utf8"> ${t('download.encodingUtf8')}</label>
        </div>
        `}
        <button type="button" class="download-btn" data-action="mml">${t('download.downloadBtn')}</button>
      </div>
      <div class="download-section">
        <p class="download-section-title">${t('download.compiledSection', { label: compiledLabel })}</p>
        <button type="button" class="download-btn" data-action="compiled" ${compiled ? '' : 'disabled'}>${t('download.downloadBtn')}</button>
        ${compiled ? '' : `<p class="download-hint">${t('download.compileHint')}</p>`}
      </div>
      <div class="download-section">
        <p class="download-section-title">${t('download.asmSection')}</p>
        <button type="button" class="download-btn" data-action="asm" ${compiled ? '' : 'disabled'}>${t('download.downloadBtn')}</button>
      </div>
    `;

    popover.querySelector('[data-action="mml"]').addEventListener('click', () => handleMmlDownload(ascii));
    const compiledBtn = popover.querySelector('[data-action="compiled"]');
    if (compiled) {
      compiledBtn.addEventListener('click', () => {
        downloadBytes(getCompiledBytes(), compiledFilename, 'application/octet-stream');
      });
    }
    const asmBtn = popover.querySelector('[data-action="asm"]');
    if (compiled) {
      asmBtn.addEventListener('click', () => {
        const asmText = bytesToAsmDb(getCompiledBytes(), asmLabel);
        downloadBytes(new TextEncoder().encode(asmText), asmFilename, 'text/plain;charset=utf-8');
      });
    }
  }

  return { popoverEl: popover, render };
}
