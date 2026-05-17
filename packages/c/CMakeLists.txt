# SPDX-License-Identifier: MIT
#
# libcodec — C implementation of the Codec binary transport protocol.
#
# Pure C99, zero external runtime deps. Vendored sha256 (public domain) and
# jsmn (MIT) live in src/. Builds a shared and/or static library, installs
# CMake package config + pkg-config, runs CTest unit tests.
#
# Consumption (see README for details):
#
#   FetchContent_Declare(codec
#     GIT_REPOSITORY https://github.com/wdunn001/Codec.git
#     GIT_TAG        v0.1.0
#     SOURCE_SUBDIR  packages/c)
#   FetchContent_MakeAvailable(codec)
#   target_link_libraries(myapp PRIVATE codec::codec)
#
cmake_minimum_required(VERSION 3.14)

project(codec
        VERSION 0.4.1
        DESCRIPTION "Token-native binary transport protocol for AI APIs (C library)"
        HOMEPAGE_URL "https://github.com/wdunn001/Codec"
        LANGUAGES C)

include(CMakePackageConfigHelpers)
include(GNUInstallDirs)

# ── Options ──────────────────────────────────────────────────────────────────

option(CODEC_BUILD_SHARED  "Build shared library"   ON)
option(CODEC_BUILD_STATIC  "Build static library"   ON)
option(CODEC_BUILD_TESTS   "Build unit tests"       ${PROJECT_IS_TOP_LEVEL})
option(CODEC_BUILD_EXAMPLES "Build examples"        ${PROJECT_IS_TOP_LEVEL})
option(CODEC_INSTALL       "Generate install rules" ${PROJECT_IS_TOP_LEVEL})
option(CODEC_COVERAGE      "Enable gcov/lcov coverage instrumentation" OFF)

# Text → IDs encoder (BPE + pretok-program runtime + Unicode tables +
# Translator). ~25 KB of compiled code + data on x86-64 Linux (varies
# by toolchain; cross-compile to Cortex-M / Xtensa / RISC-V where it's
# more like 15-30 KB). Embedded / IoT consumers that only consume
# decode-side APIs (Detokenizer, ToolWatcher, stream decoders, frame
# codec, compression, safety policy) can drop this with
# -DCODEC_WITH_BPE_ENCODER=OFF. Public-API symbols still link
# (returning CODEC_ERR_NOT_BUILT) so consumer code doesn't need ifdefs.
# Tools built on the @codecai/tool-kit pre-cached pattern never call
# runtime BPE — they ship cached IDs at build time. Default ON to
# preserve current behaviour.
option(CODEC_WITH_BPE_ENCODER "Include BPE encoder + Translator + pretok runtime + Unicode tables (~25 KB)" ON)

if(NOT CODEC_BUILD_SHARED AND NOT CODEC_BUILD_STATIC)
    message(FATAL_ERROR "At least one of CODEC_BUILD_SHARED / CODEC_BUILD_STATIC must be ON")
endif()

# Coverage flags — opt-in via `cmake -DCODEC_COVERAGE=ON`. Added 2026-05-11
# for the v0.4 release cut.
if(CODEC_COVERAGE)
    if(CMAKE_C_COMPILER_ID MATCHES "GNU|Clang")
        add_compile_options(--coverage -O0 -g)
        add_link_options(--coverage)
    else()
        message(WARNING "CODEC_COVERAGE=ON but compiler is not gcc/clang; ignoring")
    endif()
endif()

# Compiler hardening / standards.
set(CMAKE_C_STANDARD 99)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
    set(CMAKE_BUILD_TYPE Release CACHE STRING "" FORCE)
    set_property(CACHE CMAKE_BUILD_TYPE PROPERTY STRINGS Debug Release RelWithDebInfo MinSizeRel)
endif()

# ── Sources ──────────────────────────────────────────────────────────────────

set(CODEC_SOURCES
    src/codec_util.c
    src/sha256.c
    src/map.c
    src/codec_frame.c
    src/detokenize.c
    src/stream.c
    src/tool_watcher.c
    src/codec_safety_policy.c
    src/codec_version_signaling.c
    src/codec_compression.c
)
if(CODEC_WITH_BPE_ENCODER)
    list(APPEND CODEC_SOURCES
        src/codec_unicode_tables.c
        src/pretok_program.c
        src/bpe.c
        src/translator.c)
    message(STATUS "libcodec: BPE encoder + Translator + pretok runtime enabled")
else()
    list(APPEND CODEC_SOURCES
        src/bpe_stub.c)
    message(STATUS "libcodec: BPE encoder DISABLED (decode-only build, ~25 KB lighter on x86-64); encoder symbols return CODEC_ERR_NOT_BUILT")
endif()
set(CODEC_HEADERS
    include/codec/codec.h
    include/codec/codec_safety_policy.h
    include/codec/codec_version_signaling.h
    include/codec/codec_compression.h
)

