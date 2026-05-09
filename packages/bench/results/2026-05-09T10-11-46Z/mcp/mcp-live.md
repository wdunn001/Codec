# MCP wire bench — 2026-05-09T10-11-46Z

Target: `http://192.168.1.88:12008/metamcp/openwebui-api/mcp`
Vocab map: `https://cdn.jsdelivr.net/gh/wdunn001/codec-maps/maps/qwen/qwen2.json` (sha256 `sha256:9db56…`)

## initialize

| variant               | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-----------------------|--------|-------|-------------|--------------|---------|---------|
| json                  | 200    | 402 B | 892 B       | 1.0×         | 10.3 ms | 10.5 ms |
| msgpack-resp          | 200    | 394 B | 826 B       | 1.1×         | 10.4 ms | 10.6 ms |
| msgpack-both          | 200    | 371 B | 826 B       | 1.1×         | 9.9 ms  | 10.4 ms |
| msgpack-both+gzip     | 200    | 394 B | 856 B       | 1.0×         | 7.9 ms  | 8.8 ms  |
| msgpack-both+gzip+map | 200    | 556 B | 856 B       | 1.0×         | 1.98 s  | 1.98 s  |

## tools/list

| variant               | status | req   | resp (wire) | resp vs json | TTFB     | total    |
|-----------------------|--------|-------|-------------|--------------|----------|----------|
| json                  | 200    | 349 B | 21.4 KB     | 1.0×         | 171.9 ms | 173.0 ms |
| msgpack-resp          | 200    | 341 B | 19.0 KB     | 1.1×         | 2.29 s   | 2.29 s   |
| msgpack-both          | 200    | 336 B | 19.0 KB     | 1.1×         | 85.4 ms  | 86.3 ms  |
| msgpack-both+gzip     | 200    | 360 B | 5.9 KB      | 3.6×         | 2.29 s   | 2.29 s   |
| msgpack-both+gzip+map | 200    | 522 B | 5.9 KB      | 3.6×         | 88.7 ms  | 89.3 ms  |

## tools/call — `YouTube-Transcripts__get_transcript`

| variant               | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-----------------------|--------|-------|-------------|--------------|---------|---------|
| json                  | 200    | 458 B | 825 B       | 1.0×         | 13.5 ms | 13.7 ms |
| msgpack-resp          | 200    | 450 B | 779 B       | 1.1×         | 8.6 ms  | 8.7 ms  |
| msgpack-both          | 200    | 432 B | 779 B       | 1.1×         | 8.4 ms  | 8.5 ms  |
| msgpack-both+gzip     | 200    | 455 B | 814 B       | 1.0×         | 8.6 ms  | 8.8 ms  |
| msgpack-both+gzip+map | 200    | 617 B | 814 B       | 1.0×         | 8.0 ms  | 8.2 ms  |

## tools/call — `Playwright__get_codegen_session`

| variant               | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-----------------------|--------|-------|-------------|--------------|---------|---------|
| json                  | 200    | 431 B | 793 B       | 1.0×         | 9.4 ms  | 9.5 ms  |
| msgpack-resp          | 200    | 423 B | 738 B       | 1.1×         | 9.0 ms  | 9.1 ms  |
| msgpack-both          | 200    | 408 B | 738 B       | 1.1×         | 11.9 ms | 12.1 ms |
| msgpack-both+gzip     | 200    | 431 B | 789 B       | 1.0×         | 12.0 ms | 12.1 ms |
| msgpack-both+gzip+map | 200    | 593 B | 899 B       | 1.1× smaller | 15.9 ms | 16.2 ms |

## tools/call — `Playwright__start_codegen_session`

| variant               | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-----------------------|--------|-------|-------------|--------------|---------|---------|
| json                  | 200    | 420 B | 1020 B      | 1.0×         | 11.8 ms | 11.9 ms |
| msgpack-resp          | 200    | 412 B | 945 B       | 1.1×         | 9.2 ms  | 9.3 ms  |
| msgpack-both          | 200    | 398 B | 945 B       | 1.1×         | 7.9 ms  | 8.1 ms  |
| msgpack-both+gzip     | 200    | 421 B | 935 B       | 1.1×         | 7.3 ms  | 7.4 ms  |
| msgpack-both+gzip+map | 200    | 583 B | 1.2 KB      | 1.2× smaller | 7.7 ms  | 8.0 ms  |

