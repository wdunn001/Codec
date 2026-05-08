# MCP wire bench — 2026-05-08T19-43-48Z

Target: `http://192.168.1.88:12008/metamcp/openwebui-api/mcp`
Vocab map: _not configured (msgpack-both+gzip+map will be skipped)_

## initialize

| variant           | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-------------------|--------|-------|-------------|--------------|---------|---------|
| json              | 200    | 402 B | 892 B       | 1.0×         | 8.8 ms  | 8.9 ms  |
| msgpack-resp      | 200    | 394 B | 826 B       | 1.1×         | 10.2 ms | 10.4 ms |
| msgpack-both      | 200    | 371 B | 826 B       | 1.1×         | 10.3 ms | 10.4 ms |
| msgpack-both+gzip | 200    | 394 B | 856 B       | 1.0×         | 7.8 ms  | 8.0 ms  |

## tools/list

| variant           | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-------------------|--------|-------|-------------|--------------|---------|---------|
| json              | 200    | 349 B | 20.7 KB     | 1.0×         | 13.53 s | 13.53 s |
| msgpack-resp      | 200    | 341 B | 18.5 KB     | 1.1×         | 58.5 ms | 59.5 ms |
| msgpack-both      | 200    | 336 B | 18.5 KB     | 1.1×         | 2.32 s  | 2.33 s  |
| msgpack-both+gzip | 200    | 359 B | 5.7 KB      | 3.6×         | 60.3 ms | 60.7 ms |

## tools/call — `Time__get_current_time`

| variant           | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-------------------|--------|-------|-------------|--------------|---------|---------|
| json              | 200    | 421 B | 863 B       | 1.0×         | 11.4 ms | 11.5 ms |
| msgpack-resp      | 200    | 413 B | 809 B       | 1.1×         | 10.2 ms | 10.3 ms |
| msgpack-both      | 200    | 398 B | 809 B       | 1.1×         | 10.8 ms | 10.9 ms |
| msgpack-both+gzip | 200    | 421 B | 838 B       | 1.0×         | 12.2 ms | 12.4 ms |

## tools/call — `Time__convert_time`

| variant           | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-------------------|--------|-------|-------------|--------------|---------|---------|
| json              | 200    | 477 B | 863 B       | 1.0×         | 10.5 ms | 10.7 ms |
| msgpack-resp      | 200    | 469 B | 809 B       | 1.1×         | 15.4 ms | 15.5 ms |
| msgpack-both      | 200    | 446 B | 809 B       | 1.1×         | 11.3 ms | 11.4 ms |
| msgpack-both+gzip | 200    | 469 B | 838 B       | 1.0×         | 10.5 ms | 10.7 ms |
