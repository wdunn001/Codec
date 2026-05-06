add_executable(stream_decode stream_decode.c)
target_link_libraries(stream_decode PRIVATE codec::codec)

add_executable(bench_decode bench_decode.c)
target_link_libraries(bench_decode PRIVATE codec::codec)
