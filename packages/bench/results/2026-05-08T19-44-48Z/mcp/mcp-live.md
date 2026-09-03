# MCP wire bench: 2026-05-08T19-44-48Z

Target: `http://192.168.1.88:12008/metamcp/openwebui-api/mcp`
Vocab map: `https://cdn.jsdelivr.net/gh/wdunn001/codec-maps@main/maps/qwen/qwen2.json` (sha256 `887311099cdc…`)

## initialize

| variant               | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-----------------------|--------|-------|-------------|--------------|--------|--------|
| json                  | 200    | 402 B | 892 B       | 1.0×         | 6.0 ms | 6.1 ms |
| msgpack-resp          | 200    | 394 B | 826 B       | 1.1×         | 5.9 ms | 6.2 ms |
| msgpack-both          | 200    | 371 B | 826 B       | 1.1×         | 6.1 ms | 6.3 ms |
| msgpack-both+gzip     | 200    | 394 B | 856 B       | 1.0×         | 5.8 ms | 6.6 ms |
| msgpack-both+gzip+map | 200    | 554 B | 856 B       | 1.0×         | 2.50 s | 2.50 s |

## tools/list

| variant               | status | req   | resp (wire) | resp vs json | TTFB     | total    |
|-----------------------|--------|-------|-------------|--------------|----------|----------|
| json                  | 200    | 349 B | 20.7 KB     | 1.0×         | 111.8 ms | 113.2 ms |
| msgpack-resp          | 200    | 341 B | 18.5 KB     | 1.1×         | 2.27 s   | 2.27 s   |
| msgpack-both          | 200    | 336 B | 18.5 KB     | 1.1×         | 79.6 ms  | 80.8 ms  |
| msgpack-both+gzip     | 200    | 360 B | 5.7 KB      | 3.6×         | 2.24 s   | 2.24 s   |
| msgpack-both+gzip+map | 200    | 520 B | 5.7 KB      | 3.6×         | 122.4 ms | 122.6 ms |

## tools/call: `Time__get_current_time`

| variant               | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-----------------------|--------|-------|-------------|--------------|---------|---------|
| json                  | 200    | 421 B | 863 B       | 1.0×         | 13.8 ms | 14.1 ms |
| msgpack-resp          | 200    | 413 B | 809 B       | 1.1×         | 9.7 ms  | 9.9 ms  |
| msgpack-both          | 200    | 398 B | 809 B       | 1.1×         | 9.5 ms  | 9.7 ms  |
| msgpack-both+gzip     | 200    | 421 B | 838 B       | 1.0×         | 10.7 ms | 10.9 ms |
| msgpack-both+gzip+map | 200    | 581 B | 989 B       | 1.1× smaller | 14.4 ms | 14.7 ms |
