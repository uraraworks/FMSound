// FMSound の ja/en 切替(辞書方式)。
//
// 設計(利用者指示、発明はしない):
//   - 英語のみへの置き換えではなく、日本語の辞書もここに残す。
//   - 言語の決定順(2026-08-16改定): (1) 記憶した選択(localStorage、明示的に
//     選んだときだけ書き込む。下記参照) (2) URLの?lang=ja/?lang=en(この2値以外は
//     無視) (3) navigator.languageが'ja'始まりならja、それ以外はen。
//     記憶がURLに勝つ(利用者の明示的な選択のほうが、投稿者の言語を反映しただけの
//     URLより優先される、という利用者判断)。
//   - 記憶するのは「利用者が明示的にトグルを操作したとき」だけ。初回訪問時の
//     navigator.languageによる自動判定の結果は保存しない(選んでいないものを
//     選択として焼き付けないため)。そのため initLang() 自体はstoreLang()を呼ばない。
//   - ?lang= は「まだ選んだことのない人への初期値のヒント」という役割だけを持つ設計。
//     結果として?lang=は普段URLに現れない: トグル操作時は記憶してreloadするだけで
//     ?lang=を足さず(足す方向の同期は絶対にしない)、逆に?lang=が付いていて記憶した
//     選択と食い違う場合は history.replaceState でURLから取り除く(表示と食い違った
//     まま転送されるのを防ぐ。他のクエリパラメータ、特に?driver=は保持する)。
//   - このモジュール自体はビルド不要の素のES module(依存追加なし)。
//   - tools/verify_i18n.mjs がNode(ブラウザではない)からこのファイルをそのまま
//     importして辞書の整合性を検証する。そのため、モジュール評価の副作用として
//     `location`/`navigator`/`localStorage` に触れてはいけない(Nodeには存在せず
//     即クラッシュする)。参照は detectLang() 等の関数の「呼び出し時」に限定する。
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
  // 2026-08-16(利用者判断): aria-labelは「現在のUI言語」ではなく「押したら切り替わる
  // 先の言語」で書く(ボタンの可視文字=langToggleLabel()と言語を揃えるため)。
  // そのためja辞書の値が英語、en辞書の値が日本語という一見逆の対応になる
  // (tools/verify_i18n.mjs項目3の「enの値に日本語が無いこと」は値そのものの言語では
  // なく「翻訳し忘れて日本語のまま残っていないか」を見る検査なので、enのこの値が
  // 意図的に日本語であることは想定内。同スクリプト側にコメントで注記する)。
  'toolbar.langToggleAriaLabel': 'Switch to English',
  'toolbar.playPauseInitial': 'コンパイル&再生 (⌘/Ctrl+Enter)',
  'toolbar.stop': '停止 (Esc)',
  'toolbar.open': '曲を開く',
  'toolbar.share': 'リンクをコピー',
  'toolbar.download': 'ダウンロード',
  'toolbar.settings': '設定',
  'toolbar.fullscreen': 'フルスクリーン',
  'toolbar.fullscreenExit': 'フルスクリーン解除',
  'toolbar.editorMode': 'エディタモードへ切替',
  'toolbar.playerMode': 'プレイヤーモードへ切替',
  'toolbar.newFile': '新規作成',
  'toolbar.library': '曲ライブラリ',
  'toolbar.help': '使い方',

  // --- html/help.html(使い方ページ)のUI由来ラベル。本文(長文)は辞書に入れず
  // data-lang="ja"/"en"のHTML2ブロック方式にする(html/help.htmlのコメント参照)ので、
  // ここに載るのはヘッダー・戻るリンクなどの短い固定ラベルのみ。
  'help.pageTitle': '使い方',
  'help.backToApp': '← アプリに戻る',

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
  // --- 2026-08-16: 参照しているタグの種類で分ける(利用者指示)。#voiceだけなら
  // 音色のみ、#pcm(非標準バンク)だけならドラム(ADPCM)のみ、両方なら両方に言及する。
  // ui/mml-caveats.js formatMmlCaveatMessage() がmissingRefsのtagを見て呼び分ける。
  'mml.caveatMissingRefsVoice': 'この曲は {files} を参照していますが読み込めません。音色が本来と異なります。',
  'mml.caveatMissingRefsPcm': 'この曲は {files} を参照していますが読み込めません。ドラム(ADPCM)が本来と異なります。',
  'mml.caveatMissingRefsBoth': 'この曲は {files} を参照していますが読み込めません。音色とドラムが本来と異なります。',

  // --- PMDのPCM(.PPC/.PZI/.PVI/.P86/.PPS)読み込み状態。net/pmd-pcm.jsの
  // describePmdPcmStatus()が生成キーを決め、html/pmd-app.jsがnet.*と同じ
  // setNetStatus()経由で表示する(net.*ではないがこの表示枠を流用しているだけ)。
  'pmd.pcm.missing': 'この曲は {files} を必要としますが読み込めていません。PCMパートは鳴りません。PCMファイルを曲と同じ書庫(zip等)に入れて開いてください。なおPMD86(.P86)とPPSDRV(.PPS)のPCMは未対応です。',
  'pmd.pcm.ppsUnsupported': 'この曲はPPSDRV({files})を使いますが未対応です。そのパートは鳴りません。',
  'pmd.pcm.p86Unsupported': 'この曲はPMD86のPCM({files})を使いますが未対応です。PCMパートは鳴りません。',
  'pmd.editor.noMmlSource': 'この曲にはMMLソースが無いため編集できません。編集欄には別の曲のMMLが入っています。',

  // --- 外部音色ファイル(.FF、`#FFFile`)の選択状態。net/pmd-ff.js
  // describePmdFfStatus()が生成キーを決め、pmd.pcm.*と同じsetNetStatus()経由で表示する。
  'pmd.ff.missing': 'この曲は外部音色ファイル({file})を必要としますが見つかりませんでした。音色(@)が本文で定義されていないパートはコンパイルできません。.FFファイルを曲と同じ書庫に入れて開いてください。',
  'pmd.ff.nameMismatch': 'この曲が指定する外部音色ファイル({wanted})が見つからなかったため、代わりに{used}を使用しています。音色が本来と異なる可能性があります。',

  // --- プレイヤーモードの再生案内。
  // 再生できる対象が無いのに再生ボタンが押されたとき(例: 新規作成したMMLのまま
  // プレイヤーモードに戻り、まだ一度もコンパイルしていない場合)の案内。
  'pmd.player.noSongToPlay': '再生できる曲がありません。編集モードでMMLをコンパイルしてから再生してください。',
  // 「編集を閉じていたら元のデータ」の原則により、プレイヤーモードでは同梱の.mを
  // 再生する。コンパイル結果も手元にある(=一度でも編集モードでコンパイルした後)
  // ときだけ、どちらが鳴っているかを案内する(html/pmd-app.js playBytes()参照。
  // 常に出すと聴くだけの利用者の邪魔になるため、曖昧なときに限定している)。
  'pmd.player.playingBundled': '同梱されている .m ファイルを再生します。',

  'confirm.newFile': '編集中のMMLを消して新規作成します。この操作の直後であればCmd/Ctrl+Zで元に戻せます。よろしいですか?',
  'confirm.sampleReplace': '編集中のMMLをサンプルで置き換えます。元の内容はこの操作の直後であればCmd/Ctrl+Zで戻せます。よろしいですか?',
  'confirm.songMmlReplace': '編集中のMMLを、選んだ曲のMMLで置き換えます。元の内容はこの操作で失われます。',
  'confirm.shareLinkLoad': '編集中のMMLを共有リンクの内容で置き換えます。よろしいですか?',

  'sample.mmlLabel': 'サンプルMML:',
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

  // --- 共有リンク(URLフラグメント`#s1=...`)からの読み込み ---
  'net.loadedFromShareLink': '共有リンクから曲を読み込みました(再生ボタンを押してください)',

  'mucom.encodingBadge': '文字コード判定: {label}(自動判定。クリックで切り替え)',
  'mucom.unresolvedVoiceNames': '\n[注意] 一部の音色名を解決できませんでした: {names}',
  'mucom.voiceBankInUse': '\n[情報] このディスクの音色バンク({source})を使用しています',
  'mucom.externalBankFallback': '外部バンク',
  'mucom.player.notReadyYet': 'まだ準備中です。エンジンの読み込みが終わってからもう一度お試しください。',

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

  // --- 共有リンク(URLフラグメント`#s1=...`、net/share-link.js)のUI文言。
  // ツールバーの「リンクをコピー」ボタン・常時表示の文字数カウンタ+ゲージ・
  // コピー失敗時のフォールバック欄・音色バンク依存の警告(MUCOM88のみ)で使う。
  'share.counterLabel': '共有リンクの文字数',
  // 「未集計」表示(mmlDirtyが真の間、コンパイル前に古い数字を出さないための表示)。
  'share.counterPending': '未集計',
  'share.counterAriaLabel': '共有リンクの文字数: {length} / {limit}',
  'share.counterPendingAriaLabel': '共有リンクの文字数: 未集計(コンパイル&再生すると集計されます)',
  // 上限超過時、ボタンの無効化理由とあわせて超過字数を数字で示す(「長すぎます」だけでは
  // どれだけ削ればよいか分からないため、利用者指示)。
  'share.overLimit': '{length}字／上限{limit}字。{overBy}字ぶん超えています',
  'share.copied': 'コピーしました',
  // クリップボードAPIが使えない/拒否された場合だけ表示するフォールバック(下の
  // 読み取り専用テキスト欄を指す文言。普段は出さない)。
  'share.copyFailed': 'コピーできませんでした。下の欄を選択してコピーしてください',
  'share.fallbackInputAriaLabel': '共有リンク(コピーできなかったため表示しています)',
  // MUCOM88のみ: ディスク固有の音色バンクを使っている曲を共有すると、受け取った側には
  // 対になるディスクが無いため音色が既定のものに変わる(利用者指示、常時は出さず
  // 共有時にこの場合だけ出す)。
  'share.voiceBankWarning': 'この曲はディスク固有の音色バンクを使っています。共有リンクを開いた相手の環境には対になるディスクが無いため、音色が既定のものに変わります。',

  // --- 共有リンク(net/share-link.js)のエラー。net/error.*と同じ作法(err.code+params、
  // ui/net-error.js describeNetError()経由)。フラグメントは第三者が作ったリンクから
  // 来うるため、無言で失敗させず必ずここへ落とす。
  'net.error.share.malformed': '共有リンクの形式が不正です(バージョン部分が見つかりません)',
  'net.error.share.unknownVersion': '未対応の形式の共有リンクです(バージョン: {version})。新しいFMSoundで作られたリンクの可能性があります',
  'net.error.share.invalidBase64': '共有リンクのデータが壊れています(base64として不正です)',
  'net.error.share.invalidGzip': '共有リンクのデータが壊れています(圧縮データとして不正です)',
  'net.error.share.decodedTooLarge': '共有リンクのデータが大きすぎます(展開後のサイズが上限{limit}バイトを超えました)',
};