# ── Helper macro: configure a target ────────────────────────────────────────
# We share warning flags / include paths between the static and shared targets.
function(_codec_configure_target tgt is_shared)
    target_include_directories(${tgt}
        PUBLIC
            $<BUILD_INTERFACE:${PROJECT_SOURCE_DIR}/include>
            $<INSTALL_INTERFACE:${CMAKE_INSTALL_INCLUDEDIR}>
        PRIVATE
            ${PROJECT_SOURCE_DIR}/src)
    set_target_properties(${tgt} PROPERTIES
        C_VISIBILITY_PRESET hidden
        VISIBILITY_INLINES_HIDDEN ON
        POSITION_INDEPENDENT_CODE ON)
    if(MSVC)
        target_compile_options(${tgt} PRIVATE /W4 /permissive-)
    else()
        target_compile_options(${tgt} PRIVATE -Wall -Wextra -Wpedantic -Wno-unused-parameter)
    endif()
    if(${is_shared})
        target_compile_definitions(${tgt} PRIVATE CODEC_BUILD_SHARED=1)
    endif()
endfunction()

# ── Targets ──────────────────────────────────────────────────────────────────

# Static library always — shared depends on it for symbol re-export on some
# platforms but we keep them as separate compilation units to be safe.
if(CODEC_BUILD_STATIC)
    add_library(codec_static STATIC ${CODEC_SOURCES} ${CODEC_HEADERS})
    set_target_properties(codec_static PROPERTIES
        OUTPUT_NAME   codec
        EXPORT_NAME   codec_static)
    _codec_configure_target(codec_static FALSE)
endif()

if(CODEC_BUILD_SHARED)
    add_library(codec_shared SHARED ${CODEC_SOURCES} ${CODEC_HEADERS})
    set_target_properties(codec_shared PROPERTIES
        OUTPUT_NAME   codec
        VERSION       ${PROJECT_VERSION}
        SOVERSION     ${PROJECT_VERSION_MAJOR}
        EXPORT_NAME   codec)
    _codec_configure_target(codec_shared TRUE)
endif()

# A consumer-facing alias that always works.
if(CODEC_BUILD_SHARED)
    add_library(codec::codec ALIAS codec_shared)
elseif(CODEC_BUILD_STATIC)
    add_library(codec::codec ALIAS codec_static)
endif()
if(CODEC_BUILD_STATIC)
    add_library(codec::codec_static ALIAS codec_static)
endif()

# ── Tests ────────────────────────────────────────────────────────────────────

if(CODEC_BUILD_TESTS)
    enable_testing()
    add_subdirectory(test)
endif()

if(CODEC_BUILD_EXAMPLES AND EXISTS ${PROJECT_SOURCE_DIR}/examples/CMakeLists.txt)
    add_subdirectory(examples)
endif()

# ── Install ──────────────────────────────────────────────────────────────────

if(CODEC_INSTALL)
    set(CODEC_INSTALL_TARGETS)
    if(CODEC_BUILD_SHARED)
        list(APPEND CODEC_INSTALL_TARGETS codec_shared)
    endif()
    if(CODEC_BUILD_STATIC)
        list(APPEND CODEC_INSTALL_TARGETS codec_static)
    endif()

    install(TARGETS ${CODEC_INSTALL_TARGETS}
        EXPORT codec-targets
        RUNTIME       DESTINATION ${CMAKE_INSTALL_BINDIR}
        LIBRARY       DESTINATION ${CMAKE_INSTALL_LIBDIR}
        ARCHIVE       DESTINATION ${CMAKE_INSTALL_LIBDIR}
        INCLUDES      DESTINATION ${CMAKE_INSTALL_INCLUDEDIR})

    install(DIRECTORY include/codec
        DESTINATION ${CMAKE_INSTALL_INCLUDEDIR}
        FILES_MATCHING PATTERN "*.h")

    # CMake package config: lets consumers `find_package(codec CONFIG)`.
    set(CODEC_CMAKE_PACKAGE_DIR ${CMAKE_INSTALL_LIBDIR}/cmake/codec)

    install(EXPORT codec-targets
        NAMESPACE codec::
        DESTINATION ${CODEC_CMAKE_PACKAGE_DIR}
        FILE codec-targets.cmake)

    configure_package_config_file(
        ${PROJECT_SOURCE_DIR}/cmake/codec-config.cmake.in
        ${CMAKE_CURRENT_BINARY_DIR}/codec-config.cmake
        INSTALL_DESTINATION ${CODEC_CMAKE_PACKAGE_DIR})

    write_basic_package_version_file(
        ${CMAKE_CURRENT_BINARY_DIR}/codec-config-version.cmake
        VERSION ${PROJECT_VERSION}
        COMPATIBILITY SameMajorVersion)

    install(FILES
        ${CMAKE_CURRENT_BINARY_DIR}/codec-config.cmake
        ${CMAKE_CURRENT_BINARY_DIR}/codec-config-version.cmake
        DESTINATION ${CODEC_CMAKE_PACKAGE_DIR})

    # pkg-config file for non-CMake consumers.
    set(prefix      ${CMAKE_INSTALL_PREFIX})
    set(exec_prefix \${prefix})
    set(libdir      \${exec_prefix}/${CMAKE_INSTALL_LIBDIR})
    set(includedir  \${prefix}/${CMAKE_INSTALL_INCLUDEDIR})
    configure_file(
        ${PROJECT_SOURCE_DIR}/cmake/codec.pc.in
        ${CMAKE_CURRENT_BINARY_DIR}/codec.pc @ONLY)
    install(FILES ${CMAKE_CURRENT_BINARY_DIR}/codec.pc
        DESTINATION ${CMAKE_INSTALL_LIBDIR}/pkgconfig)
endif()
