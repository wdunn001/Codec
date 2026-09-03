# Unit tests for libcodec. Each test is a standalone executable so failure
# isolation is good and CTest can run them in parallel.

set(CODEC_TEST_TARGET codec::codec_static)
if(NOT TARGET codec::codec_static)
    set(CODEC_TEST_TARGET codec::codec)
endif()

set(CODEC_TESTS
    test_frame
    test_detokenize
    test_map
    test_stream
    test_tool_watcher
    test_tool_watcher_fixture
    test_tool_calling
    test_safety_policy
    test_version_signaling
    test_compression
)
# BPE encoder + Translator + pretok program live in optional sources;
# their tests only get built when the encoder side is in the library.
if(CODEC_WITH_BPE_ENCODER)
    list(APPEND CODEC_TESTS
        test_pretok_program
        test_pretok_program_fixture
        test_bpe
        test_bpe_special_tokens
        test_translator)
endif()

foreach(t ${CODEC_TESTS})
    add_executable(${t} ${t}.c)
    target_link_libraries(${t} PRIVATE ${CODEC_TEST_TARGET})
    target_include_directories(${t} PRIVATE ${PROJECT_SOURCE_DIR}/test)
    add_test(NAME ${t} COMMAND ${t})
endforeach()

# test_tool_watcher_fixture reads the vendored jsmn parser directly (the
# same one map.c / codec_safety_policy.c / codec_version_signaling.c use)
# to load the cross-language ToolWatcher conformance fixture. It needs
# src/ on its include path for jsmn.h + codec_jsmn_guard.h; the other test
# targets only need test/ (codec_test.h) and the library's public headers.
target_include_directories(test_tool_watcher_fixture PRIVATE ${PROJECT_SOURCE_DIR}/src)

# test_pretok_program_fixture reads the shared pretok-program conformance
# fixture directly with jsmn, the same idiom test_tool_watcher_fixture
# uses; it needs src/ on its include path for the same reason.
if(TARGET test_pretok_program_fixture)
    target_include_directories(test_pretok_program_fixture PRIVATE ${PROJECT_SOURCE_DIR}/src)
endif()

# Make codec-maps path discoverable to tests that exercise the real Qwen-2 map.
if(EXISTS "${CMAKE_SOURCE_DIR}/../../codec-maps/maps/qwen/qwen2.json")
    set_tests_properties(test_map test_tool_watcher PROPERTIES
        ENVIRONMENT "CODEC_MAPS_QWEN=${CMAKE_SOURCE_DIR}/../../codec-maps/maps/qwen/qwen2.json")
endif()

# Point test_tool_watcher_fixture at the shared conformance fixture
# (packages/tool-watcher-conformance/fixtures/tool-watcher-events.json,
# one level up from packages/c). This is the same fixture TS, Python,
# Rust, Java and .NET all load. Unlike the codec-maps checkout above,
# it is committed and mandatory here. This is set unconditionally.
# It is not gated on an EXISTS check. If the path is ever wrong, the
# test fails loudly: see load_fixture_text in
# test_tool_watcher_fixture.c. It does not silently skip.
set_tests_properties(test_tool_watcher_fixture PROPERTIES
    ENVIRONMENT "CODEC_FIXTURE_PATH=${CMAKE_SOURCE_DIR}/../tool-watcher-conformance/fixtures/tool-watcher-events.json")

# Point test_pretok_program_fixture at the shared pretok-program
# conformance fixture (packages/pretok-program-conformance/fixtures/
# pretok-program-cases.json), the same one TS / Python / Rust load.
# Unconditional, same posture as the tool-watcher fixture above: if the
# path is ever wrong, the test fails loudly rather than silently
# skipping.
if(TARGET test_pretok_program_fixture)
    set_tests_properties(test_pretok_program_fixture PROPERTIES
        ENVIRONMENT "CODEC_PRETOK_FIXTURE_PATH=${CMAKE_SOURCE_DIR}/../pretok-program-conformance/fixtures/pretok-program-cases.json")
endif()

# Make the dict-zstd interop fixture discoverable to test_compression. The
# fixture lives in packages/bench/fixtures/dict-zstd-interop/ and is the
# same one every Codec client (TS / Python / Rust / Java / .NET) cross-verifies
# byte-for-byte against: see its manifest.json for the contract.
if(EXISTS "${CMAKE_SOURCE_DIR}/../bench/fixtures/dict-zstd-interop/manifest.json")
    set_tests_properties(test_compression PROPERTIES
        ENVIRONMENT "CODEC_DICT_ZSTD_INTEROP_DIR=${CMAKE_SOURCE_DIR}/../bench/fixtures/dict-zstd-interop")
endif()
