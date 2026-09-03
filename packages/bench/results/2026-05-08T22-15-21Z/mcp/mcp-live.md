# MCP wire bench: 2026-05-08T22-15-21Z

Target: `http://192.168.1.88:12008/metamcp/openwebui-api/mcp`
Vocab map: `https://cdn.jsdelivr.net/gh/wdunn001/codec-maps/maps/qwen/qwen2.json` (sha256 `sha256:0549c…`)

## initialize

| variant               | status                                     | req   | resp (wire) | resp vs json | TTFB   | total  |
|-----------------------|--------------------------------------------|-------|-------------|--------------|--------|--------|
| json                  | 200                                        | 402 B | 892 B       | 1.0×         | 6.2 ms | 6.5 ms |
| msgpack-resp          | 200                                        | 394 B | 826 B       | 1.1×         | 5.9 ms | 6.1 ms |
| msgpack-both          | 200                                        | 371 B | 826 B       | 1.1×         | 6.1 ms | 6.3 ms |
| msgpack-both+gzip     | 200                                        | 394 B | 856 B       | 1.0×         | 5.7 ms | 5.9 ms |
| msgpack-both+gzip+map | 0 initialize HTTP 400: {"jsonrpc":"2.0","i | 0 B   | 0 B         | n/a            | 0 ns   | 0 ns   |

## tools/list

| variant               | status       | req   | resp (wire) | resp vs json | TTFB     | total    |
|-----------------------|--------------|-------|-------------|--------------|----------|----------|
| json                  | 200          | 349 B | 20.7 KB     | 1.0×         | 122.1 ms | 123.5 ms |
| msgpack-resp          | 200          | 341 B | 18.5 KB     | 1.1×         | 2.40 s   | 2.40 s   |
| msgpack-both          | 200          | 336 B | 18.5 KB     | 1.1×         | 87.3 ms  | 88.7 ms  |
| msgpack-both+gzip     | 200          | 360 B | 5.8 KB      | 3.6×         | 2.27 s   | 2.27 s   |
| msgpack-both+gzip+map | 0 no session | 0 B   | 0 B         | n/a            | 0 ns     | 0 ns     |

## tools/call: `YouTube-Transcripts__get_transcript`

| variant           | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-------------------|--------|-------|-------------|--------------|---------|---------|
| json              | 200    | 458 B | 825 B       | 1.0×         | 11.4 ms | 11.5 ms |
| msgpack-resp      | 200    | 450 B | 779 B       | 1.1×         | 11.6 ms | 11.7 ms |
| msgpack-both      | 200    | 432 B | 779 B       | 1.1×         | 12.6 ms | 12.7 ms |
| msgpack-both+gzip | 200    | 455 B | 814 B       | 1.0×         | 11.2 ms | 11.3 ms |

## tools/call: `Playwright__start_codegen_session`

| variant           | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-------------------|--------|-------|-------------|--------------|---------|---------|
| json              | 200    | 420 B | 1020 B      | 1.0×         | 15.3 ms | 15.6 ms |
| msgpack-resp      | 200    | 412 B | 945 B       | 1.1×         | 13.7 ms | 13.9 ms |
| msgpack-both      | 200    | 398 B | 945 B       | 1.1×         | 14.0 ms | 14.1 ms |
| msgpack-both+gzip | 200    | 421 B | 933 B       | 1.1×         | 12.7 ms | 12.9 ms |

## tools/call: `Playwright__end_codegen_session`

| variant           | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-------------------|--------|-------|-------------|--------------|---------|---------|
| json              | 200    | 431 B | 824 B       | 1.0×         | 9.7 ms  | 9.8 ms  |
| msgpack-resp      | 200    | 423 B | 770 B       | 1.1×         | 9.1 ms  | 9.2 ms  |
| msgpack-both      | 200    | 408 B | 770 B       | 1.1×         | 10.0 ms | 10.1 ms |
| msgpack-both+gzip | 200    | 431 B | 813 B       | 1.0×         | 9.6 ms  | 9.9 ms  |

## tools/call: `Playwright__get_codegen_session`

| variant           | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-------------------|--------|-------|-------------|--------------|--------|--------|
| json              | 200    | 431 B | 793 B       | 1.0×         | 9.0 ms | 9.1 ms |
| msgpack-resp      | 200    | 423 B | 738 B       | 1.1×         | 8.8 ms | 8.9 ms |
| msgpack-both      | 200    | 408 B | 738 B       | 1.1×         | 8.9 ms | 8.9 ms |
| msgpack-both+gzip | 200    | 431 B | 789 B       | 1.0×         | 9.3 ms | 9.5 ms |

## tools/call: `Playwright__clear_codegen_session`

| variant           | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-------------------|--------|-------|-------------|--------------|---------|---------|
| json              | 200    | 433 B | 793 B       | 1.0×         | 11.7 ms | 11.9 ms |
| msgpack-resp      | 200    | 425 B | 738 B       | 1.1×         | 9.9 ms  | 10.0 ms |
| msgpack-both      | 200    | 411 B | 738 B       | 1.1×         | 9.8 ms  | 10.0 ms |
| msgpack-both+gzip | 200    | 434 B | 789 B       | 1.0×         | 10.7 ms | 10.9 ms |

## tools/call: `Playwright__playwright_navigate`

| variant           | status                    | req   | resp (wire) | resp vs json | TTFB    | total   |
|-------------------|---------------------------|-------|-------------|--------------|---------|---------|
| json              | 500 Internal Server Error | 433 B | 171 B       | n/a            | 30.01 s | 30.01 s |
| msgpack-resp      | 200                       | 425 B | 1.8 KB      | n/a            | 20.06 s | 20.06 s |
| msgpack-both      | 200                       | 410 B | 1.8 KB      | n/a            | 3.72 s  | 3.72 s  |
| msgpack-both+gzip | 200                       | 433 B | 1.0 KB      | n/a            | 3.80 s  | 3.80 s  |

## tools/call: `Playwright__playwright_fill`

| variant           | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-------------------|--------|-------|-------------|--------------|--------|--------|
| json              | 200    | 448 B | 1.8 KB      | 1.0×         | 3.69 s | 3.69 s |
| msgpack-resp      | 200    | 440 B | 1.8 KB      | 1.0×         | 3.68 s | 3.68 s |
| msgpack-both      | 200    | 421 B | 1.8 KB      | 1.0×         | 3.70 s | 3.70 s |
| msgpack-both+gzip | 200    | 444 B | 1.0 KB      | 1.8×         | 3.67 s | 3.67 s |

## tools/call: `Playwright__playwright_select`

| variant           | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-------------------|--------|-------|-------------|--------------|--------|--------|
| json              | 200    | 450 B | 1.8 KB      | 1.0×         | 3.70 s | 3.70 s |
| msgpack-resp      | 200    | 442 B | 1.8 KB      | 1.0×         | 3.69 s | 3.69 s |
| msgpack-both      | 200    | 423 B | 1.8 KB      | 1.0×         | 3.71 s | 3.71 s |
| msgpack-both+gzip | 200    | 446 B | 1.0 KB      | 1.8×         | 3.69 s | 3.69 s |

## tools/call: `Playwright__playwright_hover`

| variant           | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-------------------|--------|-------|-------------|--------------|--------|--------|
| json              | 200    | 427 B | 1.8 KB      | 1.0×         | 3.69 s | 3.69 s |
| msgpack-resp      | 200    | 419 B | 1.8 KB      | 1.0×         | 3.73 s | 3.73 s |
| msgpack-both      | 200    | 404 B | 1.8 KB      | 1.0×         | 3.74 s | 3.74 s |
| msgpack-both+gzip | 200    | 427 B | 1.0 KB      | 1.8×         | 3.73 s | 3.73 s |

## tools/call: `Playwright__playwright_upload_file`

| variant           | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-------------------|--------|-------|-------------|--------------|--------|--------|
| json              | 200    | 458 B | 1.8 KB      | 1.0×         | 3.76 s | 3.76 s |
| msgpack-resp      | 200    | 450 B | 1.8 KB      | 1.0×         | 3.73 s | 3.73 s |
| msgpack-both      | 200    | 432 B | 1.8 KB      | 1.0×         | 3.81 s | 3.81 s |
| msgpack-both+gzip | 200    | 455 B | 1.0 KB      | 1.8×         | 3.68 s | 3.68 s |

## tools/call: `Playwright__playwright_screenshot`

| variant           | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-------------------|--------|-------|-------------|--------------|--------|--------|
| json              | 200    | 428 B | 1.8 KB      | 1.0×         | 3.71 s | 3.71 s |
| msgpack-resp      | 200    | 420 B | 1.8 KB      | 1.0×         | 3.70 s | 3.71 s |
| msgpack-both      | 200    | 406 B | 1.8 KB      | 1.0×         | 3.70 s | 3.70 s |
| msgpack-both+gzip | 200    | 429 B | 1.0 KB      | 1.8×         | 3.71 s | 3.71 s |

## tools/call: `Playwright__playwright_click`

| variant           | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-------------------|--------|-------|-------------|--------------|--------|--------|
| json              | 200    | 427 B | 1.8 KB      | 1.0×         | 3.76 s | 3.76 s |
| msgpack-resp      | 200    | 419 B | 1.8 KB      | 1.0×         | 3.80 s | 3.80 s |
| msgpack-both      | 200    | 404 B | 1.8 KB      | 1.0×         | 3.73 s | 3.73 s |
| msgpack-both+gzip | 200    | 427 B | 1.0 KB      | 1.8×         | 3.69 s | 3.70 s |

## tools/call: `Playwright__playwright_iframe_click`

| variant           | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-------------------|--------|-------|-------------|--------------|--------|--------|
| json              | 200    | 465 B | 1.8 KB      | 1.0×         | 3.72 s | 3.72 s |
| msgpack-resp      | 200    | 457 B | 1.8 KB      | 1.0×         | 3.73 s | 3.73 s |
| msgpack-both      | 200    | 439 B | 1.8 KB      | 1.0×         | 3.67 s | 3.67 s |
| msgpack-both+gzip | 200    | 462 B | 1.0 KB      | 1.8×         | 3.66 s | 3.66 s |

## tools/call: `Playwright__playwright_iframe_fill`

| variant           | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-------------------|--------|-------|-------------|--------------|--------|--------|
| json              | 200    | 486 B | 1.8 KB      | 1.0×         | 3.68 s | 3.68 s |
| msgpack-resp      | 200    | 478 B | 1.8 KB      | 1.0×         | 3.71 s | 3.71 s |
| msgpack-both      | 200    | 456 B | 1.8 KB      | 1.0×         | 3.75 s | 3.75 s |
| msgpack-both+gzip | 200    | 479 B | 1.0 KB      | 1.8×         | 3.69 s | 3.69 s |

## tools/call: `Playwright__playwright_close`

| variant           | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-------------------|--------|-------|-------------|--------------|---------|---------|
| json              | 200    | 403 B | 793 B       | 1.0×         | 10.7 ms | 10.8 ms |
| msgpack-resp      | 200    | 395 B | 737 B       | 1.1×         | 9.7 ms  | 9.8 ms  |
| msgpack-both      | 200    | 382 B | 737 B       | 1.1×         | 9.1 ms  | 9.2 ms  |
| msgpack-both+gzip | 200    | 405 B | 788 B       | 1.0×         | 8.6 ms  | 8.7 ms  |

## tools/call: `Playwright__playwright_get`

| variant           | status | req   | resp (wire) | resp vs json | TTFB     | total    |
|-------------------|--------|-------|-------------|--------------|----------|----------|
| json              | 200    | 428 B | 1.4 KB      | 1.0×         | 298.1 ms | 298.2 ms |
| msgpack-resp      | 200    | 420 B | 1.3 KB      | 1.1×         | 232.6 ms | 232.7 ms |
| msgpack-both      | 200    | 405 B | 1.3 KB      | 1.1×         | 239.0 ms | 239.2 ms |
| msgpack-both+gzip | 200    | 428 B | 1.1 KB      | 1.2×         | 240.7 ms | 240.8 ms |

## tools/call: `Playwright__playwright_post`

| variant           | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-------------------|--------|-------|-------------|--------------|---------|---------|
| json              | 200    | 451 B | 1.4 KB      | 1.0×         | 75.6 ms | 75.7 ms |
| msgpack-resp      | 200    | 443 B | 1.3 KB      | 1.1×         | 73.1 ms | 73.2 ms |
| msgpack-both      | 200    | 424 B | 1.3 KB      | 1.1×         | 81.3 ms | 81.4 ms |
| msgpack-both+gzip | 200    | 447 B | 1.1 KB      | 1.2×         | 76.0 ms | 76.2 ms |

## tools/call: `Playwright__playwright_patch`

| variant           | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-------------------|--------|-------|-------------|--------------|---------|---------|
| json              | 200    | 452 B | 1.4 KB      | 1.0×         | 73.5 ms | 73.9 ms |
| msgpack-resp      | 200    | 444 B | 1.3 KB      | 1.1×         | 73.1 ms | 73.2 ms |
| msgpack-both      | 200    | 425 B | 1.3 KB      | 1.1×         | 71.4 ms | 71.5 ms |
| msgpack-both+gzip | 200    | 448 B | 1.1 KB      | 1.2×         | 70.3 ms | 70.5 ms |

## tools/call: `Playwright__playwright_delete`

| variant           | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-------------------|--------|-------|-------------|--------------|---------|---------|
| json              | 200    | 431 B | 1.4 KB      | 1.0×         | 70.5 ms | 70.6 ms |
| msgpack-resp      | 200    | 423 B | 1.3 KB      | 1.1×         | 69.3 ms | 69.4 ms |
| msgpack-both      | 200    | 408 B | 1.3 KB      | 1.1×         | 74.8 ms | 74.9 ms |
| msgpack-both+gzip | 200    | 431 B | 1.1 KB      | 1.2×         | 68.7 ms | 68.9 ms |

## tools/call: `Playwright__playwright_evaluate`

| variant           | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-------------------|--------|-------|-------------|--------------|--------|--------|
| json              | 200    | 428 B | 1.8 KB      | 1.0×         | 3.67 s | 3.67 s |
| msgpack-resp      | 200    | 420 B | 1.8 KB      | 1.0×         | 3.71 s | 3.71 s |
| msgpack-both      | 200    | 405 B | 1.8 KB      | 1.0×         | 3.69 s | 3.69 s |
| msgpack-both+gzip | 200    | 428 B | 1.0 KB      | 1.8×         | 3.63 s | 3.63 s |

## tools/call: `Playwright__playwright_console_logs`

| variant           | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-------------------|--------|-------|-------------|--------------|---------|---------|
| json              | 200    | 410 B | 802 B       | 1.0×         | 11.2 ms | 11.3 ms |
| msgpack-resp      | 200    | 402 B | 747 B       | 1.1×         | 9.9 ms  | 10.1 ms |
| msgpack-both      | 200    | 390 B | 747 B       | 1.1×         | 9.3 ms  | 9.4 ms  |
| msgpack-both+gzip | 200    | 413 B | 798 B       | 1.0×         | 9.0 ms  | 9.1 ms  |

## tools/call: `Playwright__playwright_assert_response`

| variant           | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-------------------|--------|-------|-------------|--------------|--------|--------|
| json              | 200    | 431 B | 1.8 KB      | 1.0×         | 3.71 s | 3.71 s |
| msgpack-resp      | 200    | 423 B | 1.8 KB      | 1.0×         | 3.68 s | 3.68 s |
| msgpack-both      | 200    | 409 B | 1.8 KB      | 1.0×         | 3.68 s | 3.68 s |
| msgpack-both+gzip | 200    | 432 B | 1.0 KB      | 1.8×         | 3.71 s | 3.71 s |

## tools/call: `Playwright__playwright_custom_user_agent`

| variant           | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-------------------|--------|-------|-------------|--------------|--------|--------|
| json              | 200    | 441 B | 1.8 KB      | 1.0×         | 3.72 s | 3.72 s |
| msgpack-resp      | 200    | 433 B | 1.8 KB      | 1.0×         | 3.69 s | 3.69 s |
| msgpack-both      | 200    | 419 B | 1.8 KB      | 1.0×         | 3.64 s | 3.64 s |
| msgpack-both+gzip | 200    | 442 B | 1.0 KB      | 1.8×         | 3.68 s | 3.68 s |

## tools/call: `Playwright__playwright_get_visible_text`

| variant           | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-------------------|--------|-------|-------------|--------------|--------|--------|
| json              | 200    | 415 B | 1.8 KB      | 1.0×         | 3.67 s | 3.67 s |
| msgpack-resp      | 200    | 407 B | 1.8 KB      | 1.0×         | 3.65 s | 3.65 s |
| msgpack-both      | 200    | 396 B | 1.8 KB      | 1.0×         | 3.73 s | 3.73 s |
| msgpack-both+gzip | 200    | 419 B | 1.0 KB      | 1.8×         | 3.65 s | 3.65 s |

## tools/call: `Playwright__playwright_get_visible_html`

| variant           | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-------------------|--------|-------|-------------|--------------|--------|--------|
| json              | 200    | 415 B | 1.8 KB      | 1.0×         | 3.73 s | 3.73 s |
| msgpack-resp      | 200    | 407 B | 1.8 KB      | 1.0×         | 3.70 s | 3.70 s |
| msgpack-both      | 200    | 396 B | 1.8 KB      | 1.0×         | 3.66 s | 3.66 s |
| msgpack-both+gzip | 200    | 419 B | 1.0 KB      | 1.8×         | 3.69 s | 3.69 s |

## tools/call: `Playwright__playwright_go_back`

| variant           | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-------------------|--------|-------|-------------|--------------|--------|--------|
| json              | 200    | 406 B | 1.8 KB      | 1.0×         | 3.66 s | 3.66 s |
| msgpack-resp      | 200    | 398 B | 1.8 KB      | 1.0×         | 3.76 s | 3.76 s |
| msgpack-both      | 200    | 385 B | 1.8 KB      | 1.0×         | 3.68 s | 3.68 s |
| msgpack-both+gzip | 200    | 408 B | 1.0 KB      | 1.8×         | 3.72 s | 3.72 s |

## tools/call: `Playwright__playwright_go_forward`

| variant           | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-------------------|--------|-------|-------------|--------------|--------|--------|
| json              | 200    | 409 B | 1.8 KB      | 1.0×         | 3.68 s | 3.68 s |
| msgpack-resp      | 200    | 401 B | 1.8 KB      | 1.0×         | 3.75 s | 3.75 s |
| msgpack-both      | 200    | 389 B | 1.8 KB      | 1.0×         | 3.77 s | 3.77 s |
| msgpack-both+gzip | 200    | 412 B | 1.0 KB      | 1.8×         | 3.72 s | 3.72 s |

## tools/call: `Playwright__playwright_expect_response`

| variant           | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-------------------|--------|-------|-------------|--------------|--------|--------|
| json              | 200    | 460 B | 1.8 KB      | 1.0×         | 3.68 s | 3.68 s |
| msgpack-resp      | 200    | 452 B | 1.8 KB      | 1.0×         | 3.73 s | 3.73 s |
| msgpack-both      | 200    | 434 B | 1.8 KB      | 1.0×         | 3.64 s | 3.64 s |
| msgpack-both+gzip | 200    | 457 B | 1.0 KB      | 1.8×         | 3.78 s | 3.78 s |

## tools/call: `Playwright__playwright_put`

| variant           | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-------------------|--------|-------|-------------|--------------|---------|---------|
| json              | 200    | 451 B | 1.4 KB      | 1.0×         | 73.1 ms | 73.3 ms |
| msgpack-resp      | 200    | 443 B | 1.3 KB      | 1.1×         | 69.0 ms | 69.2 ms |
| msgpack-both      | 200    | 424 B | 1.3 KB      | 1.1×         | 74.7 ms | 74.9 ms |
| msgpack-both+gzip | 200    | 447 B | 1.1 KB      | 1.2×         | 71.6 ms | 71.8 ms |

## tools/call: `Playwright__playwright_save_as_pdf`

| variant           | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-------------------|--------|-------|-------------|--------------|--------|--------|
| json              | 200    | 436 B | 1.8 KB      | 1.0×         | 3.75 s | 3.75 s |
| msgpack-resp      | 200    | 428 B | 1.8 KB      | 1.0×         | 3.61 s | 3.61 s |
| msgpack-both      | 200    | 414 B | 1.8 KB      | 1.0×         | 3.68 s | 3.68 s |
| msgpack-both+gzip | 200    | 437 B | 1.0 KB      | 1.8×         | 3.68 s | 3.68 s |

## tools/call: `Playwright__playwright_click_and_switch_tab`

| variant           | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-------------------|--------|-------|-------------|--------------|--------|--------|
| json              | 200    | 443 B | 1.8 KB      | 1.0×         | 3.79 s | 3.79 s |
| msgpack-resp      | 200    | 435 B | 1.8 KB      | 1.0×         | 3.78 s | 3.78 s |
| msgpack-both      | 200    | 421 B | 1.8 KB      | 1.0×         | 3.70 s | 3.70 s |
| msgpack-both+gzip | 200    | 444 B | 1.0 KB      | 1.8×         | 3.82 s | 3.82 s |

## tools/call: `Sequential-Thinking__sequentialthinking`

| variant           | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-------------------|--------|-------|-------------|--------------|---------|---------|
| json              | 200    | 500 B | 1012 B      | 1.0×         | 13.9 ms | 14.0 ms |
| msgpack-resp      | 200    | 492 B | 925 B       | 1.1×         | 15.1 ms | 15.3 ms |
| msgpack-both      | 200    | 465 B | 925 B       | 1.1×         | 14.6 ms | 14.7 ms |
| msgpack-both+gzip | 200    | 488 B | 878 B       | 1.2×         | 14.8 ms | 14.9 ms |

## tools/call: `Calculator__calculate`

| variant           | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-------------------|--------|-------|-------------|--------------|---------|---------|
| json              | 200    | 423 B | 822 B       | 1.0×         | 12.5 ms | 12.6 ms |
| msgpack-resp      | 200    | 415 B | 768 B       | 1.1×         | 10.5 ms | 10.7 ms |
| msgpack-both      | 200    | 400 B | 768 B       | 1.1×         | 9.0 ms  | 9.1 ms  |
| msgpack-both+gzip | 200    | 423 B | 812 B       | 1.0×         | 8.2 ms  | 8.3 ms  |

## tools/call: `Time__get_current_time`

| variant           | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-------------------|--------|-------|-------------|--------------|---------|---------|
| json              | 200    | 422 B | 864 B       | 1.0×         | 11.0 ms | 11.1 ms |
| msgpack-resp      | 200    | 414 B | 810 B       | 1.1×         | 8.8 ms  | 8.9 ms  |
| msgpack-both      | 200    | 399 B | 810 B       | 1.1×         | 9.9 ms  | 10.0 ms |
| msgpack-both+gzip | 200    | 422 B | 840 B       | 1.0×         | 8.1 ms  | 8.2 ms  |

## tools/call: `Time__convert_time`

| variant           | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-------------------|--------|-------|-------------|--------------|--------|--------|
| json              | 200    | 478 B | 864 B       | 1.0×         | 7.7 ms | 7.9 ms |
| msgpack-resp      | 200    | 470 B | 810 B       | 1.1×         | 7.4 ms | 7.5 ms |
| msgpack-both      | 200    | 447 B | 810 B       | 1.1×         | 7.9 ms | 8.0 ms |
| msgpack-both+gzip | 200    | 470 B | 839 B       | 1.0×         | 9.4 ms | 9.5 ms |

## tools/call: `Playwright__playwright_drag`

| variant           | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-------------------|--------|-------|-------------|--------------|--------|--------|
| json              | 200    | 464 B | 1.8 KB      | 1.0×         | 3.69 s | 3.69 s |
| msgpack-resp      | 200    | 456 B | 1.8 KB      | 1.0×         | 3.76 s | 3.76 s |
| msgpack-both      | 200    | 437 B | 1.8 KB      | 1.0×         | 3.68 s | 3.68 s |
| msgpack-both+gzip | 200    | 460 B | 1.0 KB      | 1.8×         | 3.82 s | 3.82 s |

## tools/call: `Playwright__playwright_press_key`

| variant           | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-------------------|--------|-------|-------------|--------------|--------|--------|
| json              | 200    | 427 B | 1.8 KB      | 1.0×         | 3.69 s | 3.69 s |
| msgpack-resp      | 200    | 419 B | 1.8 KB      | 1.0×         | 3.67 s | 3.67 s |
| msgpack-both      | 200    | 405 B | 1.8 KB      | 1.0×         | 3.72 s | 3.72 s |
| msgpack-both+gzip | 200    | 428 B | 1.0 KB      | 1.8×         | 3.75 s | 3.75 s |

## tools/call: `Playwright__playwright_resize`

| variant           | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-------------------|--------|-------|-------------|--------------|--------|--------|
| json              | 200    | 405 B | 1.8 KB      | 1.0×         | 3.77 s | 3.77 s |
| msgpack-resp      | 200    | 397 B | 1.8 KB      | 1.0×         | 3.66 s | 3.66 s |
| msgpack-both      | 200    | 384 B | 1.8 KB      | 1.0×         | 3.73 s | 3.73 s |
| msgpack-both+gzip | 200    | 407 B | 1.0 KB      | 1.8×         | 3.71 s | 3.71 s |
