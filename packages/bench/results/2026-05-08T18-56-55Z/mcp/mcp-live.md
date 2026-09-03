# MCP wire bench: 2026-05-08T18-56-55Z

Target: `http://192.168.1.88:12008/metamcp/openwebui-api/mcp`
Vocab map: _not configured (msgpack-both+gzip+map will be skipped)_

## initialize

| variant           | status | req   | resp (wire) | resp vs json | TTFB   | total  |
|-------------------|--------|-------|-------------|--------------|--------|--------|
| json              | 200    | 402 B | 892 B       | 1.0×         | 6.1 ms | 6.4 ms |
| msgpack-resp      | 200    | 394 B | 826 B       | 1.1×         | 5.8 ms | 5.9 ms |
| msgpack-both      | 200    | 371 B | 826 B       | 1.1×         | 6.0 ms | 6.1 ms |
| msgpack-both+gzip | 200    | 394 B | 856 B       | 1.0×         | 7.2 ms | 7.9 ms |

## tools/list

| variant           | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-------------------|--------|-------|-------------|--------------|---------|---------|
| json              | 200    | 349 B | 20.7 KB     | 1.0×         | 95.2 ms | 96.5 ms |
| msgpack-resp      | 200    | 341 B | 18.5 KB     | 1.1×         | 2.13 s  | 2.13 s  |
| msgpack-both      | 200    | 336 B | 18.5 KB     | 1.1×         | 56.7 ms | 57.8 ms |
| msgpack-both+gzip | 200    | 359 B | 5.8 KB      | 3.6×         | 2.30 s  | 2.30 s  |

## tools/call: `Time__get_current_time`

| variant           | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-------------------|--------|-------|-------------|--------------|---------|---------|
| json              | 200    | 421 B | 863 B       | 1.0×         | 14.5 ms | 14.6 ms |
| msgpack-resp      | 200    | 413 B | 809 B       | 1.1×         | 12.6 ms | 12.9 ms |
| msgpack-both      | 200    | 398 B | 809 B       | 1.1×         | 11.3 ms | 11.4 ms |
| msgpack-both+gzip | 200    | 421 B | 838 B       | 1.0×         | 11.1 ms | 11.2 ms |

## tools/call: `Time__convert_time`

| variant           | status | req   | resp (wire) | resp vs json | TTFB    | total   |
|-------------------|--------|-------|-------------|--------------|---------|---------|
| json              | 200    | 477 B | 863 B       | 1.0×         | 11.1 ms | 11.2 ms |
| msgpack-resp      | 200    | 469 B | 809 B       | 1.1×         | 14.0 ms | 14.1 ms |
| msgpack-both      | 200    | 446 B | 809 B       | 1.1×         | 11.7 ms | 11.9 ms |
| msgpack-both+gzip | 200    | 469 B | 838 B       | 1.0×         | 12.4 ms | 12.6 ms |