## tools/call — `Playwright__end_codegen_session`

| variant               | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-----------------------|--------|-------|-------------|--------------|--------|--------|
| json                  | 200    | 431 B | 824 B       | 1.0×         | 6.6 ms | 6.8 ms |
| msgpack-resp          | 200    | 423 B | 770 B       | 1.1×         | 6.7 ms | 6.8 ms |
| msgpack-both          | 200    | 408 B | 770 B       | 1.1×         | 7.7 ms | 7.9 ms |
| msgpack-both+gzip     | 200    | 431 B | 813 B       | 1.0×         | 7.2 ms | 7.5 ms |
| msgpack-both+gzip+map | 200    | 593 B | 938 B       | 1.1× smaller | 7.7 ms | 8.2 ms |

## tools/call — `Playwright__playwright_navigate`

| variant               | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-----------------------|--------|-------|-------------|--------------|--------|--------|
| json                  | 200    | 433 B | 1.8 KB      | 1.0×         | 3.73 s | 3.73 s |
| msgpack-resp          | 200    | 425 B | 1.8 KB      | 1.0×         | 3.72 s | 3.72 s |
| msgpack-both          | 200    | 410 B | 1.8 KB      | 1.0×         | 3.84 s | 3.84 s |
| msgpack-both+gzip     | 200    | 433 B | 1.0 KB      | 1.8×         | 3.83 s | 3.83 s |
| msgpack-both+gzip+map | 200    | 595 B | 1.4 KB      | 1.3×         | 3.70 s | 3.70 s |

## tools/call — `Playwright__clear_codegen_session`

| variant               | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-----------------------|--------|-------|-------------|--------------|---------|---------|
| json                  | 200    | 433 B | 793 B       | 1.0×         | 14.8 ms | 15.0 ms |
| msgpack-resp          | 200    | 425 B | 738 B       | 1.1×         | 12.6 ms | 12.8 ms |
| msgpack-both          | 200    | 411 B | 738 B       | 1.1×         | 11.7 ms | 11.9 ms |
| msgpack-both+gzip     | 200    | 434 B | 789 B       | 1.0×         | 11.7 ms | 11.8 ms |
| msgpack-both+gzip+map | 200    | 596 B | 900 B       | 1.1× smaller | 11.7 ms | 11.9 ms |

## tools/call — `Playwright__playwright_screenshot`

| variant               | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-----------------------|--------|-------|-------------|--------------|--------|--------|
| json                  | 200    | 428 B | 1.8 KB      | 1.0×         | 3.77 s | 3.77 s |
| msgpack-resp          | 200    | 420 B | 1.8 KB      | 1.0×         | 3.71 s | 3.71 s |
| msgpack-both          | 200    | 406 B | 1.8 KB      | 1.0×         | 3.67 s | 3.67 s |
| msgpack-both+gzip     | 200    | 429 B | 1.0 KB      | 1.8×         | 3.69 s | 3.69 s |
| msgpack-both+gzip+map | 200    | 591 B | 1.4 KB      | 1.3×         | 3.65 s | 3.65 s |

## tools/call — `Playwright__playwright_fill`

| variant               | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-----------------------|--------|-------|-------------|--------------|--------|--------|
| json                  | 200    | 448 B | 1.8 KB      | 1.0×         | 4.11 s | 4.11 s |
| msgpack-resp          | 200    | 440 B | 1.8 KB      | 1.0×         | 3.71 s | 3.71 s |
| msgpack-both          | 200    | 421 B | 1.8 KB      | 1.0×         | 3.73 s | 3.73 s |
| msgpack-both+gzip     | 200    | 444 B | 1.0 KB      | 1.8×         | 3.73 s | 3.73 s |
| msgpack-both+gzip+map | 200    | 606 B | 1.4 KB      | 1.3×         | 3.73 s | 3.73 s |

## tools/call — `Playwright__playwright_select`

