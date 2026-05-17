# MCP wire bench — 2026-05-08T22-24-23Z

Target: `http://192.168.1.88:12008/metamcp/openwebui-api/mcp`
Vocab map: `https://cdn.jsdelivr.net/gh/wdunn001/codec-maps@main/maps/qwen/qwen2.json` (sha256 `sha256:88731…`)

## initialize

| variant               | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-----------------------|--------|-------|-------------|--------------|--------|--------|
| json                  | 200    | 402 B | 892 B       | 1.0×         | 5.1 ms | 5.3 ms |
| msgpack-resp          | 200    | 394 B | 826 B       | 1.1×         | 5.3 ms | 5.4 ms |
| msgpack-both          | 200    | 371 B | 826 B       | 1.1×         | 5.5 ms | 5.6 ms |
| msgpack-both+gzip     | 200    | 394 B | 856 B       | 1.0×         | 5.0 ms | 5.4 ms |
| msgpack-both+gzip+map | 200    | 561 B | 856 B       | 1.0×         | 1.14 s | 1.14 s |

## tools/list

| variant               | status | req   | resp (wire) | resp vs json | TTFB    | total    |
|-----------------------|--------|-------|-------------|--------------|---------|----------|
| json                  | 200    | 349 B | 20.7 KB     | 1.0×         | 99.7 ms | 101.1 ms |
| msgpack-resp          | 200    | 341 B | 18.5 KB     | 1.1×         | 2.13 s  | 2.13 s   |
| msgpack-both          | 200    | 336 B | 18.5 KB     | 1.1×         | 2.11 s  | 2.11 s   |
| msgpack-both+gzip     | 200    | 360 B | 5.7 KB      | 3.6×         | 73.0 ms | 74.3 ms  |
| msgpack-both+gzip+map | 200    | 527 B | 5.8 KB      | 3.6×         | 2.24 s  | 2.24 s   |

## tools/call — `YouTube-Transcripts__get_transcript`

| variant               | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-----------------------|--------|-------|-------------|--------------|---------|---------|
| json                  | 200    | 458 B | 825 B       | 1.0×         | 11.6 ms | 12.0 ms |
| msgpack-resp          | 200    | 450 B | 779 B       | 1.1×         | 11.7 ms | 11.8 ms |
| msgpack-both          | 200    | 432 B | 779 B       | 1.1×         | 11.0 ms | 11.1 ms |
| msgpack-both+gzip     | 200    | 455 B | 814 B       | 1.0×         | 10.2 ms | 10.5 ms |
| msgpack-both+gzip+map | 200    | 622 B | 814 B       | 1.0×         | 9.6 ms  | 9.8 ms  |

## tools/call — `Playwright__start_codegen_session`

| variant               | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-----------------------|--------|-------|-------------|--------------|---------|---------|
| json                  | 200    | 420 B | 1020 B      | 1.0×         | 12.0 ms | 12.1 ms |
| msgpack-resp          | 200    | 412 B | 945 B       | 1.1×         | 13.2 ms | 13.4 ms |
| msgpack-both          | 200    | 398 B | 945 B       | 1.1×         | 13.2 ms | 13.3 ms |
| msgpack-both+gzip     | 200    | 421 B | 934 B       | 1.1×         | 12.5 ms | 12.7 ms |
| msgpack-both+gzip+map | 200    | 588 B | 1.2 KB      | 1.2× smaller | 17.5 ms | 17.8 ms |

## tools/call — `Sequential-Thinking__sequentialthinking`

| variant               | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-----------------------|--------|-------|-------------|--------------|---------|---------|
| json                  | 200    | 499 B | 1011 B      | 1.0×         | 10.0 ms | 10.1 ms |
| msgpack-resp          | 200    | 491 B | 924 B       | 1.1×         | 11.2 ms | 11.4 ms |
| msgpack-both          | 200    | 464 B | 924 B       | 1.1×         | 13.3 ms | 13.4 ms |
| msgpack-both+gzip     | 200    | 487 B | 877 B       | 1.2×         | 13.8 ms | 13.9 ms |
| msgpack-both+gzip+map | 200    | 654 B | 1.0 KB      | 1.0× smaller | 12.9 ms | 13.1 ms |

