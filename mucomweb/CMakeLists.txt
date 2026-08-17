cmake_minimum_required(VERSION 3.13)
project(mucom88)

set(CMAKE_CXX_STANDARD 17)

# mucom88 本体は aosoft/MucomWeb が抱える専用フォルクを参照する。
# 兄弟ディレクトリの ../upstream/mucom88（OpenMucom88 本家クローン）とは
# 別系統・非互換（cmucom.h/mucom_module.cpp 等の中身が大きく異なる）なので
# 絶対に混同しないこと。こちらは無改変のまま参照専用に使う。
set(MUCOM88_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../upstream/MucomWeb/mucom88")

# FMDSP右半分のスペクトラムアナライザ(70ビン)用。pmdweb/CMakeLists.txtと同じ
# 98fmplayer(BSD 2-Clause、NOTICE.md参照)由来のfft.cを無改変のまま取り込む。
set(FFT_UPSTREAM_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../upstream/98fmplayer")

# upstream/MucomWeb/mucom88 は無改変クローンとして扱いたいが、CMucom::vm への
# アクセサだけは FMDSP側の playing/panpot 実測に必須（詳細は
# mucomweb/patches/0001-cmucom-expose-vm.patch のコメント、
# docs/mucom-pchdata-mapping.md参照）。冪等に当てる: 「reverse --check」が
# 成功する（＝既に当たっている）ならスキップ、失敗するなら apply する。
# apply 自体が失敗したら警告ではなくビルドを失敗させる（無言で古い挙動へ
# 戻ると気づけないため）。
set(CMUCOM_PATCH "${CMAKE_CURRENT_SOURCE_DIR}/patches/0001-cmucom-expose-vm.patch")
execute_process(
    COMMAND git apply --reverse --check "${CMUCOM_PATCH}"
    WORKING_DIRECTORY "${MUCOM88_DIR}"
    RESULT_VARIABLE CMUCOM_PATCH_ALREADY_APPLIED
    OUTPUT_QUIET ERROR_QUIET)
if (NOT CMUCOM_PATCH_ALREADY_APPLIED EQUAL 0)
    execute_process(
        COMMAND git apply "${CMUCOM_PATCH}"
        WORKING_DIRECTORY "${MUCOM88_DIR}"
        RESULT_VARIABLE CMUCOM_PATCH_APPLY_RESULT)
    if (NOT CMUCOM_PATCH_APPLY_RESULT EQUAL 0)
        message(FATAL_ERROR
            "0001-cmucom-expose-vm.patch を ${MUCOM88_DIR} に適用できませんでした。"
            "upstream/MucomWeb/mucom88/src/cmucom.h が想定と異なる可能性があります。"
            "手動確認してください（警告で済ませず失敗させています）。")
    endif()
endif()

# fmgenにチャンネル単位のレベル追従(leveldata相当)が無いため、FMDSPのレベル
# メーター(19ch、docs/right-pane-data.md参照)をMUCOM側で本物にするには
# fmgen自体にピーク追従を差し込む必要がある。0001と同じ冪等適用の仕組み。
set(FMGEN_LEVELDATA_PATCH "${CMAKE_CURRENT_SOURCE_DIR}/patches/0002-fmgen-leveldata.patch")
execute_process(
    COMMAND git apply --reverse --check "${FMGEN_LEVELDATA_PATCH}"
    WORKING_DIRECTORY "${MUCOM88_DIR}"
    RESULT_VARIABLE FMGEN_LEVELDATA_PATCH_ALREADY_APPLIED
    OUTPUT_QUIET ERROR_QUIET)
if (NOT FMGEN_LEVELDATA_PATCH_ALREADY_APPLIED EQUAL 0)
    execute_process(
        COMMAND git apply "${FMGEN_LEVELDATA_PATCH}"
        WORKING_DIRECTORY "${MUCOM88_DIR}"
        RESULT_VARIABLE FMGEN_LEVELDATA_PATCH_APPLY_RESULT)
    if (NOT FMGEN_LEVELDATA_PATCH_APPLY_RESULT EQUAL 0)
        message(FATAL_ERROR
            "0002-fmgen-leveldata.patch を ${MUCOM88_DIR} に適用できませんでした。"
            "upstream/MucomWeb/mucom88/src/fmgen/{opna,psg}.{h,cpp} または "
            "src/mucomvm.h が想定と異なる可能性があります。"
            "手動確認してください（警告で済ませず失敗させています）。")
    endif()
endif()

# リズム(G)パートを鳴らすため、mucomvm::InitSoundSystem()のOPNA::Init呼び出しに
# rhythmpath("/rhythm/"固定、html/mucom-app.jsがコンパイル前にMEMFSへ6本のWAVを
# 書き込む)を渡す。理由の詳細はmucomweb/patches/0003-mucomvm-rhythm-path.patchの
# コメントとdocs/rhythm-feasibility.md参照。0001/0002と同じ冪等適用の仕組み。
set(RHYTHM_PATH_PATCH "${CMAKE_CURRENT_SOURCE_DIR}/patches/0003-mucomvm-rhythm-path.patch")
execute_process(
    COMMAND git apply --reverse --check "${RHYTHM_PATH_PATCH}"
    WORKING_DIRECTORY "${MUCOM88_DIR}"
    RESULT_VARIABLE RHYTHM_PATH_PATCH_ALREADY_APPLIED
    OUTPUT_QUIET ERROR_QUIET)
if (NOT RHYTHM_PATH_PATCH_ALREADY_APPLIED EQUAL 0)
    execute_process(
        COMMAND git apply "${RHYTHM_PATH_PATCH}"
        WORKING_DIRECTORY "${MUCOM88_DIR}"
        RESULT_VARIABLE RHYTHM_PATH_PATCH_APPLY_RESULT)
    if (NOT RHYTHM_PATH_PATCH_APPLY_RESULT EQUAL 0)
        message(FATAL_ERROR
            "0003-mucomvm-rhythm-path.patch を ${MUCOM88_DIR} に適用できませんでした。"
            "upstream/MucomWeb/mucom88/src/mucomvm.cpp が想定と異なる可能性があります。"
            "手動確認してください（警告で済ませず失敗させています）。")
    endif()
endif()

# CMucom::GetTextLine()(cmucom.cpp)がCMucomメンバ配列linebuf[512]へ範囲チェック
# 無しに書き込んでおり、3種類のMMLを跨いで繰り返しコンパイルすると(実測440回目)
# メモリ破壊でクラッシュする不具合への対症療法。原因(なぜ終端されていないデータを
# 踏むか)は未解明のまま、範囲チェックだけを足して「メモリ破壊」を「行の切り詰め」
# という安全な壊れ方に変える。詳細はpatches/0005-cmucom-gettextline-bounds.patchの
# コメントとdocs/参照。0001-0003と同じ冪等適用の仕組み。
set(GETTEXTLINE_BOUNDS_PATCH "${CMAKE_CURRENT_SOURCE_DIR}/patches/0005-cmucom-gettextline-bounds.patch")
execute_process(
    COMMAND git apply --reverse --check "${GETTEXTLINE_BOUNDS_PATCH}"
    WORKING_DIRECTORY "${MUCOM88_DIR}"
    RESULT_VARIABLE GETTEXTLINE_BOUNDS_PATCH_ALREADY_APPLIED
    OUTPUT_QUIET ERROR_QUIET)
if (NOT GETTEXTLINE_BOUNDS_PATCH_ALREADY_APPLIED EQUAL 0)
    execute_process(
        COMMAND git apply "${GETTEXTLINE_BOUNDS_PATCH}"
        WORKING_DIRECTORY "${MUCOM88_DIR}"
        RESULT_VARIABLE GETTEXTLINE_BOUNDS_PATCH_APPLY_RESULT)
    if (NOT GETTEXTLINE_BOUNDS_PATCH_APPLY_RESULT EQUAL 0)
        message(FATAL_ERROR
            "0005-cmucom-gettextline-bounds.patch を ${MUCOM88_DIR} に適用できませんでした。"
            "upstream/MucomWeb/mucom88/src/cmucom.cpp が想定と異なる可能性があります。"
            "手動確認してください（警告で済ませず失敗させています）。")
    endif()
endif()

# #voice(外部音色バンク)対応。CompileMML()がProcessHeader()を呼ばないと
# CMucom::Compile()のGetInfoBufferByName("voice")が常に空を見て#voiceタグが
# 無視される(詳細はpatches/0004-compilemml-processheader.patchのコメントと
# docs/voice-external-bank-experiment.md参照)。
#
# 0001-0003と違い、このパッチの対象(mucomweb/src/MucomWeb.cpp)は upstream/ 配下の
# 無改変クローンではなく、FMSound本体が直接git管理しているファイルなので、
# 冪等適用の基準にする対象は MUCOM88_DIR ではなくリポジトリルート(このファイルの
# 1つ上、mucomweb/../)。ProcessHeader()呼び出し自体は既にMucomWeb.cppへ直接
# コミット済みなので、通常のビルドでは「reverse --check」が成功(=既に当たっている)
# して何もしない。ここでの適用ステップは、万一その行だけが取り除かれた場合に
# 気付かず古い挙動(#voice無視)へ戻ってしまうことを防ぐ保険(0001-0003と同じ
# 「警告でなく失敗させる」考え方)。
set(VOICE_HEADER_PATCH "${CMAKE_CURRENT_SOURCE_DIR}/patches/0004-compilemml-processheader.patch")
set(FMSOUND_REPO_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/..")
execute_process(
    COMMAND git apply --reverse --check "${VOICE_HEADER_PATCH}"
    WORKING_DIRECTORY "${FMSOUND_REPO_ROOT}"
    RESULT_VARIABLE VOICE_HEADER_PATCH_ALREADY_APPLIED
    OUTPUT_QUIET ERROR_QUIET)
if (NOT VOICE_HEADER_PATCH_ALREADY_APPLIED EQUAL 0)
    execute_process(
        COMMAND git apply "${VOICE_HEADER_PATCH}"
        WORKING_DIRECTORY "${FMSOUND_REPO_ROOT}"
        RESULT_VARIABLE VOICE_HEADER_PATCH_APPLY_RESULT)
    if (NOT VOICE_HEADER_PATCH_APPLY_RESULT EQUAL 0)
        message(FATAL_ERROR
            "0004-compilemml-processheader.patch を ${FMSOUND_REPO_ROOT} に適用できませんでした。"
            "mucomweb/src/MucomWeb.cpp が想定と異なる可能性があります。"
            "手動確認してください（警告で済ませず失敗させています）。")
    endif()
endif()

file(GLOB SOURCES
        ${MUCOM88_DIR}/src/*.c
        ${MUCOM88_DIR}/src/*.cpp
        ${MUCOM88_DIR}/src/dummy/*.cpp
        ${MUCOM88_DIR}/src/fmgen/*.cpp
        ${MUCOM88_DIR}/src/module/*.cpp
        ${MUCOM88_DIR}/src/plugin/*.cpp
        ${MUCOM88_DIR}/src/Z80/*.cpp
        src/*.cpp)

list(APPEND SOURCES "${FFT_UPSTREAM_DIR}/fft/fft.c")

# mucomerror_utf8.cpp(アップストリームがmucomerror.cppの日本語部分を「見た目を保った
# ままUTF-8へ変換」して作った版)ではなく無印のmucomerror.cpp(CP932)を使う。
# orgmsg[](ゲストがエラー時にVRAM/メモリへ書き出す半角カナメッセージと1バイト単位で
# strcmp照合するテーブル)がmucomerror_utf8.cppではUTF-8の3バイト表現へ変換されてしまい
# 一致しなくなっている(実測で確認: mucomerror_utf8.cpp使用時はどんなMMLエラーでも
# mucom_geterror()が常に0を返し、cmucom.cppの正しいエラー経路
# 「#error %d in line %d. -> 日本語(English)」に一切入れない)。CMucomの出力
# (GetMessageBuffer())は、ROM側が書くゲスト文字列(#Unknown messageのフォールバック分、
# 常にCP932/JIS X0201の半角カナ1バイト表現)とerr_jpn[]/err[](本来PRINTFで書く分)が
# 同じバッファに混在するため、バッファ全体を単一エンコーディングとして扱うには
# 「全部CP932」に統一するしかない(UTF-8化した部分だけ生き残らせる方式は、ゲスト側の
# 生バイトが必ずCP932である以上バッファ全体としては両立しない)。したがって
# mucomerror.cpp(CP932)を採用し、JS側(mucomweb/html/index.html)でバッファ全体を
# TextDecoder('shift_jis')でデコードする(MMLロード時の既存経路と同じ作法)。
list(FILTER SOURCES EXCLUDE REGEX "/mucom88/src/mucomerror_utf8.cpp")

if (EMSCRIPTEN)
    list(FILTER SOURCES EXCLUDE REGEX "/mucom88/src/main.cpp")

    set(CMAKE_CXX_FLAGS_DEBUG "-g")
    set(CMAKE_CXX_FLAGS_RELEASE  "-Oz")
endif()

add_executable(${CMAKE_PROJECT_NAME} ${SOURCES})

if (EMSCRIPTEN)
    target_link_options(${CMAKE_PROJECT_NAME} PRIVATE --bind)
    target_link_options(${CMAKE_PROJECT_NAME} PRIVATE
        -sMODULARIZE=1
        -sEXPORT_ES6=1
        -sEXPORT_NAME=createMucomWeb
        -sENVIRONMENT=web,node
        -sALLOW_MEMORY_GROWTH=1
        -sEXPORTED_RUNTIME_METHODS=FS,HEAP32,HEAPU8)
    if (NOT WEB_BROWSER)
        target_link_options(${CMAKE_PROJECT_NAME} PRIVATE -sNODERAWFS=1)
    endif()
endif()

target_include_directories(${CMAKE_PROJECT_NAME}
        PRIVATE ${SDL_INCLUDE_DIR}
        PRIVATE ${MUCOM88_DIR}/src
        PRIVATE ${MUCOM88_DIR}/src/module
        PRIVATE ${FFT_UPSTREAM_DIR}
        PRIVATE src)

# FMSound自身のバージョン表示(ui/version.js)をgitのコミット日時/ハッシュから
# 生成する。壁時計を使わず「同じコミットなら必ず同じ文字列」を満たす必要があるため
# tools/gen_version.py にロジックを寄せ、CMakeからはpython3を呼ぶだけにする。
# sync_html(下)が ../ui を丸ごとbuild-web/ui/へコピーするより先に走らせる必要が
# あるため、add_dependenciesで明示的に順序付けする(ALL同士は順序が保証されない)。
find_package(Python3 COMPONENTS Interpreter REQUIRED)
add_custom_target(generate_version ALL
    COMMAND ${Python3_EXECUTABLE}
        "${CMAKE_CURRENT_SOURCE_DIR}/../tools/gen_version.py"
    COMMENT "git commit日時/ハッシュから ui/version.js を生成")

# html/ の同期は file(COPY) だと configure 時にしか走らず、html/js だけ編集
# しても build-web/ に反映されない（pmdweb/CMakeLists.txt で踏んだ問題と同じ）。
# ALL 付き custom target なら make のたびに必ず走る。
#
# コピー元は mucomweb/html ではなく ../html（1アプリ化: mucom-app.js/pmd-app.js/
# 共通シェルapp.js/index.htmlをmucomweb/pmdweb両方から共有する。詳細はREADME参照）。
add_custom_target(sync_html ALL
    COMMAND ${CMAKE_COMMAND} -E copy_directory
        "${CMAKE_CURRENT_SOURCE_DIR}/../html"
        "${CMAKE_CURRENT_BINARY_DIR}"
    COMMAND ${CMAKE_COMMAND} -E copy_directory
        "${CMAKE_CURRENT_SOURCE_DIR}/../fmdsp"
        "${CMAKE_CURRENT_BINARY_DIR}/fmdsp"
    COMMAND ${CMAKE_COMMAND} -E copy_directory
        "${CMAKE_CURRENT_SOURCE_DIR}/../ui"
        "${CMAKE_CURRENT_BINARY_DIR}/ui"
    COMMAND ${CMAKE_COMMAND} -E copy_directory
        "${CMAKE_CURRENT_SOURCE_DIR}/../compiler"
        "${CMAKE_CURRENT_BINARY_DIR}/compiler"
    COMMENT "html/ と fmdsp/ と ui/ と compiler/ を build-web/ へ同期")
add_dependencies(sync_html generate_version)

# 課題D(方針転換、2026-08-15): 同梱するサンプルは自作曲のみにする方針となったため、
# 古代祐三氏のsampl1.muc/sampl2.muc(package/同梱)の自動コピーは廃止した。
# 同梱サンプルはhtml/sample_fur_elise_mucom.muc(tools/gen_sample_fur_elise.mjs生成、
# sync_htmlターゲットのhtml/コピーに含まれる)とsamplja.muc(html/直下、検証用)。
