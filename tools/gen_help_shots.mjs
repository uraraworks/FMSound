#!/usr/bin/env node
// 使い方ページ(html/help.html、次ラウンドで作成予定)向けのスクリーンショットを
// 再現可能に生成する。
//
// 方式(利用者指示、決定済み):
//   - npm依存を追加しない(このリポジトリはnode_modules/package.jsonを持たない
//     素のES module構成。puppeteer/playwrightは入れない)。
//   - macOSのChromeをheadless=newで起動し、CDP(Chrome DevTools Protocol)を
//     Node組み込みのWebSocketで直接叩いて操作する。
//   - dist/ を自前のpython3 http.serverでポート8790に配信する(8779は親セッション
//     が使用中のため触らない)。
//
// 実行: node tools/gen_help_shots.mjs
//
// 生成物: html/help/<name>.<lang>.png (ja/en × overview/open-menu/editor/settings)
// + html/help/fmdsp.png (言語に依らず1枚。2026-08-16、下記「3. fmdsp」のコメント参照:
//   FMDSP自体の表示が元々すべて英字で、ja/en間で見た目が変わらないため統合した)。

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist');
const OUT_DIR = join(ROOT, 'html', 'help');
const HTTP_PORT = 8790;
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VIEWPORT = { width: 1280, height: 800 };

const LABELS = {
  ja: { open: '曲を開く', settings: '設定', editorMode: 'エディタモードへ切替' },
  en: { open: 'Open song', settings: 'Settings', editorMode: 'Switch to editor mode' },
};

function log(msg) {
  console.log(`[gen_help_shots] ${msg}`);
}

// --- dist/ が無ければビルドする(無言で古いdistを撮らないため) ---
if (!existsSync(join(DIST, 'index.html'))) {
  log('dist/ が無いので tools/build_dist.sh を実行する');
  const r = spawn('bash', [join(ROOT, 'tools', 'build_dist.sh')], { stdio: 'inherit', cwd: ROOT });
  const code = await new Promise((resolve) => r.on('exit', resolve));
  if (code !== 0) throw new Error(`build_dist.sh が失敗した(exit ${code})`);
}
if (!existsSync(join(DIST, 'index.html'))) {
  throw new Error('dist/index.html が見つからない。tools/build_dist.sh を確認すること。');
}

mkdirSync(OUT_DIR, { recursive: true });