const en = {
  'page.title': 'FMSound — FM Sound MML Player',

  'toolbar.driverLabel': 'Sound driver:',
  'toolbar.langLabel': 'Language:',
  // 意図的に日本語(訳し忘れではない、ja側のコメント参照。
  // tools/verify_i18n.mjs 項目3のI18N_DIRECTION_EXEMPT_KEYS対象)。
  'toolbar.langToggleAriaLabel': '日本語に切り替える',
  'toolbar.playPauseInitial': 'Compile & Play (⌘/Ctrl+Enter)',
  'toolbar.stop': 'Stop (Esc)',
  'toolbar.open': 'Open song',
  'toolbar.share': 'Copy link',
  'toolbar.download': 'Download',
  'toolbar.settings': 'Settings',
  'toolbar.fullscreen': 'Fullscreen',
  'toolbar.fullscreenExit': 'Exit fullscreen',
  'toolbar.editorMode': 'Switch to editor mode',
  'toolbar.playerMode': 'Switch to player mode',
  'toolbar.newFile': 'New',
  'toolbar.library': 'Song library',
  'toolbar.help': 'Help',

  'help.pageTitle': 'Help',
  'help.backToApp': '← Back to the app',

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
  'mml.caveatMissingRefsVoice': 'This song references {files}, which cannot be loaded. The instrument tones will differ from the original.',
  'mml.caveatMissingRefsPcm': 'This song references {files}, which cannot be loaded. The drums (ADPCM) will differ from the original.',
  'mml.caveatMissingRefsBoth': 'This song references {files}, which cannot be loaded. The instrument tones and drums will differ from the original.',

  'pmd.pcm.missing': 'This song requires {files}, which could not be loaded. Its PCM parts will be silent. Put the PCM file in the same archive (zip, etc.) as the song and open it again. Note that PMD86 (.P86) and PPSDRV (.PPS) PCM are not supported.',
  'pmd.pcm.ppsUnsupported': 'This song uses PPSDRV ({files}), which is not supported. That part will be silent.',
  'pmd.pcm.p86Unsupported': 'This song uses PMD86 PCM ({files}), which is not supported. Its PCM parts will be silent.',
  'pmd.editor.noMmlSource': "This song has no MML source, so it cannot be edited. The editor contains a different song's MML.",

  'pmd.ff.missing': 'This song requires an external voice file ({file}), which could not be found. Parts whose voice (@) is not defined in the body cannot be compiled. Put the .FF file in the same archive as the song and open it again.',
  'pmd.ff.nameMismatch': 'This song specifies an external voice file ({wanted}), which could not be found. Using {used} instead — the voices may differ from the original.',

  'pmd.player.noSongToPlay': 'There is no song to play. Switch to editor mode and compile your MML first.',
  'pmd.player.playingBundled': 'Playing the bundled .m file.',

  'confirm.newFile': 'This clears the MML you are editing and starts a new file. You can undo this with Cmd/Ctrl+Z right after. Continue?',
  'confirm.sampleReplace': 'This replaces the MML you are editing with the sample. You can undo this with Cmd/Ctrl+Z right after. Continue?',
  'confirm.songMmlReplace': "The MML in the editor will be replaced with the selected song's MML. Your current content will be lost.",
  'confirm.shareLinkLoad': 'This replaces the MML you are editing with the content of the shared link. Continue?',

  'sample.mmlLabel': 'Sample MML:',
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

  'net.loadedFromShareLink': 'Loaded a song from a share link (press the play button)',

  'mucom.encodingBadge': 'Detected encoding: {label} (auto-detected, click to switch)',
  'mucom.unresolvedVoiceNames': '\n[Note] Could not resolve some instrument names: {names}',
  'mucom.voiceBankInUse': '\n[Info] Using this disk\'s voice bank ({source})',
  'mucom.externalBankFallback': 'external bank',
  'mucom.player.notReadyYet': 'Still starting up. Please try again once the engine finishes loading.',

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

  'share.counterLabel': 'Share link length',
  'share.counterPending': 'not counted yet',
  'share.counterAriaLabel': 'Share link length: {length} / {limit}',
  'share.counterPendingAriaLabel': 'Share link length: not counted yet (counted after compile & play)',
  'share.overLimit': '{length} chars / {limit} limit. {overBy} chars over',
  'share.copied': 'Copied',
  'share.copyFailed': "Couldn't copy automatically. Select the field below to copy it",
  'share.fallbackInputAriaLabel': 'Share link (shown because it could not be copied automatically)',
  'share.voiceBankWarning': "This song uses a disk-specific voice bank. Whoever opens the shared link won't have the matching disk, so the instrument sounds will change to the defaults.",

  'net.error.share.malformed': 'This share link is malformed (no version segment found)',
  'net.error.share.unknownVersion': 'This share link uses an unsupported format (version: {version}). It may have been created by a newer version of FMSound',
  'net.error.share.invalidBase64': 'This share link\'s data is corrupted (invalid base64)',
  'net.error.share.invalidGzip': 'This share link\'s data is corrupted (invalid compressed data)',
  'net.error.share.decodedTooLarge': 'This share link\'s data is too large (decoded size exceeded the {limit}-byte limit)',
};