| variant               | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-----------------------|--------|-------|-------------|--------------|--------|--------|
| json                  | 200    | 450 B | 1.8 KB      | 1.0×         | 3.65 s | 3.65 s |
| msgpack-resp          | 200    | 442 B | 1.8 KB      | 1.0×         | 3.69 s | 3.69 s |
| msgpack-both          | 200    | 423 B | 1.8 KB      | 1.0×         | 3.64 s | 3.64 s |
| msgpack-both+gzip     | 200    | 446 B | 1.0 KB      | 1.8×         | 3.69 s | 3.69 s |
| msgpack-both+gzip+map | 200    | 608 B | 1.4 KB      | 1.3×         | 3.77 s | 3.77 s |

## tools/call — `Playwright__playwright_hover`

| variant               | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-----------------------|--------|-------|-------------|--------------|--------|--------|
| json                  | 200    | 427 B | 1.8 KB      | 1.0×         | 3.74 s | 3.74 s |
| msgpack-resp          | 200    | 419 B | 1.8 KB      | 1.0×         | 3.73 s | 3.73 s |
| msgpack-both          | 200    | 404 B | 1.8 KB      | 1.0×         | 3.68 s | 3.68 s |
| msgpack-both+gzip     | 200    | 427 B | 1.0 KB      | 1.8×         | 3.70 s | 3.70 s |
| msgpack-both+gzip+map | 200    | 589 B | 1.4 KB      | 1.3×         | 3.76 s | 3.76 s |

## tools/call — `Playwright__playwright_upload_file`

| variant               | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-----------------------|--------|-------|-------------|--------------|--------|--------|
| json                  | 200    | 458 B | 1.8 KB      | 1.0×         | 3.67 s | 3.67 s |
| msgpack-resp          | 200    | 450 B | 1.8 KB      | 1.0×         | 3.68 s | 3.68 s |
| msgpack-both          | 200    | 432 B | 1.8 KB      | 1.0×         | 3.76 s | 3.76 s |
| msgpack-both+gzip     | 200    | 455 B | 1.0 KB      | 1.8×         | 3.75 s | 3.75 s |
| msgpack-both+gzip+map | 200    | 617 B | 1.4 KB      | 1.3×         | 3.70 s | 3.70 s |

## tools/call — `Playwright__playwright_evaluate`

| variant               | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-----------------------|--------|-------|-------------|--------------|--------|--------|
| json                  | 200    | 428 B | 1.8 KB      | 1.0×         | 3.67 s | 3.67 s |
| msgpack-resp          | 200    | 420 B | 1.8 KB      | 1.0×         | 3.68 s | 3.68 s |
| msgpack-both          | 200    | 405 B | 1.8 KB      | 1.0×         | 3.62 s | 3.62 s |
| msgpack-both+gzip     | 200    | 428 B | 1.0 KB      | 1.8×         | 3.70 s | 3.70 s |
| msgpack-both+gzip+map | 200    | 590 B | 1.4 KB      | 1.3×         | 3.63 s | 3.63 s |

## tools/call — `Playwright__playwright_click`

| variant               | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-----------------------|--------|-------|-------------|--------------|--------|--------|
| json                  | 200    | 427 B | 1.8 KB      | 1.0×         | 3.70 s | 3.70 s |
| msgpack-resp          | 200    | 419 B | 1.8 KB      | 1.0×         | 3.77 s | 3.77 s |
| msgpack-both          | 200    | 404 B | 1.8 KB      | 1.0×         | 3.71 s | 3.71 s |
| msgpack-both+gzip     | 200    | 427 B | 1.0 KB      | 1.8×         | 3.69 s | 3.69 s |
| msgpack-both+gzip+map | 200    | 589 B | 1.4 KB      | 1.3×         | 3.67 s | 3.67 s |

## tools/call — `Playwright__playwright_iframe_fill`