## tools/call — `Playwright__end_codegen_session`

| variant               | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-----------------------|--------|-------|-------------|--------------|---------|---------|
| json                  | 200    | 431 B | 824 B       | 1.0×         | 10.4 ms | 10.6 ms |
| msgpack-resp          | 200    | 423 B | 770 B       | 1.1×         | 10.4 ms | 10.5 ms |
| msgpack-both          | 200    | 408 B | 770 B       | 1.1×         | 11.1 ms | 11.2 ms |
| msgpack-both+gzip     | 200    | 431 B | 813 B       | 1.0×         | 10.7 ms | 10.9 ms |
| msgpack-both+gzip+map | 200    | 598 B | 938 B       | 1.1× smaller | 10.6 ms | 11.2 ms |

## tools/call — `Playwright__playwright_navigate`

| variant               | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-----------------------|--------|-------|-------------|--------------|--------|--------|
| json                  | 200    | 433 B | 1.8 KB      | 1.0×         | 3.67 s | 3.67 s |
| msgpack-resp          | 200    | 425 B | 1.8 KB      | 1.0×         | 3.66 s | 3.66 s |
| msgpack-both          | 200    | 410 B | 1.8 KB      | 1.0×         | 3.69 s | 3.69 s |
| msgpack-both+gzip     | 200    | 433 B | 1.0 KB      | 1.8×         | 3.65 s | 3.65 s |
| msgpack-both+gzip+map | 200    | 600 B | 1.4 KB      | 1.3×         | 3.81 s | 3.81 s |

## tools/call — `Playwright__clear_codegen_session`

| variant               | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-----------------------|--------|-------|-------------|--------------|---------|---------|
| json                  | 200    | 433 B | 793 B       | 1.0×         | 11.9 ms | 12.0 ms |
| msgpack-resp          | 200    | 425 B | 738 B       | 1.1×         | 10.6 ms | 10.8 ms |
| msgpack-both          | 200    | 411 B | 738 B       | 1.1×         | 11.9 ms | 12.0 ms |
| msgpack-both+gzip     | 200    | 434 B | 789 B       | 1.0×         | 11.3 ms | 11.4 ms |
| msgpack-both+gzip+map | 200    | 601 B | 899 B       | 1.1× smaller | 11.0 ms | 11.2 ms |

## tools/call — `Playwright__get_codegen_session`

| variant               | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-----------------------|--------|-------|-------------|--------------|---------|---------|
| json                  | 200    | 431 B | 793 B       | 1.0×         | 12.3 ms | 12.4 ms |
| msgpack-resp          | 200    | 423 B | 738 B       | 1.1×         | 26.8 ms | 27.0 ms |
| msgpack-both          | 200    | 408 B | 738 B       | 1.1×         | 14.8 ms | 14.9 ms |
| msgpack-both+gzip     | 200    | 431 B | 789 B       | 1.0×         | 12.5 ms | 12.6 ms |
| msgpack-both+gzip+map | 200    | 598 B | 899 B       | 1.1× smaller | 13.4 ms | 13.6 ms |

## tools/call — `Playwright__playwright_iframe_fill`

| variant               | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-----------------------|--------|-------|-------------|--------------|--------|--------|
| json                  | 200    | 486 B | 1.8 KB      | 1.0×         | 3.67 s | 3.67 s |
| msgpack-resp          | 200    | 478 B | 1.8 KB      | 1.0×         | 3.68 s | 3.68 s |
| msgpack-both          | 200    | 456 B | 1.8 KB      | 1.0×         | 3.76 s | 3.77 s |
| msgpack-both+gzip     | 200    | 479 B | 1.0 KB      | 1.8×         | 3.69 s | 3.69 s |
| msgpack-both+gzip+map | 200    | 646 B | 1.4 KB      | 1.3×         | 3.67 s | 3.67 s |

