# @codec/demo-web

Browser bench app for the Codec wire format. Pure-client React + Vite + `@codecai/web`.

## What it does

Sends the **same prompt** to your sglang server in **3 wire formats × 4 compression encodings** and shows the live wire-byte grid. Browser does the binary decode using `@codecai/web`. Wire-byte numbers come from `Performance.encodedBodySize` — the actual bytes that crossed the network, not estimates.

| | identity | gzip | br | zstd |
|---|---|---|---|---|
| JSON-SSE (default) | baseline | … | … | … |
| Codec msgpack | … | … | … | … |
| Codec protobuf | … | … | … | … |

Each cell: wire bytes, tokens, B/token, TTFB, total ms, ratio vs baseline. Greenest cell per row is the smallest wire. zstd/br/gzip handled by the browser transparently.

## Run

```bash
cd packages/demo-web
npm install
npm run dev
```

Opens on `http://localhost:5173`. Point the **server** field at your sglang instance — defaults to `http://192.168.1.88:30000` (the lab box). The sglang server needs to allow CORS from the demo's origin (or run sglang with `--api-key` and host the demo on the same origin).

## Deploy

Static build:

```bash
npm run build
# dist/ is the deployable artifact
```

Drop `dist/` on Cloudflare Pages, Vercel, Netlify, or any static host. The sglang server stays wherever it is; the demo is pure client-side.

## CORS note

If sglang refuses cross-origin requests, run it with permissive CORS or proxy through a small static server (any reverse proxy will do). For lab use, a one-line `--allow-origin '*'` flag if sglang exposes one, or hit a same-origin proxy.