| variant               | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-----------------------|--------|-------|-------------|--------------|--------|--------|
| json                  | 200    | 486 B | 1.8 KB      | 1.0×         | 3.65 s | 3.65 s |
| msgpack-resp          | 200    | 478 B | 1.8 KB      | 1.0×         | 3.72 s | 3.72 s |
| msgpack-both          | 200    | 456 B | 1.8 KB      | 1.0×         | 3.65 s | 3.66 s |
| msgpack-both+gzip     | 200    | 479 B | 1.0 KB      | 1.8×         | 3.61 s | 3.61 s |
| msgpack-both+gzip+map | 200    | 641 B | 1.4 KB      | 1.3×         | 3.63 s | 3.63 s |

## tools/call — `Playwright__playwright_iframe_click`

| variant               | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-----------------------|--------|-------|-------------|--------------|--------|--------|
| json                  | 200    | 465 B | 1.8 KB      | 1.0×         | 3.75 s | 3.75 s |
| msgpack-resp          | 200    | 457 B | 1.8 KB      | 1.0×         | 3.71 s | 3.71 s |
| msgpack-both          | 200    | 439 B | 1.8 KB      | 1.0×         | 3.71 s | 3.71 s |
| msgpack-both+gzip     | 200    | 462 B | 1.0 KB      | 1.8×         | 3.69 s | 3.69 s |
| msgpack-both+gzip+map | 200    | 624 B | 1.4 KB      | 1.3×         | 3.72 s | 3.72 s |

## tools/call — `Playwright__playwright_close`

| variant               | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-----------------------|--------|-------|-------------|--------------|---------|---------|
| json                  | 200    | 403 B | 793 B       | 1.0×         | 13.0 ms | 13.2 ms |
| msgpack-resp          | 200    | 395 B | 737 B       | 1.1×         | 10.4 ms | 10.5 ms |
| msgpack-both          | 200    | 382 B | 737 B       | 1.1×         | 10.5 ms | 10.6 ms |
| msgpack-both+gzip     | 200    | 405 B | 788 B       | 1.0×         | 13.6 ms | 13.8 ms |
| msgpack-both+gzip+map | 200    | 567 B | 892 B       | 1.1× smaller | 6.7 ms  | 6.8 ms  |

## tools/call — `Playwright__playwright_get`

| variant               | status | req   | resp (wire) | resp vs json | TTFB     | total    |
|-----------------------|--------|-------|-------------|--------------|----------|----------|
| json                  | 200    | 428 B | 1.4 KB      | 1.0×         | 272.8 ms | 273.1 ms |
| msgpack-resp          | 200    | 420 B | 1.3 KB      | 1.1×         | 239.0 ms | 239.2 ms |
| msgpack-both          | 200    | 405 B | 1.3 KB      | 1.1×         | 227.3 ms | 227.4 ms |
| msgpack-both+gzip     | 200    | 428 B | 1.1 KB      | 1.2×         | 226.9 ms | 227.1 ms |
| msgpack-both+gzip+map | 200    | 590 B | 1.6 KB      | 1.2× smaller | 234.7 ms | 234.8 ms |

## tools/call — `Playwright__playwright_post`

| variant               | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-----------------------|--------|-------|-------------|--------------|---------|---------|
| json                  | 200    | 451 B | 1.4 KB      | 1.0×         | 75.0 ms | 75.1 ms |
| msgpack-resp          | 200    | 443 B | 1.3 KB      | 1.1×         | 74.3 ms | 74.5 ms |
| msgpack-both          | 200    | 425 B | 1.3 KB      | 1.1×         | 71.6 ms | 71.7 ms |
| msgpack-both+gzip     | 200    | 448 B | 1.1 KB      | 1.2×         | 77.0 ms | 77.2 ms |
| msgpack-both+gzip+map | 200    | 610 B | 1.6 KB      | 1.2× smaller | 79.4 ms | 79.5 ms |

## tools/call — `Playwright__playwright_put`

| variant               | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-----------------------|--------|-------|-------------|--------------|---------|---------|
| json                  | 200    | 451 B | 1.4 KB      | 1.0×         | 70.8 ms | 70.9 ms |
| msgpack-resp          | 200    | 443 B | 1.3 KB      | 1.1×         | 69.3 ms | 69.5 ms |
| msgpack-both          | 200    | 424 B | 1.3 KB      | 1.1×         | 69.8 ms | 69.9 ms |
| msgpack-both+gzip     | 200    | 447 B | 1.1 KB      | 1.2×         | 72.0 ms | 72.1 ms |
| msgpack-both+gzip+map | 200    | 609 B | 1.6 KB      | 1.2× smaller | 73.2 ms | 73.6 ms |