## tools/call — `Playwright__playwright_fill`

| variant               | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-----------------------|--------|-------|-------------|--------------|--------|--------|
| json                  | 200    | 448 B | 1.8 KB      | 1.0×         | 3.66 s | 3.66 s |
| msgpack-resp          | 200    | 440 B | 1.8 KB      | 1.0×         | 3.76 s | 3.76 s |
| msgpack-both          | 200    | 421 B | 1.8 KB      | 1.0×         | 3.68 s | 3.68 s |
| msgpack-both+gzip     | 200    | 444 B | 1.0 KB      | 1.8×         | 3.68 s | 3.68 s |
| msgpack-both+gzip+map | 200    | 611 B | 1.4 KB      | 1.3×         | 3.74 s | 3.74 s |

## tools/call — `Playwright__playwright_select`

| variant               | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-----------------------|--------|-------|-------------|--------------|--------|--------|
| json                  | 200    | 450 B | 1.8 KB      | 1.0×         | 3.70 s | 3.70 s |
| msgpack-resp          | 200    | 442 B | 1.8 KB      | 1.0×         | 3.67 s | 3.68 s |
| msgpack-both          | 200    | 423 B | 1.8 KB      | 1.0×         | 3.72 s | 3.72 s |
| msgpack-both+gzip     | 200    | 446 B | 1.0 KB      | 1.8×         | 3.67 s | 3.67 s |
| msgpack-both+gzip+map | 200    | 613 B | 1.4 KB      | 1.3×         | 3.64 s | 3.64 s |

## tools/call — `Playwright__playwright_hover`

| variant               | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-----------------------|--------|-------|-------------|--------------|--------|--------|
| json                  | 200    | 427 B | 1.8 KB      | 1.0×         | 3.70 s | 3.70 s |
| msgpack-resp          | 200    | 419 B | 1.8 KB      | 1.0×         | 3.72 s | 3.72 s |
| msgpack-both          | 200    | 404 B | 1.8 KB      | 1.0×         | 3.72 s | 3.72 s |
| msgpack-both+gzip     | 200    | 427 B | 1.0 KB      | 1.8×         | 3.65 s | 3.65 s |
| msgpack-both+gzip+map | 200    | 594 B | 1.4 KB      | 1.3×         | 3.71 s | 3.71 s |

## tools/call — `Playwright__playwright_upload_file`

| variant               | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-----------------------|--------|-------|-------------|--------------|--------|--------|
| json                  | 200    | 458 B | 1.8 KB      | 1.0×         | 3.74 s | 3.74 s |
| msgpack-resp          | 200    | 450 B | 1.8 KB      | 1.0×         | 3.71 s | 3.71 s |
| msgpack-both          | 200    | 432 B | 1.8 KB      | 1.0×         | 3.70 s | 3.70 s |
| msgpack-both+gzip     | 200    | 455 B | 1.0 KB      | 1.8×         | 3.66 s | 3.66 s |
| msgpack-both+gzip+map | 200    | 622 B | 1.4 KB      | 1.3×         | 3.71 s | 3.71 s |

## tools/call — `Playwright__playwright_click`

| variant               | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-----------------------|--------|-------|-------------|--------------|--------|--------|
| json                  | 200    | 427 B | 1.8 KB      | 1.0×         | 3.68 s | 3.68 s |
| msgpack-resp          | 200    | 419 B | 1.8 KB      | 1.0×         | 3.79 s | 3.79 s |
| msgpack-both          | 200    | 404 B | 1.8 KB      | 1.0×         | 3.69 s | 3.69 s |
| msgpack-both+gzip     | 200    | 427 B | 1.0 KB      | 1.8×         | 3.68 s | 3.68 s |
| msgpack-both+gzip+map | 200    | 594 B | 1.4 KB      | 1.3×         | 3.62 s | 3.62 s |

