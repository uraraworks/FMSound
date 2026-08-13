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

file(GLOB HTML_SOURCES "${CMAKE_CURRENT_SOURCE_DIR}/html/*")
file(COPY ${HTML_SOURCES} DESTINATION "${CMAKE_CURRENT_BINARY_DIR}")

add_executable(pmdweb ${PMDWEB_SOURCES})

# 上の file(COPY) は configure 時にしか走らないため、html/ を編集しても
# build-web/ には反映されず、古い版を配信し続ける（実際に踏んだ）。
#
# POST_BUILD ではダメ: ターゲットが再リンクされた時しか走らないので、
# JS/HTML だけ編集した場合は make が「最新」と判断して同期をスキップする
# （probe 行を消しても build-web 側に残ることで確認済み）。
# ALL 付き custom target なら make のたびに必ず走る。
add_custom_target(sync_html ALL
    COMMAND ${CMAKE_COMMAND} -E copy_directory
        "${CMAKE_CURRENT_SOURCE_DIR}/html"
        "${CMAKE_CURRENT_BINARY_DIR}"
    COMMENT "html/ を build-web/ へ同期")

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

add_custom_command(TARGET pmdweb POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "${CMAKE_CURRENT_SOURCE_DIR}/../upstream/pmdmini/PC-98_Hartmann_s_Youkai_GIrl.M"
        "${CMAKE_CURRENT_BINARY_DIR}/PC-98_Hartmann_s_Youkai_GIrl.M")