## tools/call — `Playwright__playwright_patch`

| variant               | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-----------------------|--------|-------|-------------|--------------|---------|---------|
| json                  | 200    | 453 B | 1.4 KB      | 1.0×         | 79.4 ms | 79.5 ms |
| msgpack-resp          | 200    | 445 B | 1.3 KB      | 1.1×         | 72.7 ms | 72.8 ms |
| msgpack-both          | 200    | 426 B | 1.3 KB      | 1.1×         | 71.6 ms | 71.7 ms |
| msgpack-both+gzip     | 200    | 449 B | 1.1 KB      | 1.2×         | 72.1 ms | 72.3 ms |
| msgpack-both+gzip+map | 200    | 611 B | 1.6 KB      | 1.2× smaller | 74.2 ms | 74.3 ms |

## tools/call — `Playwright__playwright_console_logs`

| variant               | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-----------------------|--------|-------|-------------|--------------|---------|---------|
| json                  | 200    | 411 B | 803 B       | 1.0×         | 10.0 ms | 10.1 ms |
| msgpack-resp          | 200    | 403 B | 748 B       | 1.1×         | 8.7 ms  | 8.9 ms  |
| msgpack-both          | 200    | 391 B | 748 B       | 1.1×         | 9.0 ms  | 9.2 ms  |
| msgpack-both+gzip     | 200    | 414 B | 799 B       | 1.0×         | 8.9 ms  | 9.0 ms  |
| msgpack-both+gzip+map | 200    | 576 B | 904 B       | 1.1× smaller | 9.5 ms  | 9.8 ms  |

## tools/call — `Playwright__playwright_resize`

| variant               | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-----------------------|--------|-------|-------------|--------------|--------|--------|
| json                  | 200    | 405 B | 1.8 KB      | 1.0×         | 3.65 s | 3.65 s |
| msgpack-resp          | 200    | 397 B | 1.8 KB      | 1.0×         | 3.63 s | 3.63 s |
| msgpack-both          | 200    | 384 B | 1.8 KB      | 1.0×         | 3.65 s | 3.65 s |
| msgpack-both+gzip     | 200    | 407 B | 1.0 KB      | 1.8×         | 3.73 s | 3.73 s |
| msgpack-both+gzip+map | 200    | 569 B | 1.4 KB      | 1.3×         | 3.72 s | 3.72 s |

## tools/call — `Playwright__playwright_custom_user_agent`

| variant               | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-----------------------|--------|-------|-------------|--------------|--------|--------|
| json                  | 200    | 441 B | 1.8 KB      | 1.0×         | 3.68 s | 3.68 s |
| msgpack-resp          | 200    | 433 B | 1.8 KB      | 1.0×         | 3.79 s | 3.79 s |
| msgpack-both          | 200    | 419 B | 1.8 KB      | 1.0×         | 3.69 s | 3.69 s |
| msgpack-both+gzip     | 200    | 442 B | 1.0 KB      | 1.8×         | 3.68 s | 3.68 s |
| msgpack-both+gzip+map | 200    | 604 B | 1.4 KB      | 1.3×         | 3.66 s | 3.66 s |

## tools/call — `Playwright__playwright_get_visible_text`

| variant               | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-----------------------|--------|-------|-------------|--------------|--------|--------|
| json                  | 200    | 415 B | 1.8 KB      | 1.0×         | 3.65 s | 3.65 s |
| msgpack-resp          | 200    | 407 B | 1.8 KB      | 1.0×         | 3.69 s | 3.69 s |
| msgpack-both          | 200    | 396 B | 1.8 KB      | 1.0×         | 3.81 s | 3.81 s |
| msgpack-both+gzip     | 200    | 419 B | 1.0 KB      | 1.8×         | 3.76 s | 3.76 s |
| msgpack-both+gzip+map | 200    | 581 B | 1.4 KB      | 1.3×         | 3.73 s | 3.73 s |