## tools/call — `Playwright__playwright_screenshot`

| variant               | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-----------------------|--------|-------|-------------|--------------|--------|--------|
| json                  | 200    | 428 B | 1.8 KB      | 1.0×         | 3.67 s | 3.67 s |
| msgpack-resp          | 200    | 420 B | 1.8 KB      | 1.0×         | 3.70 s | 3.70 s |
| msgpack-both          | 200    | 406 B | 1.8 KB      | 1.0×         | 3.69 s | 3.69 s |
| msgpack-both+gzip     | 200    | 429 B | 1.0 KB      | 1.8×         | 3.70 s | 3.70 s |
| msgpack-both+gzip+map | 200    | 596 B | 1.4 KB      | 1.3×         | 3.66 s | 3.66 s |

## tools/call — `Playwright__playwright_iframe_click`

| variant               | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-----------------------|--------|-------|-------------|--------------|--------|--------|
| json                  | 200    | 465 B | 1.8 KB      | 1.0×         | 3.72 s | 3.72 s |
| msgpack-resp          | 200    | 457 B | 1.8 KB      | 1.0×         | 3.63 s | 3.63 s |
| msgpack-both          | 200    | 439 B | 1.8 KB      | 1.0×         | 3.70 s | 3.70 s |
| msgpack-both+gzip     | 200    | 462 B | 1.0 KB      | 1.8×         | 3.69 s | 3.69 s |
| msgpack-both+gzip+map | 200    | 629 B | 1.4 KB      | 1.3×         | 3.76 s | 3.76 s |

## tools/call — `Playwright__playwright_close`

| variant               | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-----------------------|--------|-------|-------------|--------------|---------|---------|
| json                  | 200    | 403 B | 793 B       | 1.0×         | 12.3 ms | 12.4 ms |
| msgpack-resp          | 200    | 395 B | 737 B       | 1.1×         | 11.5 ms | 11.6 ms |
| msgpack-both          | 200    | 382 B | 737 B       | 1.1×         | 11.5 ms | 11.7 ms |
| msgpack-both+gzip     | 200    | 405 B | 788 B       | 1.0×         | 11.1 ms | 11.3 ms |
| msgpack-both+gzip+map | 200    | 572 B | 891 B       | 1.1× smaller | 10.1 ms | 10.2 ms |

## tools/call — `Playwright__playwright_get`

| variant               | status | req   | resp (wire) | resp vs json | TTFB     | total    |
|-----------------------|--------|-------|-------------|--------------|----------|----------|
| json                  | 200    | 428 B | 1.4 KB      | 1.0×         | 298.9 ms | 299.0 ms |
| msgpack-resp          | 200    | 420 B | 1.3 KB      | 1.1×         | 231.9 ms | 232.0 ms |
| msgpack-both          | 200    | 405 B | 1.3 KB      | 1.1×         | 230.9 ms | 231.0 ms |
| msgpack-both+gzip     | 200    | 428 B | 1.1 KB      | 1.2×         | 234.2 ms | 234.4 ms |
| msgpack-both+gzip+map | 200    | 595 B | 1.6 KB      | 1.2× smaller | 239.7 ms | 239.9 ms |

## tools/call — `Playwright__playwright_post`

| variant               | status | req   | resp (wire) | resp vs json | TTFB     | total    |
|-----------------------|--------|-------|-------------|--------------|----------|----------|
| json                  | 200    | 451 B | 1.4 KB      | 1.0×         | 154.7 ms | 154.9 ms |
| msgpack-resp          | 200    | 443 B | 1.3 KB      | 1.1×         | 74.0 ms  | 74.2 ms  |
| msgpack-both          | 200    | 425 B | 1.3 KB      | 1.1×         | 77.0 ms  | 77.1 ms  |
| msgpack-both+gzip     | 200    | 448 B | 1.1 KB      | 1.2×         | 76.2 ms  | 76.4 ms  |
| msgpack-both+gzip+map | 200    | 615 B | 1.6 KB      | 1.2× smaller | 73.3 ms  | 73.5 ms  |

