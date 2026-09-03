# MCP wire bench: 2026-05-09T10-07-07Z

Target: `http://192.168.1.88:12008/metamcp/openwebui-api/mcp`
Vocab map: `https://cdn.jsdelivr.net/gh/wdunn001/codec-maps/maps/qwen/qwen2.json` (sha256 `sha256:9db56…`)

## initialize

| variant               | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-----------------------|--------|-------|-------------|--------------|---------|---------|
| json                  | 200    | 402 B | 892 B       | 1.0×         | 9.1 ms  | 9.3 ms  |
| msgpack-resp          | 200    | 394 B | 826 B       | 1.1×         | 10.1 ms | 10.2 ms |
| msgpack-both          | 200    | 371 B | 826 B       | 1.1×         | 11.0 ms | 11.3 ms |
| msgpack-both+gzip     | 200    | 394 B | 856 B       | 1.0×         | 8.1 ms  | 8.3 ms  |
| msgpack-both+gzip+map | 200    | 556 B | 856 B       | 1.0×         | 1.19 s  | 1.19 s  |

## tools/list

| variant               | status                    | req   | resp (wire) | resp vs json | TTFB     | total    |
|-----------------------|---------------------------|-------|-------------|--------------|----------|----------|
| json                  | 200                       | 349 B | 21.4 KB     | 1.0×         | 171.7 ms | 172.8 ms |
| msgpack-resp          | 200                       | 341 B | 18.5 KB     | 1.2×         | 2.32 s   | 2.32 s   |
| msgpack-both          | 500 Internal Server Error | 336 B | 171 B       | n/a            | 29.99 s  | 29.99 s  |
| msgpack-both+gzip     | 500 Internal Server Error | 360 B | 171 B       | n/a            | 30.05 s  | 30.05 s  |
| msgpack-both+gzip+map | 200                       | 522 B | 5.7 KB      | 3.7×         | 158.5 ms | 158.8 ms |

## tools/call: `Time__get_current_time`

| variant               | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-----------------------|--------|-------|-------------|--------------|---------|---------|
| json                  | 200    | 421 B | 863 B       | 1.0×         | 13.6 ms | 13.8 ms |
| msgpack-resp          | 200    | 413 B | 809 B       | 1.1×         | 11.6 ms | 11.8 ms |
| msgpack-both          | 200    | 398 B | 809 B       | 1.1×         | 12.1 ms | 12.3 ms |
| msgpack-both+gzip     | 200    | 421 B | 838 B       | 1.0×         | 11.3 ms | 11.5 ms |
| msgpack-both+gzip+map | 200    | 583 B | 997 B       | 1.2× smaller | 15.9 ms | 16.0 ms |

## tools/call: `Time__convert_time`

| variant               | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-----------------------|--------|-------|-------------|--------------|---------|---------|
| json                  | 200    | 477 B | 863 B       | 1.0×         | 11.7 ms | 11.9 ms |
| msgpack-resp          | 200    | 469 B | 809 B       | 1.1×         | 12.9 ms | 13.1 ms |
| msgpack-both          | 200    | 446 B | 809 B       | 1.1×         | 15.4 ms | 15.5 ms |
| msgpack-both+gzip     | 200    | 469 B | 837 B       | 1.0×         | 14.4 ms | 14.5 ms |
| msgpack-both+gzip+map | 200    | 631 B | 996 B       | 1.2× smaller | 14.3 ms | 14.4 ms |