export const DICT = { ja, en };

// 言語切替ボタンの表示文字(endonym、言語名は選択中のUI言語に関わらずその言語自身の
// 表記で出す)。2026-08-16(利用者判断): 2ボタン(JA/EN)から1つのトグルボタンへ変更し、
// ボタンには「押したら切り替わる先の言語」を出す(現在の状態でなく操作の結果を示す)。
// 言語名は翻訳の対象ではなく常に固定表記なのでDICTには入れない(旧html側の
// i18n-exemptコメントと同じ理由)。
const LANG_ENDONYMS = { ja: '日本語', en: 'English' };

/**
 * 現在の言語から切り替え先の言語コードを返す純粋関数。LANGSが2つしかないことに
 * 依存する単純な反転(3言語以上に増える場合は要見直し)。
 */
export function otherLang(lang) {
  return lang === 'ja' ? 'en' : 'ja';
}

/**
 * 言語切替ボタンに表示する文字列を返す純粋関数(テスト対象、
 * tools/verify_lang_toggle_label.mjs参照)。「現在の言語」ではなく「押したら
 * 切り替わる先の言語」をendonymで返す。ja→'English'、en→'日本語'になり、
 * 現在の言語と同じ文字列は返さない(これが今回の変更の要点)。
 */
export function langToggleLabel(lang) {
  return LANG_ENDONYMS[otherLang(lang)];
}

