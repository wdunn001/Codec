# SPDX-License-Identifier: MIT
#
# codec-bench (C) - same shape as packages/demo-web (TypeScript),
# packages/demo-python, and packages/demo-dotnet.
#
# Depends on libcodec (sibling: packages/c) and libcurl. Build:
#
#   cmake -S . -B build
#   cmake --build build
#   ./build/codec-bench --url http://192.168.1.88:30000
#
# On Windows: install libcurl via vcpkg first.
# On Debian/Ubuntu: apt install libcurl4-openssl-dev cmake build-essential

cmake_minimum_required(VERSION 3.14)
project(codec-bench LANGUAGES C)

set(CMAKE_C_STANDARD 99)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)

# libcurl — required for codec-bench / codec-matrix (live wire benches).
# codec-token-bench has no network deps, so we make libcurl optional and
# disable the curl-dependent targets when it's missing. This lets a
# dev box without libcurl still build the token-bench micro-driver.
find_package(CURL)

# libzstd — required by codec-matrix to honour the dict-zstd contract
# (verify Codec-Zstd-Dict, decompress with the matching dict). On Debian /
# Ubuntu: apt install libzstd-dev. On macOS: brew install zstd. On
# Windows: vcpkg install zstd. If unavailable, we drop libzstd-using
# features from codec-matrix and fall back to "skip zstd cells" rather
# than failing the build; the rest of the matrix still runs.
find_package(PkgConfig QUIET)
if(PkgConfig_FOUND)
    pkg_check_modules(ZSTD QUIET IMPORTED_TARGET libzstd)
endif()
if(NOT ZSTD_FOUND)
    find_library(ZSTD_LIBRARY NAMES zstd)
    find_path(ZSTD_INCLUDE_DIR zstd.h)
    if(ZSTD_LIBRARY AND ZSTD_INCLUDE_DIR)
        set(ZSTD_FOUND TRUE)
    endif()
endif()

# libcodec - find sibling source tree if not already installed.
if(NOT TARGET codec::codec)
    add_subdirectory(${CMAKE_CURRENT_SOURCE_DIR}/../c
                     ${CMAKE_BINARY_DIR}/libcodec
                     EXCLUDE_FROM_ALL)
endif()

if(CURL_FOUND)
    add_executable(codec-bench bench.c)
    # SCHEMA-v1 matrix runner (mirrors matrix_run.py / matrix_run.ts /
    # Program.cs's matrix mode / matrix_run.rs / MatrixRun.java). Distinct
    # binary because the legacy bench.c keeps its single-prompt grid
    # behaviour for ad-hoc smoke tests.
    add_executable(codec-matrix matrix_run.c)
endif()

# Per-language tokenize/detokenize micro-bench (mirrors
# codec_demo.token_bench, demo/src/token_bench.ts,
# demo-rust/src/token_bench.rs, demo-dotnet/TokenBench.cs,
# demo-java/.../TokenBench.java). libcodec ships detokenize only; this
# driver decode-only, encode_* fields are null in output.
add_executable(codec-token-bench token_bench.c)

# Link against the static lib — the shared lib uses hidden visibility
# and not every public symbol carries an export attribute yet.
if(TARGET codec::codec_static)
    target_link_libraries(codec-token-bench PRIVATE codec::codec_static)
    if(CURL_FOUND)
        target_link_libraries(codec-bench PRIVATE codec::codec_static CURL::libcurl)
        target_link_libraries(codec-matrix PRIVATE codec::codec_static CURL::libcurl)
    endif()
else()
    target_link_libraries(codec-token-bench PRIVATE codec::codec)
    if(CURL_FOUND)
        target_link_libraries(codec-bench PRIVATE codec::codec CURL::libcurl)
        target_link_libraries(codec-matrix PRIVATE codec::codec CURL::libcurl)
    endif()
endif()

# codec-matrix uses libzstd for dict-zstd decompression. When libzstd is
# present we link it and define CODEC_DEMO_HAVE_ZSTD; when absent the
# code path is compiled out so the binary still builds and the matrix
# still runs (zstd cells just report a "libzstd unavailable" error).
if(CURL_FOUND)
    if(ZSTD_FOUND)
        if(TARGET PkgConfig::ZSTD)
            target_link_libraries(codec-matrix PRIVATE PkgConfig::ZSTD)
        else()
            target_include_directories(codec-matrix PRIVATE ${ZSTD_INCLUDE_DIR})
            target_link_libraries(codec-matrix PRIVATE ${ZSTD_LIBRARY})
        endif()
        target_compile_definitions(codec-matrix PRIVATE CODEC_DEMO_HAVE_ZSTD=1)
    else()
        message(STATUS "libzstd not found — codec-matrix will skip dict-zstd cells. "
                       "Install libzstd-dev (Debian/Ubuntu) / zstd (brew) / zstd (vcpkg) "
                       "to enable.")
    endif()
endif()

if(MSVC)
    target_compile_options(codec-token-bench PRIVATE /W4)
    if(CURL_FOUND)
        target_compile_options(codec-bench PRIVATE /W4)
        target_compile_options(codec-matrix PRIVATE /W4)
    endif()
else()
    target_compile_options(codec-token-bench PRIVATE -Wall -Wextra -Wpedantic)
    if(CURL_FOUND)
        target_compile_options(codec-bench PRIVATE -Wall -Wextra -Wpedantic)
        target_compile_options(codec-matrix PRIVATE -Wall -Wextra -Wpedantic)
        # matrix_run.c uses memmem (GNU extension)
        target_compile_definitions(codec-matrix PRIVATE _GNU_SOURCE)
    endif()
endif()
