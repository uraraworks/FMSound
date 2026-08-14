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

list(FILTER SOURCES EXCLUDE REGEX "/mucom88/src/mucomerror.cpp")

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

# html/ の同期は file(COPY) だと configure 時にしか走らず、html/js だけ編集
# しても build-web/ に反映されない（pmdweb/CMakeLists.txt で踏んだ問題と同じ）。
# ALL 付き custom target なら make のたびに必ず走る。
add_custom_target(sync_html ALL
    COMMAND ${CMAKE_COMMAND} -E copy_directory
        "${CMAKE_CURRENT_SOURCE_DIR}/html"
        "${CMAKE_CURRENT_BINARY_DIR}"
    COMMAND ${CMAKE_COMMAND} -E copy_directory
        "${CMAKE_CURRENT_SOURCE_DIR}/../fmdsp"
        "${CMAKE_CURRENT_BINARY_DIR}/fmdsp"
    COMMENT "html/ と fmdsp/ を build-web/ へ同期")

# サンプル MML。README には「ビルド後に毎回手でコピー」とあったがこの機会に自動化。
add_custom_command(TARGET ${CMAKE_PROJECT_NAME} POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "${MUCOM88_DIR}/package/sampl1.muc"
        "${CMAKE_CURRENT_BINARY_DIR}/sampl1.muc"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "${MUCOM88_DIR}/package/sampl2.muc"
        "${CMAKE_CURRENT_BINARY_DIR}/sampl2.muc")
