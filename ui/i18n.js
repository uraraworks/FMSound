// FMSound の ja/en 切替(辞書方式)。
//
// 設計(利用者指示、発明はしない):
//   - 英語のみへの置き換えではなく、日本語の辞書もここに残す。
//   - 言語の決定順: (1) URLの?lang=ja/?lang=en(この2値以外は無視)
//                    (2) navigator.languageが'ja'始まりならja、それ以外はen。
//   - このモジュール自体はビルド不要の素のES module(依存追加なし)。
//   - tools/verify_i18n.mjs がNode(ブラウザではない)からこのファイルをそのまま
//     importして辞書の整合性を検証する。そのため、モジュール評価の副作用として
//     `location`/`navigator` に触れてはいけない(Nodeには存在せず即クラッシュする)。
//     参照は detectLang() 等の関数の「呼び出し時」に限定する。
//
// 今回(L1)の対象は「利用者が操作する前から画面に出ている固定ラベル」だけ。
// コンパイル結果・エラー理由・再生ボタンの状態表示など、実行時に動的合成される
// メッセージは対象外(次ラウンド。html/pmd-app.js・html/mucom-app.js・
// ui/mml-status.js の該当箇所は未着手のまま)。

export const LANGS = ['ja', 'en'];
export const DEFAULT_LANG = 'en';

