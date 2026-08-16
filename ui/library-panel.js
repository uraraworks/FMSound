// 曲ライブラリの一覧UI(アルバム→トラックの2段、ツールバーの.settings-popover系と
// 同じ骨組みを流用)。net/library.js(DOM非依存の保存層)を直接操作するのはここだけにし、
// engine-app側(html/mucom-app.js・html/pmd-app.js)は「選ばれた曲を再生する」コールバックを
// 渡すだけにする(ui/download-menu.jsと同じ分担の考え方)。
//
// ドライバ(mucom/pmd)を跨いだ曲は表示しない: MUCOM88のMMLテキストとPMDの.Mバイナリは
// 形式が違い、このページのプレイヤーでは別ドライバの曲を再生できないため
// (別ドライバの曲を試したい場合は?driver=を切り替えたページを開く、という既存の
// 案内(song-picker等)と同じ考え方)。

import { listSongs, deleteSong, groupSongsIntoAlbums } from '../net/library.js';
import { t } from './i18n.js';

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * @param {Object} opts
 * @param {'mucom'|'pmd'} opts.driver
 * @param {() => Promise<IDBDatabase|null>} opts.getDb
 * @param {(song: object) => void} opts.onSelect 曲が選ばれたときに呼ばれる(bytes/fileName等を含むレコードそのもの)
 */
export function createLibraryPanel({ driver, getDb, onSelect }) {
  const popover = document.createElement('div');
  popover.className = 'settings-popover library-popover hidden';
  document.body.appendChild(popover);

  // アルバム一覧表示中はnull、ドリルダウン中は選択中のアルバムid。
  let openAlbumId = null;

  async function render() {
    const db = await getDb();
    if (!db) {
      popover.innerHTML = `
        <p class="settings-popover-title">${t('library.title')}</p>
        <p class="library-empty">${t('library.unavailable')}</p>
      `;
      return;
    }
    const all = await listSongs(db);
    const songs = all.filter((s) => s.driver === driver);
    if (songs.length === 0) {
      popover.innerHTML = `
        <p class="settings-popover-title">${t('library.title')}</p>
        <p class="library-empty">${t('library.empty')}</p>
      `;
      return;
    }
    const albums = groupSongsIntoAlbums(songs);
    if (openAlbumId && !albums.some((a) => a.id === openAlbumId)) openAlbumId = null;
    const openAlbum = openAlbumId ? albums.find((a) => a.id === openAlbumId) : null;
    if (openAlbum) {
      renderTrackList(openAlbum);
    } else {
      renderAlbumList(albums);
    }
  }

  function renderAlbumList(albums) {
    const totalCount = albums.reduce((n, a) => n + a.songs.length, 0);
    popover.innerHTML = `
      <p class="settings-popover-title">${t('library.titleWithCount', { count: totalCount })}</p>
      <ul class="library-album-list"></ul>
      <button type="button" class="library-clear-all">${t('library.clearAll')}</button>
    `;
    const list = popover.querySelector('.library-album-list');
    for (const album of albums) {
      const li = document.createElement('li');
      li.className = 'library-album-item';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'library-album-btn';
      btn.innerHTML =
        `<span class="library-album-label">${escapeHtml(album.label)}</span>` +
        `<span class="library-album-count">${t('library.albumCount', { count: album.songs.length })}</span>`;
      btn.addEventListener('click', () => {
        openAlbumId = album.id;
        render();
      });
      li.appendChild(btn);
      list.appendChild(li);
    }
    popover.querySelector('.library-clear-all').addEventListener('click', async () => {
      // 課題: 他ドライバの曲を巻き込まないよう、実際にはこのドライバの曲だけを消す
      // (clearAllSongs()はDB全体を消してしまうため、ここでは1件ずつdeleteSong()する)。
      if (!window.confirm(t('library.clearAllConfirm', { count: totalCount }))) return;
      const db = await getDb();
      for (const album of albums) {
        for (const song of album.songs) {
          await deleteSong(db, song.id);
        }
      }
      openAlbumId = null;
      render();
    });
  }

  function renderTrackList(album) {
    popover.innerHTML = `
      <button type="button" class="library-back">${t('library.backToAlbums')}</button>
      <p class="settings-popover-title">${t('library.albumHeader', { label: escapeHtml(album.label), count: album.songs.length })}</p>
      <ul class="library-track-list"></ul>
    `;
    popover.querySelector('.library-back').addEventListener('click', () => {
      openAlbumId = null;
      render();
    });
    const list = popover.querySelector('.library-track-list');
    for (const song of album.songs) {
      const li = document.createElement('li');
      li.className = 'library-track-item';

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'library-track-btn';
      const numberLabel = song.trackNumber != null ? `${song.trackNumber}. ` : '';
      const displayTitle = song.title ?? song.fileName;
      btn.innerHTML =
        `<span class="library-track-title">${escapeHtml(numberLabel + displayTitle)}</span>` +
        (song.composer ? `<span class="library-track-composer">${escapeHtml(song.composer)}</span>` : '');
      btn.title = song.fileName;
      btn.addEventListener('click', () => {
        close();
        onSelect(song);
      });
      li.appendChild(btn);

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'library-track-delete';
      delBtn.textContent = t('library.deleteTrack');
      delBtn.title = t('library.deleteTrackTitle', { title: displayTitle });
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const db = await getDb();
        await deleteSong(db, song.id);
        render();
      });
      li.appendChild(delBtn);

      list.appendChild(li);
    }
  }

  function close() {
    popover.classList.add('hidden');
  }

  return { popoverEl: popover, render };
}
