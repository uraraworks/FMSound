cmake_minimum_required(VERSION 3.13)
project(pmdweb LANGUAGES C CXX)

set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 17)
set(UPSTREAM_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../upstream/98fmplayer")

set(PMDWEB_SOURCES
    src/PmdWeb.cpp
    src/PmdCore.c
    ${UPSTREAM_DIR}/libopna/opna.c
    ${UPSTREAM_DIR}/libopna/opnaadpcm.c
    ${UPSTREAM_DIR}/libopna/opnadrum.c
    ${UPSTREAM_DIR}/libopna/opnafm.c
    ${UPSTREAM_DIR}/libopna/opnassg.c
    ${UPSTREAM_DIR}/libopna/opnassg-sinc-c.c
    ${UPSTREAM_DIR}/libopna/opnatimer.c
    ${UPSTREAM_DIR}/fmdriver/fmdriver_common.c
    ${UPSTREAM_DIR}/fmdriver/fmdriver_fmp.c
    ${UPSTREAM_DIR}/fmdriver/fmdriver_pmd.c
    ${UPSTREAM_DIR}/fmdriver/ppz8.c
    ${UPSTREAM_DIR}/common/fmplayer_file.c
    ${UPSTREAM_DIR}/common/fmplayer_file_unix.c
    ${UPSTREAM_DIR}/fft/fft.c)

add_executable(pmdweb ${PMDWEB_SOURCES})

# FMSound自身のバージョン表示(ui/version.js)。mucomweb/CMakeLists.txtと同じ仕組み
# (git コミット日時/ハッシュから生成、壁時計は使わない)。共有ファイルなので
# mucomweb側と両方から生成されても内容は同じ(冪等)。sync_htmlより先に走らせる
# 必要があるためadd_dependenciesで明示的に順序付けする。
find_package(Python3 COMPONENTS Interpreter REQUIRED)
add_custom_target(generate_version ALL
    COMMAND ${Python3_EXECUTABLE}
        "${CMAKE_CURRENT_SOURCE_DIR}/../tools/gen_version.py"
    COMMENT "git commit日時/ハッシュから ui/version.js を生成")

# html/ の同期は file(COPY) だと configure 時にしか走らず、html/js だけ編集
# しても build-web/ には反映されない（実際に踏んだ）。
#
# POST_BUILD ではダメ: ターゲットが再リンクされた時しか走らないので、
# JS/HTML だけ編集した場合は make が「最新」と判断して同期をスキップする
# （probe 行を消しても build-web 側に残ることで確認済み）。
# ALL 付き custom target なら make のたびに必ず走る。
#
# コピー元は pmdweb/html ではなく ../html（1アプリ化: mucom-app.js/pmd-app.js/
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
    COMMENT "html/ と fmdsp/ と ui/ を build-web/ へ同期")
add_dependencies(sync_html generate_version)

target_include_directories(pmdweb PRIVATE "${UPSTREAM_DIR}")

# opna_fm/opna_ssg/opna_drum/opna_adpcm の struct leveldata フィールドと
# leveldata_update() 呼び出しはこのマクロでガードされている
# (libopna/opnafm.h 等)。FMDSP右半分のレベルメーター供給に必須。
target_compile_definitions(pmdweb PRIVATE LIBOPNA_ENABLE_LEVELDATA)

if(EMSCRIPTEN)
    set_target_properties(pmdweb PROPERTIES SUFFIX ".js")
    target_compile_options(pmdweb PRIVATE
        $<$<CONFIG:Release>:-Oz>)
    target_link_options(pmdweb PRIVATE
        --bind
        -sMODULARIZE=1
        -sEXPORT_ES6=1
        -sEXPORT_NAME=createPmdWeb
        -sENVIRONMENT=web,node
        -sALLOW_MEMORY_GROWTH=1
        -sEXPORTED_RUNTIME_METHODS=FS,HEAP32,HEAPU8)
endif()

# 東方Projectアレンジ曲(PC-98_Hartmann_s_Youkai_GIrl.M)のビルド成果物への同梱をやめた。
# 権利(アレンジ元の使用許諾)が不明なため。代わりの自作サンプルは別タスクで用意する
# (PMD MMLコンパイラが完成したため作成可能になった)。pmdweb/README.md参照。
