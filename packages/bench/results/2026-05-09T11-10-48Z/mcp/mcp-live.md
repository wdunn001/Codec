# MCP wire bench: 2026-05-09T11-10-48Z

Target: `http://192.168.1.88:12008/metamcp/openwebui-api/mcp`
Vocab map: `https://cdn.jsdelivr.net/gh/wdunn001/codec-maps/maps/qwen/qwen2.json` (sha256 `sha256:9db56…`)

## initialize

| variant               | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-----------------------|--------|-------|-------------|--------------|---------|---------|
| json                  | 200    | 402 B | 892 B       | 1.0×         | 12.2 ms | 12.5 ms |
| msgpack-resp          | 200    | 394 B | 826 B       | 1.1×         | 13.2 ms | 13.5 ms |
| msgpack-both          | 200    | 371 B | 826 B       | 1.1×         | 12.1 ms | 12.5 ms |
| msgpack-both+gzip     | 200    | 394 B | 856 B       | 1.0×         | 10.6 ms | 11.1 ms |
| msgpack-both+gzip+map | 200    | 556 B | 856 B       | 1.0×         | 7.91 s  | 7.91 s  |

## tools/list

| variant               | status | req   | resp (wire) | resp vs json | TTFB     | total    |
|-----------------------|--------|-------|-------------|--------------|----------|----------|
| json                  | 200    | 349 B | 21.4 KB     | 1.0×         | 175.6 ms | 177.0 ms |
| msgpack-resp          | 200    | 341 B | 19.0 KB     | 1.1×         | 2.30 s   | 2.31 s   |
| msgpack-both          | 200    | 336 B | 19.0 KB     | 1.1×         | 113.7 ms | 114.4 ms |
| msgpack-both+gzip     | 200    | 360 B | 5.9 KB      | 3.6×         | 2.39 s   | 2.39 s   |
| msgpack-both+gzip+map | 200    | 522 B | 5.9 KB      | 3.6×         | 109.5 ms | 109.7 ms |

## tools/call: `Time__get_current_time`

| variant               | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-----------------------|--------|-------|-------------|--------------|---------|---------|
| json                  | 200    | 421 B | 863 B       | 1.0×         | 23.9 ms | 24.1 ms |
| msgpack-resp          | 200    | 413 B | 809 B       | 1.1×         | 15.4 ms | 15.6 ms |
| msgpack-both          | 200    | 398 B | 809 B       | 1.1×         | 13.3 ms | 14.5 ms |
| msgpack-both+gzip     | 200    | 421 B | 838 B       | 1.0×         | 15.9 ms | 17.0 ms |
| msgpack-both+gzip+map | 200    | 583 B | 997 B       | 1.2× smaller | 19.0 ms | 19.2 ms |

## tools/call: `codec-time-leaf__convert_time`

| variant               | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-----------------------|--------|-------|-------------|--------------|---------|---------|
| json                  | 200    | 488 B | 4.6 KB      | 1.0×         | 25.9 ms | 26.5 ms |
| msgpack-resp          | 200    | 480 B | 4.2 KB      | 1.1×         | 15.5 ms | 15.7 ms |
| msgpack-both          | 200    | 457 B | 4.2 KB      | 1.1×         | 15.2 ms | 15.5 ms |
| msgpack-both+gzip     | 200    | 480 B | 1.1 KB      | 4.2×         | 24.8 ms | 25.0 ms |
| msgpack-both+gzip+map | 200    | 642 B | 1.1 KB      | 4.2×         | 15.9 ms | 16.1 ms |

## tools/call: `codec-time-leaf__get_current_time`

| variant               | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-----------------------|--------|-------|-------------|--------------|---------|---------|
| json                  | 200    | 408 B | 4.6 KB      | 1.0×         | 22.4 ms | 22.7 ms |
| msgpack-resp          | 200    | 400 B | 4.2 KB      | 1.1×         | 12.9 ms | 13.1 ms |
| msgpack-both          | 200    | 388 B | 4.2 KB      | 1.1×         | 14.1 ms | 14.3 ms |
| msgpack-both+gzip     | 200    | 411 B | 1.1 KB      | 4.2×         | 15.0 ms | 15.3 ms |
| msgpack-both+gzip+map | 200    | 573 B | 1.1 KB      | 4.2×         | 13.8 ms | 14.0 ms |