## tools/call — `Playwright__playwright_put`

| variant               | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-----------------------|--------|-------|-------------|--------------|---------|---------|
| json                  | 200    | 451 B | 1.4 KB      | 1.0×         | 70.6 ms | 70.7 ms |
| msgpack-resp          | 200    | 443 B | 1.3 KB      | 1.1×         | 71.0 ms | 71.3 ms |
| msgpack-both          | 200    | 424 B | 1.3 KB      | 1.1×         | 71.8 ms | 72.0 ms |
| msgpack-both+gzip     | 200    | 447 B | 1.1 KB      | 1.2×         | 71.3 ms | 71.5 ms |
| msgpack-both+gzip+map | 200    | 614 B | 1.6 KB      | 1.2× smaller | 73.1 ms | 73.3 ms |

## tools/call — `Playwright__playwright_patch`

| variant               | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-----------------------|--------|-------|-------------|--------------|---------|---------|
| json                  | 200    | 453 B | 1.4 KB      | 1.0×         | 79.0 ms | 79.1 ms |
| msgpack-resp          | 200    | 445 B | 1.3 KB      | 1.1×         | 72.8 ms | 73.0 ms |
| msgpack-both          | 200    | 426 B | 1.3 KB      | 1.1×         | 73.5 ms | 73.6 ms |
| msgpack-both+gzip     | 200    | 449 B | 1.1 KB      | 1.2×         | 69.2 ms | 69.3 ms |
| msgpack-both+gzip+map | 200    | 616 B | 1.6 KB      | 1.2× smaller | 70.8 ms | 71.0 ms |

## tools/call — `Playwright__playwright_delete`

| variant               | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-----------------------|--------|-------|-------------|--------------|---------|---------|
| json                  | 200    | 432 B | 1.4 KB      | 1.0×         | 71.8 ms | 71.9 ms |
| msgpack-resp          | 200    | 424 B | 1.3 KB      | 1.1×         | 69.1 ms | 69.2 ms |
| msgpack-both          | 200    | 409 B | 1.3 KB      | 1.1×         | 70.2 ms | 70.3 ms |
| msgpack-both+gzip     | 200    | 432 B | 1.1 KB      | 1.2×         | 93.9 ms | 94.0 ms |
| msgpack-both+gzip+map | 200    | 599 B | 1.6 KB      | 1.2× smaller | 69.6 ms | 69.8 ms |

## tools/call — `Playwright__playwright_evaluate`

| variant               | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-----------------------|--------|-------|-------------|--------------|--------|--------|
| json                  | 200    | 429 B | 1.8 KB      | 1.0×         | 3.76 s | 3.76 s |
| msgpack-resp          | 200    | 421 B | 1.8 KB      | 1.0×         | 3.72 s | 3.72 s |
| msgpack-both          | 200    | 406 B | 1.8 KB      | 1.0×         | 3.72 s | 3.72 s |
| msgpack-both+gzip     | 200    | 429 B | 1.0 KB      | 1.8×         | 3.73 s | 3.73 s |
| msgpack-both+gzip+map | 200    | 596 B | 1.4 KB      | 1.3×         | 3.66 s | 3.66 s |

## tools/call — `Playwright__playwright_console_logs`

| variant               | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-----------------------|--------|-------|-------------|--------------|---------|---------|
| json                  | 200    | 411 B | 803 B       | 1.0×         | 11.7 ms | 11.8 ms |
| msgpack-resp          | 200    | 403 B | 748 B       | 1.1×         | 10.9 ms | 11.0 ms |
| msgpack-both          | 200    | 391 B | 748 B       | 1.1×         | 9.9 ms  | 10.1 ms |
| msgpack-both+gzip     | 200    | 414 B | 799 B       | 1.0×         | 11.1 ms | 11.2 ms |
| msgpack-both+gzip+map | 200    | 581 B | 904 B       | 1.1× smaller | 9.7 ms  | 10.1 ms |

