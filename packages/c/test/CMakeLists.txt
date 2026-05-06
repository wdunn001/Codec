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
    test_pretok_program
)

foreach(t ${CODEC_TESTS})
    add_executable(${t} ${t}.c)
    target_link_libraries(${t} PRIVATE ${CODEC_TEST_TARGET})
    target_include_directories(${t} PRIVATE ${PROJECT_SOURCE_DIR}/test)
    add_test(NAME ${t} COMMAND ${t})
endforeach()

# Make codec-maps path discoverable to tests that exercise the real Qwen-2 map.
if(EXISTS "${CMAKE_SOURCE_DIR}/../../codec-maps/maps/qwen/qwen2.json")
    set_tests_properties(test_map test_tool_watcher PROPERTIES
        ENVIRONMENT "CODEC_MAPS_QWEN=${CMAKE_SOURCE_DIR}/../../codec-maps/maps/qwen/qwen2.json")
endif()