// 記憶した選択の保存先。html/*.jsの他のlocalStorageキー(fmsound-pmd-ui-mode等)と
// 同じ命名作法('fmsound-'接頭辞)に合わせる。
export const LANG_STORAGE_KEY = 'fmsound-lang';

/**
 * localStorageから記憶した選択を読む(ja/en以外・未設定はnull)。
 * private mode等でlocalStorage自体が使えない場合もnull(既存作法、
 * ui/mml-draft.js・html/pmd-app.js等のUI_MODE_KEY読み書きと同じベストエフォート)。
 */
function readStoredLang() {
  try {
    const raw = localStorage.getItem(LANG_STORAGE_KEY);
    return raw === 'ja' || raw === 'en' ? raw : null;
  } catch {
    return null;
  }
}

/**
 * 記憶する選択を書く。呼び出しは「利用者が明示的にトグルを操作したとき」限定
 * (ファイル冒頭のコメント参照)。initLang()の自動判定からは呼ばない。
 */
export function storeLang(lang) {
  if (!LANGS.includes(lang)) return;
  try {
    localStorage.setItem(LANG_STORAGE_KEY, lang);
  } catch {
    // private mode等。保存できないだけで、その場の表示自体は継続できる。
  }
}

/**
 * 記憶した選択・URL(?lang=)・navigator.languageから言語を決める。
 * 優先順位: 記憶 > URL > navigator.language(ファイル冒頭のコメント参照)。
 * 引数はテスト/Node向けの差し込み(既定はブラウザの実値)。
 */