## tools/call — `Playwright__playwright_get_visible_html`

| variant               | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-----------------------|--------|-------|-------------|--------------|--------|--------|
| json                  | 200    | 415 B | 1.8 KB      | 1.0×         | 3.71 s | 3.71 s |
| msgpack-resp          | 200    | 407 B | 1.8 KB      | 1.0×         | 3.70 s | 3.70 s |
| msgpack-both          | 200    | 396 B | 1.8 KB      | 1.0×         | 3.64 s | 3.64 s |
| msgpack-both+gzip     | 200    | 419 B | 1.0 KB      | 1.8×         | 3.66 s | 3.66 s |
| msgpack-both+gzip+map | 200    | 581 B | 1.4 KB      | 1.3×         | 3.62 s | 3.62 s |

## tools/call — `Playwright__playwright_go_back`

| variant               | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-----------------------|--------|-------|-------------|--------------|--------|--------|
| json                  | 200    | 406 B | 1.8 KB      | 1.0×         | 3.62 s | 3.62 s |
| msgpack-resp          | 200    | 398 B | 1.8 KB      | 1.0×         | 3.80 s | 3.80 s |
| msgpack-both          | 200    | 385 B | 1.8 KB      | 1.0×         | 3.73 s | 3.73 s |
| msgpack-both+gzip     | 200    | 408 B | 1.0 KB      | 1.8×         | 3.70 s | 3.70 s |
| msgpack-both+gzip+map | 200    | 570 B | 1.4 KB      | 1.3×         | 3.65 s | 3.65 s |

## tools/call — `Playwright__playwright_go_forward`

| variant               | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-----------------------|--------|-------|-------------|--------------|--------|--------|
| json                  | 200    | 409 B | 1.8 KB      | 1.0×         | 3.69 s | 3.69 s |
| msgpack-resp          | 200    | 401 B | 1.8 KB      | 1.0×         | 3.68 s | 3.68 s |
| msgpack-both          | 200    | 389 B | 1.8 KB      | 1.0×         | 3.65 s | 3.65 s |
| msgpack-both+gzip     | 200    | 412 B | 1.0 KB      | 1.8×         | 3.70 s | 3.70 s |
| msgpack-both+gzip+map | 200    | 574 B | 1.4 KB      | 1.3×         | 3.78 s | 3.78 s |

## tools/call — `Playwright__playwright_delete`

| variant               | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-----------------------|--------|-------|-------------|--------------|---------|---------|
| json                  | 200    | 432 B | 1.4 KB      | 1.0×         | 74.2 ms | 74.4 ms |
| msgpack-resp          | 200    | 424 B | 1.3 KB      | 1.1×         | 72.7 ms | 72.9 ms |
| msgpack-both          | 200    | 409 B | 1.3 KB      | 1.1×         | 70.8 ms | 71.0 ms |
| msgpack-both+gzip     | 200    | 432 B | 1.1 KB      | 1.2×         | 76.9 ms | 77.1 ms |
| msgpack-both+gzip+map | 200    | 594 B | 1.6 KB      | 1.2× smaller | 72.3 ms | 72.6 ms |

## tools/call — `Playwright__playwright_expect_response`

| variant               | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-----------------------|--------|-------|-------------|--------------|--------|--------|
| json                  | 200    | 460 B | 1.8 KB      | 1.0×         | 3.74 s | 3.74 s |
| msgpack-resp          | 200    | 452 B | 1.8 KB      | 1.0×         | 3.73 s | 3.73 s |
| msgpack-both          | 200    | 434 B | 1.8 KB      | 1.0×         | 3.71 s | 3.71 s |
| msgpack-both+gzip     | 200    | 457 B | 1.0 KB      | 1.8×         | 3.67 s | 3.67 s |
| msgpack-both+gzip+map | 200    | 619 B | 1.4 KB      | 1.3×         | 3.71 s | 3.71 s |

## tools/call — `Playwright__playwright_assert_response`

