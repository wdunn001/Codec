# MCP wire bench — 2026-05-08T18-56-16Z

Target: `http://192.168.1.88:12008/metamcp/openwebui-api/mcp`
Vocab map: _not configured (msgpack-both+gzip+map will be skipped)_

## initialize

| variant           | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-------------------|--------|-------|-------------|--------------|---------|---------|
| json              | 200    | 402 B | 892 B       | 1.0×         | 7.8 ms  | 7.9 ms  |
| msgpack-resp      | 200    | 394 B | 826 B       | 1.1×         | 10.0 ms | 10.1 ms |
| msgpack-both      | 200    | 371 B | 826 B       | 1.1×         | 9.3 ms  | 9.5 ms  |
| msgpack-both+gzip | 200    | 394 B | 856 B       | 1.0×         | 10.0 ms | 10.3 ms |

## tools/list

| variant           | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-------------------|--------|-------|-------------|--------------|---------|---------|
| json              | 200    | 349 B | 20.7 KB     | 1.0×         | 8.86 s  | 8.86 s  |
| msgpack-resp      | 200    | 341 B | 18.5 KB     | 1.1×         | 64.9 ms | 66.1 ms |
| msgpack-both      | 200    | 336 B | 18.5 KB     | 1.1×         | 2.29 s  | 2.29 s  |
| msgpack-both+gzip | 200    | 359 B | 5.7 KB      | 3.6×         | 63.2 ms | 65.6 ms |

## tools/call — `Time__get_current_time`

| variant           | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-------------------|--------|-------|-------------|--------------|---------|---------|
| json              | 200    | 421 B | 863 B       | 1.0×         | 13.9 ms | 14.1 ms |
| msgpack-resp      | 200    | 413 B | 809 B       | 1.1×         | 10.3 ms | 10.4 ms |
| msgpack-both      | 200    | 398 B | 809 B       | 1.1×         | 12.8 ms | 13.0 ms |
| msgpack-both+gzip | 200    | 421 B | 838 B       | 1.0×         | 14.2 ms | 14.4 ms |

## tools/call — `Time__convert_time`

| variant           | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-------------------|--------|-------|-------------|--------------|---------|---------|
| json              | 200    | 477 B | 863 B       | 1.0×         | 9.8 ms  | 9.9 ms  |
| msgpack-resp      | 200    | 469 B | 809 B       | 1.1×         | 13.1 ms | 13.2 ms |
| msgpack-both      | 200    | 446 B | 809 B       | 1.1×         | 12.0 ms | 12.1 ms |
| msgpack-both+gzip | 200    | 469 B | 838 B       | 1.0×         | 12.8 ms | 13.5 ms |
