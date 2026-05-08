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

# libcurl
find_package(CURL REQUIRED)

# libcodec - find sibling source tree if not already installed.
if(NOT TARGET codec::codec)
    add_subdirectory(${CMAKE_CURRENT_SOURCE_DIR}/../c
                     ${CMAKE_BINARY_DIR}/libcodec
                     EXCLUDE_FROM_ALL)
endif()

add_executable(codec-bench bench.c)

# SCHEMA-v1 matrix runner (mirrors matrix_run.py / matrix_run.ts /
# Program.cs's matrix mode / matrix_run.rs / MatrixRun.java). Distinct
# binary because the legacy bench.c keeps its single-prompt grid
# behaviour for ad-hoc smoke tests.
add_executable(codec-matrix matrix_run.c)

# Link against the static lib — the shared lib uses hidden visibility
# and not every public symbol carries an export attribute yet.
if(TARGET codec::codec_static)
    target_link_libraries(codec-bench PRIVATE codec::codec_static CURL::libcurl)
    target_link_libraries(codec-matrix PRIVATE codec::codec_static CURL::libcurl)
else()
    target_link_libraries(codec-bench PRIVATE codec::codec CURL::libcurl)
    target_link_libraries(codec-matrix PRIVATE codec::codec CURL::libcurl)
endif()

if(MSVC)
    target_compile_options(codec-bench PRIVATE /W4)
    target_compile_options(codec-matrix PRIVATE /W4)
else()
    target_compile_options(codec-bench PRIVATE -Wall -Wextra -Wpedantic)
    target_compile_options(codec-matrix PRIVATE -Wall -Wextra -Wpedantic)
    # matrix_run.c uses memmem (GNU extension)
    target_compile_definitions(codec-matrix PRIVATE _GNU_SOURCE)
endif()