## tools/call — `Playwright__playwright_assert_response`

| variant               | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-----------------------|--------|-------|-------------|--------------|--------|--------|
| json                  | 200    | 432 B | 1.8 KB      | 1.0×         | 3.72 s | 3.72 s |
| msgpack-resp          | 200    | 424 B | 1.8 KB      | 1.0×         | 3.71 s | 3.71 s |
| msgpack-both          | 200    | 410 B | 1.8 KB      | 1.0×         | 3.69 s | 3.69 s |
| msgpack-both+gzip     | 200    | 433 B | 1.0 KB      | 1.8×         | 3.69 s | 3.69 s |
| msgpack-both+gzip+map | 200    | 600 B | 1.4 KB      | 1.3×         | 3.75 s | 3.75 s |

## tools/call — `Playwright__playwright_custom_user_agent`

| variant               | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-----------------------|--------|-------|-------------|--------------|--------|--------|
| json                  | 200    | 441 B | 1.8 KB      | 1.0×         | 3.73 s | 3.73 s |
| msgpack-resp          | 200    | 433 B | 1.8 KB      | 1.0×         | 3.80 s | 3.80 s |
| msgpack-both          | 200    | 419 B | 1.8 KB      | 1.0×         | 3.79 s | 3.79 s |
| msgpack-both+gzip     | 200    | 442 B | 1.0 KB      | 1.8×         | 3.69 s | 3.69 s |
| msgpack-both+gzip+map | 200    | 609 B | 1.4 KB      | 1.3×         | 3.69 s | 3.69 s |

## tools/call — `Playwright__playwright_get_visible_text`

| variant               | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-----------------------|--------|-------|-------------|--------------|--------|--------|
| json                  | 200    | 415 B | 1.8 KB      | 1.0×         | 3.72 s | 3.72 s |
| msgpack-resp          | 200    | 407 B | 1.8 KB      | 1.0×         | 3.68 s | 3.68 s |
| msgpack-both          | 200    | 396 B | 1.8 KB      | 1.0×         | 3.69 s | 3.69 s |
| msgpack-both+gzip     | 200    | 419 B | 1.0 KB      | 1.8×         | 3.69 s | 3.69 s |
| msgpack-both+gzip+map | 200    | 586 B | 1.4 KB      | 1.3×         | 3.70 s | 3.70 s |

## tools/call — `Playwright__playwright_get_visible_html`

| variant               | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-----------------------|--------|-------|-------------|--------------|--------|--------|
| json                  | 200    | 415 B | 1.8 KB      | 1.0×         | 3.66 s | 3.66 s |
| msgpack-resp          | 200    | 407 B | 1.8 KB      | 1.0×         | 3.66 s | 3.66 s |
| msgpack-both          | 200    | 396 B | 1.8 KB      | 1.0×         | 3.68 s | 3.68 s |
| msgpack-both+gzip     | 200    | 419 B | 1.0 KB      | 1.8×         | 3.69 s | 3.69 s |
| msgpack-both+gzip+map | 200    | 586 B | 1.4 KB      | 1.3×         | 3.67 s | 3.67 s |

## tools/call — `Playwright__playwright_go_back`

| variant               | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-----------------------|--------|-------|-------------|--------------|--------|--------|
| json                  | 200    | 406 B | 1.8 KB      | 1.0×         | 3.76 s | 3.76 s |
| msgpack-resp          | 200    | 398 B | 1.8 KB      | 1.0×         | 3.68 s | 3.68 s |
| msgpack-both          | 200    | 385 B | 1.8 KB      | 1.0×         | 3.74 s | 3.74 s |
| msgpack-both+gzip     | 200    | 408 B | 1.0 KB      | 1.8×         | 3.65 s | 3.65 s |
| msgpack-both+gzip+map | 200    | 575 B | 1.4 KB      | 1.3×         | 3.67 s | 3.68 s |

