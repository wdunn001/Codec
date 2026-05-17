# Examples link against the static library directly. The shared lib uses
# `C_VISIBILITY_PRESET hidden` (correct for a versioned shared API) but
# the header doesn't yet ship a CODEC_API export macro, so consumers
# can't reach the symbols through the alias. The fix is the proper
# export-macro work; meanwhile, examples use the static target which
# has no visibility filter. The internal test suite already links to
# codec_static for the same reason.
add_executable(stream_decode stream_decode.c)
target_link_libraries(stream_decode PRIVATE codec::codec_static)

add_executable(bench_decode bench_decode.c)
target_link_libraries(bench_decode PRIVATE codec::codec_static)

add_executable(bench_watcher bench_watcher.c)
target_link_libraries(bench_watcher PRIVATE codec::codec_static)