const ja = {
  'page.title': 'FMSound — FM音源MMLプレイヤー',

  'toolbar.driverLabel': '音源ドライバ:',
  'toolbar.langLabel': '言語:',
  'toolbar.playPauseInitial': 'コンパイル&再生 (⌘/Ctrl+Enter)',
  'toolbar.stop': '停止 (Esc)',
  'toolbar.open': '曲を開く',
  'toolbar.download': 'ダウンロード',
  'toolbar.settings': '設定',
  'toolbar.fullscreen': 'フルスクリーン',
  'toolbar.fullscreenExit': 'フルスクリーン解除',
  'toolbar.editorMode': 'エディタモードへ切替',
  'toolbar.playerMode': 'プレイヤーモードへ切替',
  'toolbar.newFile': '新規作成',
  'toolbar.library': '曲ライブラリ',

  'settings.title': '設定',
  'settings.sampleRate': 'サンプルレート',
  'settings.calibrationMs': '同期較正(ms)',
  'settings.syncDraw': '音声に同期して描画する',

  'openMenu.title': '曲を開く',
  'openMenu.fromFile': 'ファイルから開く',
  'openMenu.fromUrl': 'URLから開く',
  'openMenu.submit': '実行',
  'openMenu.cancel': '取消',

  'download.title': 'ダウンロード',
  'download.downloadBtn': 'ダウンロード',
  'download.mmlSection': 'MMLソース(編集中の内容)',
  'download.encodingDefault': 'CP932(既定)',
  'download.encodingUtf8': 'UTF-8',
  'download.compiledSection': 'コンパイル済み({label})',
  'download.compileHint': '先にコンパイル&再生(または曲を開く)してください',
  'download.asmSection': 'asmの db 配列(PC-98/PC-88プログラムへ埋め込み用)',
  'download.cp932UnmappableAlert':
    'CP932へ変換できない文字が{count}種類あります:\n{chars}\n\nUTF-8を選ぶか、該当箇所を修正してからやり直してください。',

  'library.title': '曲ライブラリ',
  'library.titleWithCount': '曲ライブラリ({count}曲)',
  'library.unavailable': 'この端末ではライブラリを利用できません(プライベートブラウズ中、または非対応環境の可能性があります)。',
  'library.empty': 'まだ曲がありません。URL指定やドラッグ&ドロップで曲を読み込むと、次回からここに残るようになります。',
  'library.clearAll': 'すべて削除',
  'library.clearAllConfirm': 'このプレイヤーのライブラリ({count}曲)をすべて削除します。よろしいですか?',
  'library.albumCount': '{count}曲',
  'library.albumHeader': '{label}({count}曲)',
  'library.backToAlbums': '← アルバム一覧へ',
  'library.deleteTrack': '削除',
  'library.deleteTrackTitle': '{title} を削除',

  // --- L2: 動的合成メッセージ(再生ボタン・コンパイル結果・サンプル/確認ダイアログ・
  // 下書き復元通知・ネットワーク読み込み状態・デバッグ見出し等)。
  'transport.dirtyHintSlash': '未コンパイルの変更があります(クリックでコンパイル&再生 / {hint})',
  'transport.compileAndPlay': 'コンパイル&再生 ({hint})',
  'transport.dirtyHintParen': '未コンパイルの変更があります(クリックでコンパイル&再生) ({hint})',
  'transport.playPending': '曲を再生 ({hint})',
  'transport.pause': '一時停止 ({hint})',
  'transport.resume': '再開 ({hint})',
  'transport.playIdle': '再生(曲を開いてください) ({hint})',

  'mml.compileSuccess': 'コンパイル成功',
  'mml.jumpToLine': 'クリックでMML {line}行目へ移動',
  'mml.emptyNotice': 'MMLが空です。何か入力してから再生してください。',
  'mml.playbackError': '再生エラー: {error}',
  'mml.caveatMissingRefs': 'この曲は {files} を参照していますが読み込めません。音色とドラムが本来と異なります。',

  'confirm.newFile': '編集中のMMLを消して新規作成します。この操作の直後であればCmd/Ctrl+Zで元に戻せます。よろしいですか?',
  'confirm.sampleReplace': '編集中のMMLをサンプルで置き換えます。元の内容はこの操作の直後であればCmd/Ctrl+Zで戻せます。よろしいですか?',

  'sample.furEliseLabel': 'エリーゼのために・冒頭',
  'sample.openHintPmd': '「曲を開く」から手元の.M/.mファイルを選ぶこともできます。',

  'restore.noteWithTime': '前回の続きを復元しました({time}保存)',
  'restore.note': '前回の続きを復元しました',

  'debug.trackTableHeading': 'デバッグ用テーブル(生のトラック状態、切り分け用に残す)',
  'debug.pchTableHeading': 'デバッグ用テーブル(生のPCHDATA、切り分け用に残す)',

  'net.dropMultiple': '複数のファイル({count}件)がドロップされましたが、1件目「{name}」のみ読み込みます',
  'net.loading': '読み込み中: {url}',
  'net.loadingProgress': '読み込み中: {loaded}/{total} bytes',
  'net.loadingProgressNoTotal': '読み込み中: {loaded} bytes',
  'net.noPmdCandidatesOther': 'この書庫にPMD(.M/.m)の曲は見つかりませんでした(他ドライバの曲が{otherCount}件見つかりました。?driver=mucom で開き直してください)',
  'net.noMucomCandidatesOther': 'この書庫にMUCOM88(.muc)の曲は見つかりませんでした(他ドライバの曲が{otherCount}件見つかりました。?driver=pmd で開き直してください)',
  'net.noPlayableSongs': 'この書庫の中に再生可能な曲が見つかりませんでした',
  'net.addedToLibrary': '{count}曲をライブラリに追加しました',
  'net.alreadyInLibrary': '{count}曲は既にライブラリにあります',
  'net.selectionCancelled': '曲の選択をキャンセルしました',
  'net.loadedReady': '読み込みました: {name}(再生ボタンを押してください)',
  'net.loadedReadyWithVoiceBank': '読み込みました: {name}(音色バンク: {source}、再生ボタンを押してください)',

  'mucom.encodingBadge': '文字コード判定: {label}(自動判定。クリックで切り替え)',
  'mucom.unresolvedVoiceNames': '\n[注意] 一部の音色名を解決できませんでした: {names}',
  'mucom.voiceBankInUse': '\n[情報] このディスクの音色バンク({source})を使用しています',
  'mucom.externalBankFallback': '外部バンク',

  'picker.ariaLabel': '曲を選択',
  'picker.title': '書庫の中から曲を選んでください({count}件見つかりました)',
  'picker.relatedFilesLabel': '関連ファイル: ',
  'picker.relatedFileDownloadTitle': 'クリックでダウンロード(#voice/#pcm等の付随ファイル。読み込みは別途手動で行ってください)',
  'picker.cancel': 'キャンセル',

  // --- L2: net/層のエラーをコード経由で表示するための辞書。net/*.js自体は
  // 文言を持たず(wasm/UIに依存しない素のモジュールという設計を壊さないため)、
  // err.code(例 'fetch.gotHtml')・err.params をそのままここへ渡す
  // (呼び出し側はui/net-error.jsのdescribeNetError()参照)。
  'net.error.unknown': '不明なエラーが発生しました',
  'net.error.fetch.proxyBadUrl': '中継サーバー経由での取得に失敗しました({url}): 不正なURLです',
  'net.error.fetch.proxyOriginNotAllowed': '中継サーバー経由での取得に失敗しました({url}): この配信元からの取得は許可されていません',
  'net.error.fetch.proxyHostNotAllowed': '中継サーバー経由での取得に失敗しました({url}): このホストからの取得は許可されていません',
  'net.error.fetch.proxyTooLarge': '中継サーバー経由での取得に失敗しました({url}): ファイルサイズが大きすぎます',
  'net.error.fetch.proxyRateLimited': '中継サーバー経由での取得に失敗しました({url}): リクエストが多すぎます。しばらく待って再試行してください',
  'net.error.fetch.proxyUpstreamFailed': '中継サーバー経由での取得に失敗しました({url}): 配信元からの取得に失敗しました',
  'net.error.fetch.proxyRedirectNotAllowed': '中継サーバー経由での取得に失敗しました({url}): リダイレクト先への取得は許可されていません',
  'net.error.fetch.proxyUnknown': '中継サーバー経由での取得に失敗しました({url}): 中継サーバーがエラーを返しました(status={status})',
  'net.error.fetch.gotHtml': '取得結果がHTMLページでした({url})。共有リンクの権限設定を確認してください',
  'net.error.fetch.oneDriveUnsupported': 'OneDriveの共有リンクは直接取得できません({url})。ダウンロードして手動で読み込んでください',
  'net.error.fetch.httpError': '取得に失敗しました({url}): HTTP {status}',
  'net.error.fetch.networkError': 'ネットワークエラーで取得できませんでした({url})',
  'net.error.fetch.hostUnsupported': 'このホストは直接取得できません({url})。中継サーバーの設定が必要です',
  'net.error.archive.unsupportedFormat': '未対応のアーカイブ形式です: {fileName}',
  'net.error.d88.trackOffsetOutOfRange': 'd88: トラックオフセットがファイル範囲外です(offset={offset})',
  'net.error.d88.fatSectorNotFound': 'd88: FATセクタ(R={r})が見つからないか256バイト未満です',
  'net.error.d88.fatDuplicateMismatch': 'd88: FATの複製(R={dupR})がR={r}と一致しません(offset={offset})',
  'net.error.d88.fatChainLoop': 'd88: FATチェーンにループを検出しました(cluster={cluster})',
  'net.error.d88.fatClusterOutOfRange': 'd88: FATチェーンのクラスタ番号が範囲外です(cluster={cluster})',
  'net.error.d88.fatChainUnusedMarker': 'd88: FATチェーンが未使用マーカーに到達しました(cluster={cluster})',
  'net.error.d88.fatChainTooLong': 'd88: FATチェーンが長すぎます(ループ検出の上限を超えました)',
  'net.error.d88.clusterTrackIndexOutOfRange': 'd88: クラスタ番号からトラックindexが範囲外になりました(cluster={cluster})',
  'net.error.d88.fileNotFound': 'd88: ファイルが見つかりません: {fileName}',
  'net.error.zip.eocdNotFound': 'ZIP: End Of Central Directory が見つかりません(不正なZIPファイルです)',
  'net.error.zip.centralDirSignatureInvalid': 'ZIP: Central Directory のシグネチャが不正です',
  'net.error.zip.localHeaderSignatureInvalid': 'ZIP: Local File Header のシグネチャが不正です ({name})',
  'net.error.zip.storedSizeMismatch': 'ZIP: 無圧縮(stored)エントリのサイズが一致しません ({name})',
  'net.error.zip.unsupportedMethod': 'ZIP: 未対応の圧縮方式です(method={method}) ({name})',
  'net.error.zip.crcMismatch': 'ZIP: CRC32が一致しません ({name}): 期待値={expected}, 実際={actual}',
  'net.error.lzh.huffmanBuildFailed': 'LZH: ハフマン木を構築できません(有効な符号長がありません)',
  'net.error.lzh.invalidHuffmanCode': 'LZH: 不正なハフマン符号を検出しました(ビットストリームが壊れています)',
  'net.error.lzh.corruptedDistance': 'LZH: 展開データが破損しています(参照距離が範囲外です)',
  'net.error.lzh.headerTruncated': 'LZH: ヘッダが途中で切れています',
  'net.error.lzh.unsupportedHeaderLevel': 'LZH: 未対応のヘッダレベルです(level={level})',
  'net.error.lzh.dataExceedsFile': 'LZH: 圧縮データがファイル末尾を超えています ({name})',
  'net.error.lzh.unsupportedMethod': 'LZH: 未対応の圧縮メソッドです: {methodId} ({name})',
  'net.error.lzh.crcMismatch': 'LZH: CRC16が一致しません ({name}): 期待値={expected}, 実際={actual}',
};