// ============================================================
// 素のPNGデコーダ(色数検査用)。tools/gen_og_image.mjsのエンコーダの逆。
// bit depth 8のみ対応(Chromeのcapture screenshotはこの前提で出る)。
// color type: 0(gray) 2(RGB) 3(palette) 4(gray+alpha) 6(RGBA)
// filter type 0-4(none/sub/up/average/paeth)をフレームごとに解く。
// ============================================================
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('PNGシグネチャが不正');
  let pos = 8;
  let width, height, bitDepth, colorType;
  let idat = [];
  let palette = null;
  let trns = null;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IEND') {
      break;
    }
    pos += 8 + len + 4;
  }
  if (bitDepth !== 8) throw new Error(`未対応のbit depth: ${bitDepth}`);
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`未対応のcolor type: ${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let rawPos = 0;
  for (let y = 0; y < height; ++y) {
    const filter = raw[rawPos++];
    const rowStart = y * stride;
    const prevStart = (y - 1) * stride;
    for (let x = 0; x < stride; ++x) {
      const rawByte = raw[rawPos++];
      const a = x >= channels ? out[rowStart + x - channels] : 0;
      const b = y > 0 ? out[prevStart + x] : 0;
      const c = y > 0 && x >= channels ? out[prevStart + x - channels] : 0;
      let val;
      switch (filter) {
        case 0: val = rawByte; break;
        case 1: val = rawByte + a; break;
        case 2: val = rawByte + b; break;
        case 3: val = rawByte + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          val = rawByte + pred;
          break;
        }
        default: throw new Error(`未対応のfilter type: ${filter}`);
      }
      out[rowStart + x] = val & 0xff;
    }
  }
  // RGBAへ正規化
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; ++i) {
    let r, g, b, a = 255;
    if (colorType === 6) {
      r = out[i * 4]; g = out[i * 4 + 1]; b = out[i * 4 + 2]; a = out[i * 4 + 3];
    } else if (colorType === 2) {
      r = out[i * 3]; g = out[i * 3 + 1]; b = out[i * 3 + 2];
    } else if (colorType === 0) {
      r = g = b = out[i];
    } else if (colorType === 4) {
      r = g = b = out[i * 2]; a = out[i * 2 + 1];
    } else if (colorType === 3) {
      const idx = out[i];
      r = palette[idx * 3]; g = palette[idx * 3 + 1]; b = palette[idx * 3 + 2];
      a = trns && idx < trns.length ? trns[idx] : 255;
    }
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = a;
  }
  return { width, height, rgba };
}

function countDistinctColors(rgba, cap = 5000) {
  const seen = new Set();
  for (let i = 0; i < rgba.length; i += 4) {
    seen.add((rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2]);
    if (seen.size >= cap) return seen.size; // 早期打ち切り(検査には十分)
  }
  return seen.size;
}

// ============================================================
// dist/ 配信用の簡易HTTPサーバー(python3 http.server、ポート8790固定)
// ============================================================
function startHttpServer() {
  const proc = spawn('python3', ['-m', 'http.server', String(HTTP_PORT), '--directory', DIST], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return proc;
}

async function waitForHttp(url, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 404) return true;
    } catch {
      // まだ立ち上がっていない
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`HTTPサーバーが${timeoutMs}ms以内に応答しなかった: ${url}`);
}

// ============================================================
// CDP(Chrome DevTools Protocol)最小クライアント
// ============================================================
class CDPSession {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`CDP error: ${JSON.stringify(msg.error)}`));
        else resolve(msg.result);
      } else if (msg.method) {
        const cbs = this.listeners.get(msg.method);
        if (cbs) for (const cb of cbs.slice()) cb(msg.params);
      }
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, cb) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(cb);
  }

  once(method) {
    return new Promise((resolve) => {
      const cb = (params) => {
        const list = this.listeners.get(method);
        const idx = list.indexOf(cb);
        if (idx >= 0) list.splice(idx, 1);
        resolve(params);
      };
      this.on(method, cb);
    });
  }

  /** returnByValueなRuntime.evaluate。例外はそのまま投げる。 */
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`Runtime.evaluate例外: ${JSON.stringify(result.exceptionDetails)}`);
    }
    return result.result.value;
  }
}

async function connectNewTab(devtoolsPort) {
  const res = await fetch(`http://127.0.0.1:${devtoolsPort}/json/new?about:blank`, { method: 'PUT' });
  const info = await res.json();
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  return { cdp: new CDPSession(ws), targetId: info.id, ws };
}

/** conditionExpr(JS式文字列, 真偽/truthyを返す)がtrueになるまでポーリングする。 */
async function pollUntil(cdp, conditionExpr, { timeoutMs = 8000, intervalMs = 150, label = '' } = {}) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    last = await cdp.evaluate(conditionExpr);
    if (last) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`pollUntil timeout (${label || conditionExpr}): last=${JSON.stringify(last)}`);
}

