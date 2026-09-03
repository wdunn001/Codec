# MCP wire bench: 2026-05-09T11-44-34Z

Target: `http://192.168.1.88:12008/metamcp/openwebui-api/mcp`
Vocab map: `https://cdn.jsdelivr.net/gh/wdunn001/codec-maps/maps/qwen/qwen2.json` (sha256 `sha256:9db56…`)

## initialize

| variant               | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-----------------------|--------|-------|-------------|--------------|---------|---------|
| json                  | 200    | 402 B | 892 B       | 1.0×         | 10.7 ms | 10.9 ms |
| msgpack-resp          | 200    | 394 B | 826 B       | 1.1×         | 13.0 ms | 13.4 ms |
| msgpack-both          | 200    | 371 B | 826 B       | 1.1×         | 13.1 ms | 13.5 ms |
| msgpack-both+gzip     | 200    | 394 B | 856 B       | 1.0×         | 10.8 ms | 11.3 ms |
| msgpack-both+gzip+map | 200    | 556 B | 856 B       | 1.0×         | 1.28 s  | 1.28 s  |

## tools/list

| variant               | status | req   | resp (wire) | resp vs json | TTFB     | total    |
|-----------------------|--------|-------|-------------|--------------|----------|----------|
| json                  | 200    | 349 B | 21.4 KB     | 1.0×         | 177.0 ms | 178.2 ms |
| msgpack-resp          | 200    | 341 B | 19.0 KB     | 1.1×         | 2.25 s   | 2.25 s   |
| msgpack-both          | 200    | 336 B | 19.0 KB     | 1.1×         | 2.20 s   | 2.21 s   |
| msgpack-both+gzip     | 200    | 360 B | 5.9 KB      | 3.6×         | 78.7 ms  | 80.3 ms  |
| msgpack-both+gzip+map | 200    | 522 B | 5.9 KB      | 3.6×         | 2.25 s   | 2.25 s   |

## tools/call: `codec-time-leaf__get_current_time`

| variant               | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-----------------------|--------|-------|-------------|--------------|---------|---------|
| json                  | 200    | 408 B | 4.6 KB      | 1.0×         | 15.4 ms | 15.6 ms |
| msgpack-resp          | 200    | 400 B | 4.2 KB      | 1.1×         | 14.4 ms | 14.7 ms |
| msgpack-both          | 200    | 388 B | 4.2 KB      | 1.1×         | 14.3 ms | 14.6 ms |
| msgpack-both+gzip     | 200    | 411 B | 1.1 KB      | 4.2×         | 15.1 ms | 15.3 ms |
| msgpack-both+gzip+map | 200    | 573 B | 1.1 KB      | 4.2×         | 15.9 ms | 16.1 ms |