## tools/call — `Playwright__playwright_go_forward`

| variant               | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-----------------------|--------|-------|-------------|--------------|--------|--------|
| json                  | 200    | 409 B | 1.8 KB      | 1.0×         | 3.68 s | 3.68 s |
| msgpack-resp          | 200    | 401 B | 1.8 KB      | 1.0×         | 3.68 s | 3.68 s |
| msgpack-both          | 200    | 389 B | 1.8 KB      | 1.0×         | 3.68 s | 3.68 s |
| msgpack-both+gzip     | 200    | 412 B | 1.0 KB      | 1.8×         | 3.70 s | 3.70 s |
| msgpack-both+gzip+map | 200    | 579 B | 1.4 KB      | 1.3×         | 3.67 s | 3.67 s |

## tools/call — `Playwright__playwright_drag`

| variant               | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-----------------------|--------|-------|-------------|--------------|--------|--------|
| json                  | 200    | 464 B | 1.8 KB      | 1.0×         | 3.66 s | 3.66 s |
| msgpack-resp          | 200    | 456 B | 1.8 KB      | 1.0×         | 3.70 s | 3.70 s |
| msgpack-both          | 200    | 437 B | 1.8 KB      | 1.0×         | 3.68 s | 3.68 s |
| msgpack-both+gzip     | 200    | 460 B | 1.0 KB      | 1.8×         | 3.69 s | 3.69 s |
| msgpack-both+gzip+map | 200    | 627 B | 1.4 KB      | 1.3×         | 3.83 s | 3.83 s |

## tools/call — `Playwright__playwright_expect_response`

| variant               | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-----------------------|--------|-------|-------------|--------------|--------|--------|
| json                  | 200    | 460 B | 1.8 KB      | 1.0×         | 3.69 s | 3.69 s |
| msgpack-resp          | 200    | 452 B | 1.8 KB      | 1.0×         | 3.66 s | 3.66 s |
| msgpack-both          | 200    | 434 B | 1.8 KB      | 1.0×         | 3.69 s | 3.69 s |
| msgpack-both+gzip     | 200    | 457 B | 1.0 KB      | 1.8×         | 3.69 s | 3.69 s |
| msgpack-both+gzip+map | 200    | 624 B | 1.4 KB      | 1.3×         | 3.66 s | 3.66 s |

## tools/call — `Playwright__playwright_click_and_switch_tab`

| variant               | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-----------------------|--------|-------|-------------|--------------|--------|--------|
| json                  | 200    | 443 B | 1.8 KB      | 1.0×         | 3.70 s | 3.70 s |
| msgpack-resp          | 200    | 435 B | 1.8 KB      | 1.0×         | 3.67 s | 3.67 s |
| msgpack-both          | 200    | 421 B | 1.8 KB      | 1.0×         | 3.75 s | 3.75 s |
| msgpack-both+gzip     | 200    | 444 B | 1.0 KB      | 1.8×         | 3.67 s | 3.67 s |
| msgpack-both+gzip+map | 200    | 611 B | 1.4 KB      | 1.3×         | 3.70 s | 3.70 s |

## tools/call — `Calculator__calculate`

| variant               | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-----------------------|--------|-------|-------------|--------------|---------|---------|
| json                  | 200    | 423 B | 822 B       | 1.0×         | 10.6 ms | 10.8 ms |
| msgpack-resp          | 200    | 415 B | 768 B       | 1.1×         | 10.2 ms | 10.3 ms |
| msgpack-both          | 200    | 400 B | 768 B       | 1.1×         | 8.9 ms  | 9.0 ms  |
| msgpack-both+gzip     | 200    | 423 B | 812 B       | 1.0×         | 9.9 ms  | 10.1 ms |
| msgpack-both+gzip+map | 200    | 590 B | 924 B       | 1.1× smaller | 10.9 ms | 11.1 ms |