| variant               | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-----------------------|--------|-------|-------------|--------------|--------|--------|
| json                  | 200    | 432 B | 1.8 KB      | 1.0×         | 3.69 s | 3.69 s |
| msgpack-resp          | 200    | 424 B | 1.8 KB      | 1.0×         | 3.59 s | 3.59 s |
| msgpack-both          | 200    | 410 B | 1.8 KB      | 1.0×         | 3.64 s | 3.64 s |
| msgpack-both+gzip     | 200    | 433 B | 1.0 KB      | 1.8×         | 3.74 s | 3.74 s |
| msgpack-both+gzip+map | 200    | 595 B | 1.4 KB      | 1.3×         | 3.74 s | 3.74 s |

## tools/call — `Playwright__playwright_save_as_pdf`

| variant               | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-----------------------|--------|-------|-------------|--------------|--------|--------|
| json                  | 200    | 436 B | 1.8 KB      | 1.0×         | 3.75 s | 3.75 s |
| msgpack-resp          | 200    | 428 B | 1.8 KB      | 1.0×         | 3.68 s | 3.68 s |
| msgpack-both          | 200    | 414 B | 1.8 KB      | 1.0×         | 3.62 s | 3.62 s |
| msgpack-both+gzip     | 200    | 437 B | 1.0 KB      | 1.8×         | 3.66 s | 3.66 s |
| msgpack-both+gzip+map | 200    | 599 B | 1.4 KB      | 1.3×         | 3.62 s | 3.62 s |

## tools/call — `Playwright__playwright_click_and_switch_tab`

| variant               | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-----------------------|--------|-------|-------------|--------------|--------|--------|
| json                  | 200    | 443 B | 1.8 KB      | 1.0×         | 3.62 s | 3.62 s |
| msgpack-resp          | 200    | 435 B | 1.8 KB      | 1.0×         | 3.67 s | 3.67 s |
| msgpack-both          | 200    | 421 B | 1.8 KB      | 1.0×         | 3.78 s | 3.78 s |
| msgpack-both+gzip     | 200    | 444 B | 1.0 KB      | 1.8×         | 3.69 s | 3.69 s |
| msgpack-both+gzip+map | 200    | 606 B | 1.4 KB      | 1.3×         | 3.76 s | 3.76 s |

## tools/call — `Sequential-Thinking__sequentialthinking`

| variant               | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-----------------------|--------|-------|-------------|--------------|---------|---------|
| json                  | 200    | 500 B | 1012 B      | 1.0×         | 16.9 ms | 17.0 ms |
| msgpack-resp          | 200    | 492 B | 925 B       | 1.1×         | 14.6 ms | 14.7 ms |
| msgpack-both          | 200    | 465 B | 925 B       | 1.1×         | 14.9 ms | 15.1 ms |
| msgpack-both+gzip     | 200    | 488 B | 878 B       | 1.2×         | 15.4 ms | 15.7 ms |
| msgpack-both+gzip+map | 200    | 650 B | 1.0 KB      | 1.0× smaller | 14.8 ms | 15.1 ms |

## tools/call — `Time__get_current_time`

| variant               | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-----------------------|--------|-------|-------------|--------------|---------|---------|
| json                  | 200    | 422 B | 864 B       | 1.0×         | 15.3 ms | 15.5 ms |
| msgpack-resp          | 200    | 414 B | 810 B       | 1.1×         | 13.5 ms | 13.6 ms |
| msgpack-both          | 200    | 399 B | 810 B       | 1.1×         | 10.7 ms | 10.9 ms |
| msgpack-both+gzip     | 200    | 422 B | 839 B       | 1.0×         | 10.8 ms | 10.9 ms |
| msgpack-both+gzip+map | 200    | 584 B | 997 B       | 1.2× smaller | 12.9 ms | 13.0 ms |

## tools/call — `Time__convert_time`

| variant               | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-----------------------|--------|-------|-------------|--------------|---------|---------|
| json                  | 200    | 478 B | 864 B       | 1.0×         | 13.7 ms | 13.9 ms |
| msgpack-resp          | 200    | 470 B | 810 B       | 1.1×         | 12.1 ms | 12.3 ms |
| msgpack-both          | 200    | 447 B | 810 B       | 1.1×         | 11.7 ms | 11.8 ms |
| msgpack-both+gzip     | 200    | 470 B | 840 B       | 1.0×         | 12.9 ms | 13.1 ms |
| msgpack-both+gzip+map | 200    | 632 B | 997 B       | 1.2× smaller | 12.8 ms | 12.9 ms |

