# MCP wire bench: 2026-05-09T12-17-48Z

Target: `http://192.168.1.88:12008/metamcp/openwebui-api/mcp`
Vocab map: `https://cdn.jsdelivr.net/gh/wdunn001/codec-maps/maps/qwen/qwen2.json` (sha256 `sha256:9db56…`)

## initialize

| variant               | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-----------------------|--------|-------|-------------|--------------|---------|---------|
| json                  | 200    | 402 B | 892 B       | 1.0×         | 9.2 ms  | 9.5 ms  |
| msgpack-resp          | 200    | 394 B | 826 B       | 1.1×         | 12.8 ms | 13.1 ms |
| msgpack-both          | 200    | 371 B | 826 B       | 1.1×         | 10.5 ms | 10.9 ms |
| msgpack-both+gzip     | 200    | 394 B | 856 B       | 1.0×         | 10.2 ms | 10.7 ms |
| msgpack-both+gzip+map | 200    | 556 B | 856 B       | 1.0×         | 1.20 s  | 1.20 s  |

## tools/list

| variant               | status | req   | resp (wire) | resp vs json | TTFB     | total    |
|-----------------------|--------|-------|-------------|--------------|----------|----------|
| json                  | 200    | 349 B | 21.4 KB     | 1.0×         | 167.6 ms | 169.0 ms |
| msgpack-resp          | 200    | 341 B | 19.0 KB     | 1.1×         | 2.30 s   | 2.31 s   |
| msgpack-both          | 200    | 336 B | 19.0 KB     | 1.1×         | 120.0 ms | 121.0 ms |
| msgpack-both+gzip     | 200    | 360 B | 5.9 KB      | 3.6×         | 2.27 s   | 2.27 s   |
| msgpack-both+gzip+map | 200    | 522 B | 5.9 KB      | 3.6×         | 107.6 ms | 107.8 ms |

## tools/call: `Time__get_current_time`

| variant               | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-----------------------|--------|-------|-------------|--------------|---------|---------|
| json                  | 200    | 421 B | 863 B       | 1.0×         | 13.3 ms | 13.5 ms |
| msgpack-resp          | 200    | 413 B | 809 B       | 1.1×         | 10.5 ms | 10.6 ms |
| msgpack-both          | 200    | 398 B | 809 B       | 1.1×         | 9.5 ms  | 9.7 ms  |
| msgpack-both+gzip     | 200    | 421 B | 838 B       | 1.0×         | 10.0 ms | 10.2 ms |
| msgpack-both+gzip+map | 200    | 583 B | 997 B       | 1.2× smaller | 12.2 ms | 12.4 ms |

## tools/call: `codec-time-leaf__get_current_time`

| variant               | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-----------------------|--------|-------|-------------|--------------|---------|---------|
| json                  | 200    | 408 B | 990 B       | 1.0×         | 26.9 ms | 27.1 ms |
| msgpack-resp          | 200    | 400 B | 883 B       | 1.1×         | 10.6 ms | 10.7 ms |
| msgpack-both          | 200    | 388 B | 883 B       | 1.1×         | 12.3 ms | 12.4 ms |
| msgpack-both+gzip     | 200    | 411 B | 931 B       | 1.1×         | 10.0 ms | 10.1 ms |
| msgpack-both+gzip+map | 200    | 573 B | 931 B       | 1.1×         | 9.5 ms  | 9.6 ms  |

## tools/call: `codec-time-leaf__convert_time`

| variant               | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-----------------------|--------|-------|-------------|--------------|---------|---------|
| json                  | 200    | 488 B | 1.0 KB      | 1.0×         | 9.6 ms  | 9.8 ms  |
| msgpack-resp          | 200    | 480 B | 935 B       | 1.1×         | 10.3 ms | 10.5 ms |
| msgpack-both          | 200    | 457 B | 935 B       | 1.1×         | 11.0 ms | 11.2 ms |
| msgpack-both+gzip     | 200    | 480 B | 972 B       | 1.1×         | 9.1 ms  | 9.2 ms  |
| msgpack-both+gzip+map | 200    | 642 B | 972 B       | 1.1×         | 12.0 ms | 12.1 ms |
