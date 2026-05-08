# MCP wire bench — 2026-05-08T20-01-27Z

Target: `http://192.168.1.88:12008/metamcp/openwebui-api/mcp`
Vocab map: `https://cdn.jsdelivr.net/gh/wdunn001/codec-maps@main/maps/qwen/qwen2.json` (sha256 `887311099cdc…`)

## initialize

| variant               | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-----------------------|--------|-------|-------------|--------------|---------|---------|
| json                  | 200    | 402 B | 892 B       | 1.0×         | 7.8 ms  | 8.0 ms  |
| msgpack-resp          | 200    | 394 B | 826 B       | 1.1×         | 10.6 ms | 10.8 ms |
| msgpack-both          | 200    | 371 B | 826 B       | 1.1×         | 11.0 ms | 11.2 ms |
| msgpack-both+gzip     | 200    | 394 B | 856 B       | 1.0×         | 12.4 ms | 12.8 ms |
| msgpack-both+gzip+map | 200    | 554 B | 856 B       | 1.0×         | 2.41 s  | 2.41 s  |

## tools/list

| variant               | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-----------------------|--------|-------|-------------|--------------|---------|---------|
| json                  | 200    | 349 B | 20.7 KB     | 1.0×         | 27.30 s | 27.31 s |
| msgpack-resp          | 200    | 341 B | 18.5 KB     | 1.1×         | 73.2 ms | 74.3 ms |
| msgpack-both          | 200    | 336 B | 18.5 KB     | 1.1×         | 2.24 s  | 2.24 s  |
| msgpack-both+gzip     | 200    | 360 B | 5.7 KB      | 3.6×         | 73.6 ms | 74.2 ms |
| msgpack-both+gzip+map | 200    | 520 B | 5.8 KB      | 3.6×         | 2.24 s  | 2.24 s  |

## tools/call — `Time__get_current_time`

| variant               | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-----------------------|--------|-------|-------------|--------------|---------|---------|
| json                  | 200    | 421 B | 863 B       | 1.0×         | 14.0 ms | 14.2 ms |
| msgpack-resp          | 200    | 413 B | 809 B       | 1.1×         | 15.7 ms | 15.8 ms |
| msgpack-both          | 200    | 398 B | 809 B       | 1.1×         | 12.7 ms | 12.8 ms |
| msgpack-both+gzip     | 200    | 421 B | 838 B       | 1.0×         | 14.6 ms | 14.8 ms |
| msgpack-both+gzip+map | 200    | 581 B | 989 B       | 1.1× smaller | 16.5 ms | 16.6 ms |