## tools/call — `Playwright__playwright_drag`

| variant               | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-----------------------|--------|-------|-------------|--------------|--------|--------|
| json                  | 200    | 464 B | 1.8 KB      | 1.0×         | 3.68 s | 3.68 s |
| msgpack-resp          | 200    | 456 B | 1.8 KB      | 1.0×         | 3.69 s | 3.69 s |
| msgpack-both          | 200    | 437 B | 1.8 KB      | 1.0×         | 3.66 s | 3.66 s |
| msgpack-both+gzip     | 200    | 460 B | 1.0 KB      | 1.8×         | 3.74 s | 3.74 s |
| msgpack-both+gzip+map | 200    | 622 B | 1.4 KB      | 1.3×         | 3.79 s | 3.79 s |

## tools/call — `Playwright__playwright_press_key`

| variant               | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-----------------------|--------|-------|-------------|--------------|--------|--------|
| json                  | 200    | 427 B | 1.8 KB      | 1.0×         | 3.76 s | 3.76 s |
| msgpack-resp          | 200    | 419 B | 1.8 KB      | 1.0×         | 3.71 s | 3.71 s |
| msgpack-both          | 200    | 405 B | 1.8 KB      | 1.0×         | 3.76 s | 3.76 s |
| msgpack-both+gzip     | 200    | 428 B | 1.0 KB      | 1.8×         | 3.77 s | 3.77 s |
| msgpack-both+gzip+map | 200    | 590 B | 1.4 KB      | 1.3×         | 3.67 s | 3.67 s |

## tools/call — `Calculator__calculate`

| variant               | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-----------------------|--------|-------|-------------|--------------|---------|---------|
| json                  | 200    | 423 B | 822 B       | 1.0×         | 13.3 ms | 13.5 ms |
| msgpack-resp          | 200    | 415 B | 768 B       | 1.1×         | 11.0 ms | 11.2 ms |
| msgpack-both          | 200    | 400 B | 768 B       | 1.1×         | 9.0 ms  | 9.2 ms  |
| msgpack-both+gzip     | 200    | 423 B | 811 B       | 1.0×         | 10.8 ms | 11.0 ms |
| msgpack-both+gzip+map | 200    | 585 B | 925 B       | 1.1× smaller | 8.9 ms  | 9.0 ms  |

## tools/call — `codec-time-leaf__get_current_time`

| variant               | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-----------------------|--------|-------|-------------|--------------|---------|---------|
| json                  | 200    | 409 B | 4.6 KB      | 1.0×         | 45.8 ms | 45.9 ms |
| msgpack-resp          | 200    | 401 B | 4.2 KB      | 1.1×         | 16.6 ms | 16.7 ms |
| msgpack-both          | 200    | 389 B | 4.2 KB      | 1.1×         | 16.4 ms | 16.5 ms |
| msgpack-both+gzip     | 200    | 412 B | 1.1 KB      | 4.2×         | 16.3 ms | 16.6 ms |
| msgpack-both+gzip+map | 200    | 574 B | 1.1 KB      | 4.2×         | 15.9 ms | 16.1 ms |

## tools/call — `codec-time-leaf__convert_time`

| variant               | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-----------------------|--------|-------|-------------|--------------|---------|---------|
| json                  | 200    | 489 B | 4.6 KB      | 1.0×         | 15.3 ms | 15.5 ms |
| msgpack-resp          | 200    | 481 B | 4.2 KB      | 1.1×         | 14.7 ms | 14.8 ms |
| msgpack-both          | 200    | 458 B | 4.2 KB      | 1.1×         | 14.5 ms | 14.8 ms |
| msgpack-both+gzip     | 200    | 481 B | 1.1 KB      | 4.2×         | 15.1 ms | 15.4 ms |
| msgpack-both+gzip+map | 200    | 643 B | 1.1 KB      | 4.2×         | 15.2 ms | 15.4 ms |