async function findChromePort() {
  // 空きポートを適当な範囲から探す(固定ポートは他プロセスと衝突しうるため)。
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function main() {
  const results = []; // 報告用: {name, lang, width, height, bytes, colorCount}
  const notes = [];

  log(`dist/ をポート${HTTP_PORT}で配信開始`);
  const httpProc = startHttpServer();
  const cleanupHttp = () => { try { httpProc.kill(); } catch {} };
  process.on('exit', cleanupHttp);
  process.on('SIGINT', () => { cleanupHttp(); process.exit(1); });

  try {
    await waitForHttp(`http://127.0.0.1:${HTTP_PORT}/index.html`);

    // 言語ごとに完全に新しいChromeプロセス+user-data-dirを使う。
    // (課題: 同一プロファイルで ja→en と続けて撮ると、localStorageの下書き復元/
    //  エディタモードの状態がenへ持ち越され、「エリーゼのために」のMML本文が
    //  英語版スクリーンショットに映り込んだ。これはアプリのi18n不備ではなく、
    //  このスクリプトが状態を分離できていなかった撮影側のバグだった。)
    for (const lang of ['ja', 'en']) {
      log(`=== lang=${lang} ===`);
      const userDataDir = mkdtempSync(join(tmpdir(), `fmsound-help-shots-${lang}-`));
      const devtoolsPort = await findChromePort();
      log(`Chromeをheadlessで起動(lang=${lang}, devtools port ${devtoolsPort})`);
      const chromeProc = spawn(CHROME_PATH, [
        '--headless=new',
        `--remote-debugging-port=${devtoolsPort}`,
        `--user-data-dir=${userDataDir}`,
        '--hide-scrollbars',
        '--disable-gpu',
        '--disable-extensions',
        '--no-first-run',
        `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
        'about:blank',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      const cleanupChrome = () => {
        try { chromeProc.kill(); } catch {}
        try { rmSync(userDataDir, { recursive: true, force: true }); } catch {}
      };
      process.on('exit', cleanupChrome);

      await waitForHttp(`http://127.0.0.1:${devtoolsPort}/json/version`, 10000);

      const { cdp, ws } = await connectNewTab(devtoolsPort);
      try {
        await cdp.send('Page.enable');
        await cdp.send('Runtime.enable');
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false,
        });
        // rAFカウンタ(fmdsp描画がrAF依存のため、実際に何回呼ばれたかを実測する)。
        await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
          source: `
            window.__rafCount = 0;
            const __origRaf = window.requestAnimationFrame.bind(window);
            window.requestAnimationFrame = function(cb) {
              window.__rafCount++;
              return __origRaf(cb);
            };
          `,
        });

        const url = `http://127.0.0.1:${HTTP_PORT}/index.html?driver=mucom&lang=${lang}`;
        const loadFired = cdp.once('Page.loadEventFired');
        await cdp.send('Page.navigate', { url });
        await loadFired;

        const L = LABELS[lang];

        // アプリ初期化完了の目印: updateChannelStatus()のrAFループが数フレーム回った
        // (=engine-appのinit()まで完走している)ことを条件にする。
        await pollUntil(cdp, `window.__rafCount > 5`, { timeoutMs: 15000, label: 'app init (rAF loop)' });

        // --- 5枚のうち英語版で日本語混入が無いかのDOM検査(撮影直前に毎回実行) ---
        const jaCharRegex = '/[\\u3040-\\u30ff\\u3400-\\u9fff\\uff00-\\uffef]/';
        const scanJa = `
          (() => {
            const hits = [];
            const isExempt = (s) => s.trim() === '日本語';
            // display:noneな祖先を持つ要素はgetClientRects()が空になる(position:fixedな
            // ポップオーバーは空にならないので拾える)。実際に画面へ描かれるものだけを見る。
            const isRendered = (el) => el.getClientRects().length > 0;
            document.querySelectorAll('body *').forEach((el) => {
              if (!isRendered(el)) return;
              if (el.children.length === 0) {
                const txt = (el.textContent || '').trim();
                if (txt && ${jaCharRegex}.test(txt) && !isExempt(txt)) hits.push('text:' + txt.slice(0, 40));
              }
              for (const attr of ['title', 'aria-label']) {
                const v = el.getAttribute && el.getAttribute(attr);
                if (v && ${jaCharRegex}.test(v) && !isExempt(v)) hits.push(attr + ':' + v.slice(0, 40));
              }
            });
            return hits.slice(0, 20);
          })()
        `;

        async function checkJaLeak(scene) {
          if (lang !== 'en') return;
          const hits = await cdp.evaluate(scanJa);
          if (hits.length > 0) {
            notes.push(`[JA-LEAK][${scene}] ${JSON.stringify(hits)}`);
          }
        }

        // fileNameOverrideを渡すと `${name}.${lang}.png` の代わりにそのファイル名で
        // 保存する(fmdspのように言語で見た目が変わらない画面を1枚に統合する用途、
        // 下記参照)。
        async function shoot(name, clip, fileNameOverride) {
          const params = { format: 'png' };
          if (clip) params.clip = { ...clip, scale: 1 };
          const { data } = await cdp.send('Page.captureScreenshot', params);
          const buf = Buffer.from(data, 'base64');
          const fileName = fileNameOverride ?? `${name}.${lang}.png`;
          const path = join(OUT_DIR, fileName);
          writeFileSync(path, buf);
          const decoded = decodePng(buf);
          const colorCount = countDistinctColors(decoded.rgba);
          results.push({
            name, lang, width: decoded.width, height: decoded.height,
            bytes: buf.length, colorCount, fileName,
          });
          if (colorCount <= 1) {
            notes.push(`[MONOCHROME] ${fileName} は単色(色数=${colorCount})`);
          }
          return { path, colorCount };
        }

        // 1. overview
        await checkJaLeak('overview');
        await shoot('overview');

        // 2. open-menu: 「曲を開く」ポップオーバー
        const openLabel = JSON.stringify(L.open);
        const clickOpen = `
          (() => {
            const b = [...document.querySelectorAll('button')]
              .find((x) => x.getAttribute('aria-label') === ${openLabel});
            if (!b) return false;
            b.click();
            return true;
          })()
        `;
        const clicked = await cdp.evaluate(clickOpen);
        if (!clicked) notes.push(`[WARN] open-menuボタンが見つからなかった(lang=${lang})`);
        await pollUntil(cdp, `
          (() => {
            const p = document.querySelector('.open-popover');
            if (!p || p.classList.contains('hidden')) return false;
            const r = p.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          })()
        `, { timeoutMs: 5000, label: 'open-popover visible' });
        await checkJaLeak('open-menu');
        await shoot('open-menu');
        // 閉じる(同じボタンを再クリックしてトグル)
        await cdp.evaluate(clickOpen);

        // 3. fmdsp: canvas領域を切り出す。描画がrAF依存なので、単色でなくなるまで
        //    ポーリングで待つ(固定sleepにしない)。
        //
        // 【2026-08-16、前回撮影の実測を反映】fmdsp.ja.png と fmdsp.en.png は
        // md5完全一致だった(FMDSP自体の表示が元々すべて英字のため、言語切替の
        // 影響を受けない)。異常ではないが、言語別に2枚持つ意味が無いので
        // fmdsp.png の1枚に統合する(撮影自体はja側でのみ行う)。ただし
        // 「英語版DOMへの日本語混入が無いか」のcheckJaLeak('fmdsp')自体は
        // 撮影の有無に関わらず両言語で回す(checkJaLeak内部でlang!=='en'なら
        // 何もしないため、ja側の呼び出しは実質no-opだが対称性のため残す)。
        let fmdspNonBlack = 0;
        if (lang === 'ja') {
          try {
            fmdspNonBlack = await pollUntil(cdp, `
              (() => {
                const cv = document.getElementById('fmdsp-canvas');
                if (!cv) return 0;
                const ctx = cv.getContext('2d');
                const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
                let nonBlack = 0;
                for (let i = 0; i < d.length; i += 4) {
                  if (d[i] || d[i + 1] || d[i + 2]) nonBlack++;
                }
                return nonBlack;
              })()
            `, { timeoutMs: 6000, intervalMs: 200, label: 'fmdsp canvas non-blank' });
          } catch (e) {
            notes.push(`[WARN] fmdsp canvasが規定時間内に非単色にならなかった(lang=${lang}): ${e.message}`);
          }
        }
        const stageBox = await cdp.evaluate(`
          (() => {
            const el = document.getElementById('stage');
            const r = el.getBoundingClientRect();
            return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
          })()
        `);
        await checkJaLeak('fmdsp');
        if (lang === 'ja') {
          await shoot('fmdsp', stageBox, 'fmdsp.png');
          notes.push(`[INFO] fmdsp非黒ピクセル数(lang=${lang}): ${fmdspNonBlack}`);
        }

        // 4. editor: エディタモードへ切替→enginePaneを切り出す
        const editorLabel = JSON.stringify(L.editorMode);
        await cdp.evaluate(`
          (() => {
            const b = [...document.querySelectorAll('button')]
              .find((x) => x.getAttribute('aria-label') === ${editorLabel});
            if (b) b.click();
          })()
        `);
        await pollUntil(cdp, `
          (() => {
            const el = document.getElementById('enginePane');
            if (!el || el.classList.contains('hidden')) return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          })()
        `, { timeoutMs: 5000, label: 'enginePane visible' });
        const editorBox = await cdp.evaluate(`
          (() => {
            const el = document.getElementById('enginePane');
            const r = el.getBoundingClientRect();
            const pad = 8;
            const x = Math.max(0, Math.round(r.x) - pad);
            const y = Math.max(0, Math.round(r.y) - pad);
            const width = Math.min(${VIEWPORT.width} - x, Math.round(r.width) + pad * 2);
            const height = Math.min(${VIEWPORT.height} - y, Math.round(r.height) + pad * 2);
            return { x, y, width, height };
          })()
        `);
        await checkJaLeak('editor');
        await shoot('editor', editorBox);

        // 5. settings: 曲ライブラリはIndexedDBが空(まっさらなプロファイル)で中身の
        //    ある一覧を撮れないため、代わりに意味のある画面として設定ポップオーバーを撮る。
        //    (でっち上げの曲データを注入しない、という利用者指示に従う)
        const settingsLabel = JSON.stringify(L.settings);
        const clickSettings = `
          (() => {
            const b = [...document.querySelectorAll('button')]
              .find((x) => x.getAttribute('aria-label') === ${settingsLabel});
            if (!b) return false;
            b.click();
            return true;
          })()
        `;
        const settingsClicked = await cdp.evaluate(clickSettings);
        if (!settingsClicked) notes.push(`[WARN] settingsボタンが見つからなかった(lang=${lang})`);
        await pollUntil(cdp, `
          (() => {
            const p = document.getElementById('settingsPopover');
            if (!p || p.classList.contains('hidden')) return false;
            const r = p.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          })()
        `, { timeoutMs: 5000, label: 'settingsPopover visible' });
        await checkJaLeak('settings');
        await shoot('settings');
        await cdp.evaluate(clickSettings);
      } finally {
        try { await cdp.send('Page.close'); } catch {}
        try { ws.close(); } catch {}
        cleanupChrome();
      }
    }
  } finally {
    cleanupHttp();
  }

  // --- 報告用サマリ ---
  log('=== 結果 ===');
  let totalBytes = 0;
  for (const r of results) {
    totalBytes += r.bytes;
    log(`${r.fileName}: ${r.width}x${r.height} ${(r.bytes / 1024).toFixed(1)}KB colors=${r.colorCount}${r.colorCount <= 1 ? ' [MONOCHROME!]' : ''}`);
  }
  log(`合計: ${(totalBytes / 1024).toFixed(1)}KB`);
  if (notes.length > 0) {
    log('--- 注意事項 ---');
    for (const n of notes) log(n);
  } else {
    log('注意事項なし(単色検査OK・日本語混入チェックOK)');
  }

  const anyMono = results.some((r) => r.colorCount <= 1);
  if (anyMono) {
    log('単色画像が含まれるため、該当ファイルの扱いを確認すること(コミット前に見直す)。');
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