## tools/call — `Time__get_current_time`

| variant               | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-----------------------|--------|-------|-------------|--------------|---------|---------|
| json                  | 200    | 422 B | 864 B       | 1.0×         | 12.4 ms | 12.6 ms |
| msgpack-resp          | 200    | 414 B | 810 B       | 1.1×         | 11.6 ms | 11.8 ms |
| msgpack-both          | 200    | 399 B | 810 B       | 1.1×         | 10.6 ms | 10.7 ms |
| msgpack-both+gzip     | 200    | 422 B | 839 B       | 1.0×         | 9.4 ms  | 9.6 ms  |
| msgpack-both+gzip+map | 200    | 589 B | 995 B       | 1.2× smaller | 9.4 ms  | 9.7 ms  |

## tools/call — `Time__convert_time`

| variant               | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-----------------------|--------|-------|-------------|--------------|---------|---------|
| json                  | 200    | 478 B | 864 B       | 1.0×         | 9.3 ms  | 9.4 ms  |
| msgpack-resp          | 200    | 470 B | 810 B       | 1.1×         | 9.7 ms  | 9.9 ms  |
| msgpack-both          | 200    | 447 B | 810 B       | 1.1×         | 12.2 ms | 12.3 ms |
| msgpack-both+gzip     | 200    | 470 B | 840 B       | 1.0×         | 12.9 ms | 13.1 ms |
| msgpack-both+gzip+map | 200    | 637 B | 996 B       | 1.2× smaller | 12.9 ms | 13.1 ms |

## tools/call — `Playwright__playwright_press_key`

| variant               | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-----------------------|--------|-------|-------------|--------------|--------|--------|
| json                  | 200    | 427 B | 1.8 KB      | 1.0×         | 3.68 s | 3.68 s |
| msgpack-resp          | 200    | 419 B | 1.8 KB      | 1.0×         | 3.65 s | 3.65 s |
| msgpack-both          | 200    | 405 B | 1.8 KB      | 1.0×         | 3.68 s | 3.68 s |
| msgpack-both+gzip     | 200    | 428 B | 1.0 KB      | 1.8×         | 3.72 s | 3.72 s |
| msgpack-both+gzip+map | 200    | 595 B | 1.4 KB      | 1.3×         | 3.70 s | 3.70 s |

## tools/call — `Playwright__playwright_save_as_pdf`

| variant               | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-----------------------|--------|-------|-------------|--------------|--------|--------|
| json                  | 200    | 436 B | 1.8 KB      | 1.0×         | 3.66 s | 3.66 s |
| msgpack-resp          | 200    | 428 B | 1.8 KB      | 1.0×         | 3.71 s | 3.71 s |
| msgpack-both          | 200    | 414 B | 1.8 KB      | 1.0×         | 3.69 s | 3.69 s |
| msgpack-both+gzip     | 200    | 437 B | 1.0 KB      | 1.8×         | 3.71 s | 3.71 s |
| msgpack-both+gzip+map | 200    | 604 B | 1.4 KB      | 1.3×         | 3.69 s | 3.69 s |

## tools/call — `Playwright__playwright_resize`

| variant               | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-----------------------|--------|-------|-------------|--------------|--------|--------|
| json                  | 200    | 405 B | 1.8 KB      | 1.0×         | 3.70 s | 3.70 s |
| msgpack-resp          | 200    | 397 B | 1.8 KB      | 1.0×         | 3.69 s | 3.69 s |
| msgpack-both          | 200    | 384 B | 1.8 KB      | 1.0×         | 3.68 s | 3.68 s |
| msgpack-both+gzip     | 200    | 407 B | 1.0 KB      | 1.8×         | 3.68 s | 3.68 s |
| msgpack-both+gzip+map | 200    | 574 B | 1.4 KB      | 1.3×         | 3.73 s | 3.73 s |