export function detectLang(
  search = typeof location !== 'undefined' ? location.search : '',
  navLang = typeof navigator !== 'undefined' ? navigator.language : '',
  storedLang = typeof localStorage !== 'undefined' ? readStoredLang() : null,
) {
  if (storedLang === 'ja' || storedLang === 'en') return storedLang;
  const params = new URLSearchParams(search);
  const urlLang = params.get('lang');
  if (urlLang === 'ja' || urlLang === 'en') return urlLang;
  return navLang && navLang.toLowerCase().startsWith('ja') ? 'ja' : DEFAULT_LANG;
}

/**
 * 現在のURLと決定した言語から、次に表示すべきURLを返す純粋関数(テスト用に分離)。
 * ?lang= がURLに付いていて、それが決定した言語と異なる場合だけ ?lang= を取り除いた
 * URLを返す(表示と食い違ったまま転送されるのを防ぐため)。それ以外(?lang=が無い、
 * または一致している)は入力をそのまま返す。他のクエリパラメータ(?driver=等)には
 * 一切触れない。足す方向の同期は行わない(?lang=が無い状態を維持する)。
 * @param {string} currentUrl - 絶対URL文字列(new URL()に渡せるもの)
 * @param {string} decidedLang - detectLang()の結果
 * @returns {string}
 */
export function computeLangSyncUrl(currentUrl, decidedLang) {
  const url = new URL(currentUrl);
  const urlLang = url.searchParams.get('lang');
  if (urlLang !== null && urlLang !== decidedLang) {
    url.searchParams.delete('lang');
    return url.toString();
  }
  return currentUrl;
}

/**
 * アプリ内ナビゲーション用リンク(html/app.jsのヘルプボタン、html/help.htmlの
 * 「アプリに戻る」リンク)にだけ使う。「?lang=はURLに足さない」という方針
 * (このファイル冒頭のコメント参照)は共有される・アドレスバーに残るURL向けであり、
 * 別ページへ移動した瞬間に表示言語が(記憶にもURLにも無いnavigator.language頼みへ
 * フォールバックして)食い違うのを防ぐための例外。渡す lang は呼び出し側の
 * getLang()相当の実効値(記憶 > ?lang= > navigator.languageで決まった結果)であること。
 * href に既存のクエリが無い前提の単純な連結(このリポジトリ内の呼び出し元は
 * './help.html' '/index.html' 等、疑問符を含まない相対パスのみ)。
 * @param {string} href
 * @param {string} lang
 * @returns {string}
 */
export function withLangParam(href, lang) {
  const sep = href.includes('?') ? '&' : '?';
  return `${href}${sep}lang=${lang}`;
}

let currentLang = null;

/**
 * ページ起動時に1回呼ぶ。以降 getLang()/t() はこの値を使う。
 * 記憶した選択とURL(?lang=)が食い違う場合は、history.replaceState()で
 * ?lang=をURLから取り除く(computeLangSyncUrl参照)。
 */
export function initLang() {
  const storedLang = readStoredLang();
  currentLang = detectLang(
    typeof location !== 'undefined' ? location.search : '',
    typeof navigator !== 'undefined' ? navigator.language : '',
    storedLang,
  );
  if (typeof location !== 'undefined' && typeof history !== 'undefined') {
    const nextHref = computeLangSyncUrl(location.href, currentLang);
    if (nextHref !== location.href) history.replaceState(null, '', nextHref);
  }
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