const en = {
  'page.title': 'FMSound — FM Sound MML Player',

  'toolbar.driverLabel': 'Sound driver:',
  'toolbar.langLabel': 'Language:',
  'toolbar.playPauseInitial': 'Compile & Play (⌘/Ctrl+Enter)',
  'toolbar.stop': 'Stop (Esc)',
  'toolbar.open': 'Open song',
  'toolbar.download': 'Download',
  'toolbar.settings': 'Settings',
  'toolbar.fullscreen': 'Fullscreen',
  'toolbar.fullscreenExit': 'Exit fullscreen',
  'toolbar.editorMode': 'Switch to editor mode',
  'toolbar.playerMode': 'Switch to player mode',
  'toolbar.newFile': 'New',
  'toolbar.library': 'Song library',

  'settings.title': 'Settings',
  'settings.sampleRate': 'Sample rate',
  'settings.calibrationMs': 'Sync calibration (ms)',
  'settings.syncDraw': 'Draw synced to audio',

  'openMenu.title': 'Open song',
  'openMenu.fromFile': 'Open from file',
  'openMenu.fromUrl': 'Open from URL',
  'openMenu.submit': 'Go',
  'openMenu.cancel': 'Cancel',

  'download.title': 'Download',
  'download.downloadBtn': 'Download',
  'download.mmlSection': 'MML source (current edits)',
  'download.encodingDefault': 'CP932 (default)',
  'download.encodingUtf8': 'UTF-8',
  'download.compiledSection': 'Compiled ({label})',
  'download.compileHint': 'Compile & play (or open a song) first',
  'download.asmSection': 'asm db array (for embedding into PC-98/PC-88 programs)',
  'download.cp932UnmappableAlert':
    'There are {count} character(s) that cannot be converted to CP932:\n{chars}\n\nChoose UTF-8, or fix the affected characters and try again.',

  'library.title': 'Song library',
  'library.titleWithCount': 'Song library ({count} tracks)',
  'library.unavailable': 'The song library is unavailable on this device (may be private browsing, or an unsupported environment).',
  'library.empty': 'No songs yet. Load one via URL or drag & drop, and it will stay here next time.',
  'library.clearAll': 'Delete all',
  'library.clearAllConfirm': 'This deletes all {count} song(s) in this player’s library. Are you sure?',
  'library.albumCount': '{count} tracks',
  'library.albumHeader': '{label} ({count} tracks)',
  'library.backToAlbums': '← Back to albums',
  'library.deleteTrack': 'Delete',
  'library.deleteTrackTitle': 'Delete {title}',

  'transport.dirtyHintSlash': 'Uncompiled changes (click to compile & play / {hint})',
  'transport.compileAndPlay': 'Compile & Play ({hint})',
  'transport.dirtyHintParen': 'Uncompiled changes (click to compile & play) ({hint})',
  'transport.playPending': 'Play song ({hint})',
  'transport.pause': 'Pause ({hint})',
  'transport.resume': 'Resume ({hint})',
  'transport.playIdle': 'Play (open a song first) ({hint})',

  'mml.compileSuccess': 'Compiled successfully',
  'mml.jumpToLine': 'Click to jump to line {line} of the MML',
  'mml.emptyNotice': 'The MML is empty. Enter something before playing.',
  'mml.playbackError': 'Playback error: {error}',
  'mml.caveatMissingRefs': 'This song references {files}, which cannot be loaded. The instrument tones and drums will differ from the original.',

  'confirm.newFile': 'This clears the MML you are editing and starts a new file. You can undo this with Cmd/Ctrl+Z right after. Continue?',
  'confirm.sampleReplace': 'This replaces the MML you are editing with the sample. You can undo this with Cmd/Ctrl+Z right after. Continue?',

  'sample.furEliseLabel': 'Für Elise, opening',
  'sample.openHintPmd': 'You can also choose a .M/.m file from your device via "Open song".',

  'restore.noteWithTime': 'Restored where you left off (saved at {time})',
  'restore.note': 'Restored where you left off',

  'debug.trackTableHeading': 'Debug table (raw track state, kept for troubleshooting)',
  'debug.pchTableHeading': 'Debug table (raw PCHDATA, kept for troubleshooting)',

  'net.dropMultiple': '{count} file(s) were dropped; only the first one, "{name}", will be loaded',
  'net.loading': 'Loading: {url}',
  'net.loadingProgress': 'Loading: {loaded}/{total} bytes',
  'net.loadingProgressNoTotal': 'Loading: {loaded} bytes',
  'net.noPmdCandidatesOther': 'No PMD (.M/.m) songs were found in this archive ({otherCount} song(s) for other drivers were found. Reopen with ?driver=mucom)',
  'net.noMucomCandidatesOther': 'No MUCOM88 (.muc) songs were found in this archive ({otherCount} song(s) for other drivers were found. Reopen with ?driver=pmd)',
  'net.noPlayableSongs': 'No playable songs were found in this archive',
  'net.addedToLibrary': 'Added {count} song(s) to the library',
  'net.alreadyInLibrary': '{count} song(s) are already in the library',
  'net.selectionCancelled': 'Song selection canceled',
  'net.loadedReady': 'Loaded: {name} (press the play button)',
  'net.loadedReadyWithVoiceBank': 'Loaded: {name} (voice bank: {source}, press the play button)',

  'mucom.encodingBadge': 'Detected encoding: {label} (auto-detected, click to switch)',
  'mucom.unresolvedVoiceNames': '\n[Note] Could not resolve some instrument names: {names}',
  'mucom.voiceBankInUse': '\n[Info] Using this disk\'s voice bank ({source})',
  'mucom.externalBankFallback': 'external bank',

  'picker.ariaLabel': 'Select a song',
  'picker.title': 'Choose a song from the archive ({count} found)',
  'picker.relatedFilesLabel': 'Related files: ',
  'picker.relatedFileDownloadTitle': 'Click to download (a #voice/#pcm sidecar file. Load it manually if needed)',
  'picker.cancel': 'Cancel',

  'net.error.unknown': 'An unknown error occurred',
  'net.error.fetch.proxyBadUrl': 'Failed to fetch via the relay server ({url}): invalid URL',
  'net.error.fetch.proxyOriginNotAllowed': 'Failed to fetch via the relay server ({url}): this origin is not allowed to fetch',
  'net.error.fetch.proxyHostNotAllowed': 'Failed to fetch via the relay server ({url}): this host is not allowed to fetch',
  'net.error.fetch.proxyTooLarge': 'Failed to fetch via the relay server ({url}): the file is too large',
  'net.error.fetch.proxyRateLimited': 'Failed to fetch via the relay server ({url}): too many requests. Please wait and try again',
  'net.error.fetch.proxyUpstreamFailed': 'Failed to fetch via the relay server ({url}): the source failed to respond',
  'net.error.fetch.proxyRedirectNotAllowed': 'Failed to fetch via the relay server ({url}): the redirect target is not allowed',
  'net.error.fetch.proxyUnknown': 'Failed to fetch via the relay server ({url}): the relay server returned an error (status={status})',
  'net.error.fetch.gotHtml': 'The response was an HTML page ({url}). Check the sharing permissions of the link',
  'net.error.fetch.oneDriveUnsupported': 'OneDrive share links cannot be fetched directly ({url}). Please download it and load it manually',
  'net.error.fetch.httpError': 'Failed to fetch ({url}): HTTP {status}',
  'net.error.fetch.networkError': 'Could not fetch due to a network error ({url})',
  'net.error.fetch.hostUnsupported': 'This host cannot be fetched directly ({url}). A relay server needs to be configured',
  'net.error.archive.unsupportedFormat': 'Unsupported archive format: {fileName}',
  'net.error.d88.trackOffsetOutOfRange': 'd88: track offset is out of file range (offset={offset})',
  'net.error.d88.fatSectorNotFound': 'd88: the FAT sector (R={r}) was not found or is under 256 bytes',
  'net.error.d88.fatDuplicateMismatch': 'd88: the FAT duplicate (R={dupR}) does not match R={r} (offset={offset})',
  'net.error.d88.fatChainLoop': 'd88: detected a loop in the FAT chain (cluster={cluster})',
  'net.error.d88.fatClusterOutOfRange': 'd88: FAT chain cluster number is out of range (cluster={cluster})',
  'net.error.d88.fatChainUnusedMarker': 'd88: the FAT chain reached an unused marker (cluster={cluster})',
  'net.error.d88.fatChainTooLong': 'd88: the FAT chain is too long (exceeded the loop-detection limit)',
  'net.error.d88.clusterTrackIndexOutOfRange': 'd88: the track index derived from the cluster number is out of range (cluster={cluster})',
  'net.error.d88.fileNotFound': 'd88: file not found: {fileName}',
  'net.error.zip.eocdNotFound': 'ZIP: End Of Central Directory not found (not a valid ZIP file)',
  'net.error.zip.centralDirSignatureInvalid': 'ZIP: the Central Directory signature is invalid',
  'net.error.zip.localHeaderSignatureInvalid': 'ZIP: the Local File Header signature is invalid ({name})',
  'net.error.zip.storedSizeMismatch': 'ZIP: the size of the stored (uncompressed) entry does not match ({name})',
  'net.error.zip.unsupportedMethod': 'ZIP: unsupported compression method (method={method}) ({name})',
  'net.error.zip.crcMismatch': 'ZIP: CRC32 mismatch ({name}): expected={expected}, actual={actual}',
  'net.error.lzh.huffmanBuildFailed': 'LZH: could not build a Huffman tree (no valid code lengths)',
  'net.error.lzh.invalidHuffmanCode': 'LZH: detected an invalid Huffman code (the bitstream is corrupted)',
  'net.error.lzh.corruptedDistance': 'LZH: the decompressed data is corrupted (the back-reference distance is out of range)',
  'net.error.lzh.headerTruncated': 'LZH: the header is truncated',
  'net.error.lzh.unsupportedHeaderLevel': 'LZH: unsupported header level (level={level})',
  'net.error.lzh.dataExceedsFile': 'LZH: the compressed data exceeds the end of the file ({name})',
  'net.error.lzh.unsupportedMethod': 'LZH: unsupported compression method: {methodId} ({name})',
  'net.error.lzh.crcMismatch': 'LZH: CRC16 mismatch ({name}): expected={expected}, actual={actual}',
};

export const DICT = { ja, en };

/**
 * URL(?lang=)とnavigator.languageから言語を決める。
 * 引数はテスト/Node向けの差し込み(既定はブラウザの実値)。
 */
export function detectLang(
  search = typeof location !== 'undefined' ? location.search : '',
  navLang = typeof navigator !== 'undefined' ? navigator.language : '',
) {
  const params = new URLSearchParams(search);
  const urlLang = params.get('lang');
  if (urlLang === 'ja' || urlLang === 'en') return urlLang;
  return navLang && navLang.toLowerCase().startsWith('ja') ? 'ja' : DEFAULT_LANG;
}

let currentLang = null;

/** ページ起動時に1回呼ぶ。以降 getLang()/t() はこの値を使う。 */
export function initLang() {
  currentLang = detectLang();
  return currentLang;
}

export function getLang() {
  return currentLang ?? detectLang();
}

export function setLang(lang) {
  if (LANGS.includes(lang)) currentLang = lang;
}

/**
 * 辞書引き。keyが無ければ警告してjaへフォールバックする(タイポ検出は
 * tools/verify_i18n.mjs側で静的に行うので、ここは実行時の保険)。
 * @param {string} key
 * @param {Record<string,string|number>} [params] - '{name}' プレースホルダの差し込み値
 */
export function t(key, params) {
  const lang = getLang();
  const dict = DICT[lang] ?? DICT[DEFAULT_LANG];
  let value = dict[key];
  if (value === undefined) {
    if (typeof console !== 'undefined') console.warn(`[i18n] missing key: ${key}`);
    value = DICT.ja[key] ?? key;
  }
  if (params) {
    for (const [name, v] of Object.entries(params)) {
      value = value.replaceAll(`{${name}}`, String(v));
    }
  }
  return value;
}

/**
 * data-i18n系属性を持つ要素へ一括で流し込む(index.htmlの静的ラベル向け)。
 *   data-i18n            -> textContent
 *   data-i18n-title      -> title + aria-label
 *   data-i18n-placeholder -> placeholder
 */
export function applyStaticI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  root.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const value = t(el.getAttribute('data-i18n-title'));
    el.title = value;
    el.setAttribute('aria-label', value);
  });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.placeholder = t(el.getAttribute('data-i18n-placeholder'));
  });
}
