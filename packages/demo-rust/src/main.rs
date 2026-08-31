// SPDX-License-Identifier: MIT
//
// codec-bench (Rust): same shape as packages/demo-web (TypeScript),
// packages/demo-python, packages/demo-dotnet, packages/demo-c. Runs the
// same prompt across 3 wire formats × 4 compression encodings, prints
// the wire-byte table.
//
// Usage:
//     cargo run --release --manifest-path packages/demo-rust/Cargo.toml -- \
//         --url http://192.168.1.88:30000 \
//         --model Qwen/Qwen2.5-0.5B-Instruct \
//         --prompt "Explain entropy in one sentence:" \
//         --max-tokens 64

use std::io::{Cursor, Read, Write};
use std::time::{Duration, Instant};

use codec_rs::{decode_msgpack_stream, decode_protobuf_stream};
use futures_util::StreamExt;
use serde_json::json;

mod matrix_run;

const PATHS: &[(&str, &str)] = &[
    ("JSON-SSE (default)", "json"),
    ("Codec msgpack", "msgpack"),
    ("Codec protobuf", "protobuf"),
];

const ENCODINGS: &[&str] = &["identity", "gzip", "br", "zstd"];

#[derive(Debug)]
struct Cell {
    path_label: String,
    format: String,
    encoding: String,
    status: String,
    wire_bytes: Option<usize>,
    decoded_bytes: Option<usize>,
    tokens: usize,
    ttfb_ms: Option<f64>,
    total_ms: Option<f64>,
    error: Option<String>,
}

#[derive(Debug, Clone)]
struct Args {
    url: String,
    model: String,
    prompt: String,
    max_tokens: u32,
}

impl Default for Args {
    fn default() -> Self {
        Self {
            url: "http://192.168.1.88:30000".into(),
            model: "Qwen/Qwen2.5-0.5B-Instruct".into(),
            prompt: "Explain entropy in one sentence:".into(),
            max_tokens: 64,
        }
    }
}

fn parse_args() -> Args {
    let mut a = Args::default();
    let mut argv = std::env::args().skip(1).peekable();
    while let Some(arg) = argv.next() {
        match arg.as_str() {
            "--url" => a.url = argv.next().unwrap_or_default(),
            "--model" => a.model = argv.next().unwrap_or_default(),
            "--prompt" => a.prompt = argv.next().unwrap_or_default(),
            "--max-tokens" => {
                a.max_tokens = argv.next().and_then(|s| s.parse().ok()).unwrap_or(64)
            }
            _ => {}
        }
    }
    a
}

fn fmt_bytes(n: Option<usize>) -> String {
    match n {
        None => "-".into(),
        Some(n) if n < 1024 => format!("{n} B"),
        Some(n) if n < 1_048_576 => format!("{:.1} KB", n as f64 / 1024.0),
        Some(n) => format!("{:.2} MB", n as f64 / 1_048_576.0),
    }
}

fn fmt_ms(n: Option<f64>) -> String {
    match n {
        None => "-".into(),
        Some(n) => format!("{n:.0} ms"),
    }
}

async fn fetch_stream(
    client: &reqwest::Client,
    url: &str,
    body: &serde_json::Value,
    accept_encoding: &str,
) -> Result<(Vec<u8>, usize, f64), Box<dyn std::error::Error>> {
    let req_url = format!("{url}/v1/completions");
    let mut req = client
        .post(&req_url)
        .header("content-type", "application/json")
        .header("accept-encoding", accept_encoding)
        .body(serde_json::to_vec(body)?);

    let _ = &mut req;
    let started = Instant::now();
    let resp = client
        .post(&req_url)
        .header("content-type", "application/json")
        .header("accept-encoding", accept_encoding)
        .body(serde_json::to_vec(body)?)
        .send()
        .await?;
    let ttfb = started.elapsed().as_secs_f64() * 1000.0;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()).into());
    }

    let content_encoding = resp
        .headers()
        .get("content-encoding")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("identity")
        .to_lowercase();

    // Stream the raw body into a buffer to count wire bytes pre-decompression.
    let mut compressed = Vec::<u8>::new();
    let mut byte_stream = resp.bytes_stream();
    while let Some(chunk) = byte_stream.next().await {
        let chunk = chunk?;
        compressed.extend_from_slice(&chunk);
    }
    let wire = compressed.len();

    let decompressed = match content_encoding.as_str() {
        "gzip" => {
            let mut out = Vec::new();
            flate2::read::GzDecoder::new(Cursor::new(&compressed)).read_to_end(&mut out)?;
            out
        }
        "br" => {
            let mut out = Vec::new();
            brotli::Decompressor::new(Cursor::new(&compressed), 4096).read_to_end(&mut out)?;
            out
        }
        "zstd" => zstd::decode_all(Cursor::new(&compressed))?,
        _ => compressed.clone(),
    };

    Ok((decompressed, wire, ttfb))
}

fn count_jsonsse(data: &[u8]) -> usize {
    let s = std::str::from_utf8(data).unwrap_or("");
    let mut n = 0;
    for line in s.split('\n') {
        if let Some(rest) = line.strip_prefix("data: ") {
            if !rest.contains("[DONE]") {
                n += 1;
            }
        }
    }
    n
}

fn count_msgpack(data: &[u8]) -> usize {
    let mut n = 0;
    for frame in decode_msgpack_stream(Cursor::new(data)) {
        match frame {
            Ok(f) => n += f.ids.len(),
            Err(_) => break,
        }
    }
    n
}

fn count_protobuf(data: &[u8]) -> usize {
    let mut n = 0;
    for frame in decode_protobuf_stream(Cursor::new(data)) {
        match frame {
            Ok(f) => n += f.ids.len(),
            Err(_) => break,
        }
    }
    n
}

async fn run_one(client: &reqwest::Client, args: &Args, cell: &mut Cell) {
    cell.status = "running".into();
    let mut body = json!({
        "model": args.model,
        "prompt": args.prompt,
        "max_tokens": args.max_tokens,
        "stream": true,
        "temperature": 0.0,
    });
    if cell.format != "json" {
        body["stream_format"] = json!(cell.format);
    }

    let started = Instant::now();
    match fetch_stream(client, &args.url, &body, &cell.encoding).await {
        Ok((decoded, wire, ttfb)) => {
            cell.wire_bytes = Some(wire);
            cell.decoded_bytes = Some(decoded.len());
            cell.ttfb_ms = Some(ttfb);
            cell.total_ms = Some(started.elapsed().as_secs_f64() * 1000.0);
            cell.tokens = match cell.format.as_str() {
                "json" => count_jsonsse(&decoded),
                "msgpack" => count_msgpack(&decoded),
                "protobuf" => count_protobuf(&decoded),
                _ => 0,
            };
            cell.status = "done".into();
        }
        Err(e) => {
            cell.error = Some(format!("{e}"));
            cell.status = "error".into();
        }
    }
}

fn render(grid: &[Vec<Cell>]) {
    let baseline = if grid[0][0].status == "done" {
        grid[0][0].wire_bytes
    } else {
        None
    };

    let mut sb = String::new();
    sb.push('\n');
    sb.push_str(&format!("{:<25}", "path"));
    for e in ENCODINGS {
        sb.push_str(&format!("  {e:>16}"));
    }
    sb.push('\n');
    sb.push_str(&"-".repeat(25 + (16 + 2) * ENCODINGS.len()));
    sb.push('\n');

    for row in grid {
        sb.push_str(&format!("{:<25}", row[0].path_label));
        for c in row {
            sb.push_str("  ");
            match c.status.as_str() {
                "pending" => sb.push_str(&format!("{:>16}", "-")),
                "running" => sb.push_str(&format!("{:>16}", "running")),
                "error" => {
                    let msg = c.error.as_deref().unwrap_or("error");
                    let truncated = if msg.len() > 16 { &msg[..16] } else { msg };
                    sb.push_str(&format!("{truncated:>16}"));
                }
                _ => sb.push_str(&format!("{:>16}", fmt_bytes(c.wire_bytes))),
            }
        }
        sb.push('\n');
    }

    sb.push_str("\nper cell: wire_bytes / tokens / B-per-tok / ttfb / total / ratio-vs-json\n\n");

    for row in grid {
        for c in row {
            if c.status != "done" || c.wire_bytes.is_none() {
                continue;
            }
            let wire = c.wire_bytes.unwrap();
            let ratio = match baseline {
                Some(b) if wire > 0 => b as f64 / wire as f64,
                _ => 0.0,
            };
            let bpt = if c.tokens > 0 {
                wire as f64 / c.tokens as f64
            } else {
                0.0
            };
            sb.push_str(&format!(
                "  {:<25} {:<8} {:>10}  {:>4} tok  {:>6.1} B/tok  {:>7} TTFB  {:>7} total  {:>5.1}x\n",
                c.path_label,
                c.encoding,
                fmt_bytes(c.wire_bytes),
                c.tokens,
                bpt,
                fmt_ms(c.ttfb_ms),
                fmt_ms(c.total_ms),
                ratio,
            ));
        }
    }

    let _ = std::io::stdout().write_all(sb.as_bytes());
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Dispatch: if --methodology is given, run the SCHEMA-v1 matrix mode.
    // Otherwise fall through to the legacy ad-hoc grid bench (kept for
    // quick interactive use; not part of the cross-stack matrix harness).
    if let Some(matrix_args) = matrix_run::parse_matrix_args() {
        return matrix_run::run_matrix(matrix_args).await;
    }

    let args = parse_args();
    eprintln!("target: {}", args.url);
    eprintln!("model:  {}", args.model);
    eprintln!(
        "prompt: {}  (max_tokens={})",
        args.prompt, args.max_tokens
    );

    // No automatic decompression: we count wire bytes pre-decompression.
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .no_gzip()
        .no_brotli()
        .no_zstd()
        .build()?;

    let mut grid: Vec<Vec<Cell>> = Vec::new();
    for (label, fmt) in PATHS {
        let mut row = Vec::new();
        for enc in ENCODINGS {
            row.push(Cell {
                path_label: (*label).into(),
                format: (*fmt).into(),
                encoding: (*enc).into(),
                status: "pending".into(),
                wire_bytes: None,
                decoded_bytes: None,
                tokens: 0,
                ttfb_ms: None,
                total_ms: None,
                error: None,
            });
        }
        grid.push(row);
    }

    for row in &mut grid {
        for cell in row.iter_mut() {
            eprintln!(">>>  {} / {}", cell.path_label, cell.encoding);
            run_one(&client, &args, cell).await;
            if cell.status == "done" {
                eprintln!(
                    "     wire={} tokens={} total={}",
                    fmt_bytes(cell.wire_bytes),
                    cell.tokens,
                    fmt_ms(cell.total_ms)
                );
            } else {
                eprintln!(
                    "     {}: {}",
                    cell.status,
                    cell.error.as_deref().unwrap_or("")
                );
            }
        }
    }

    render(&grid);
    Ok(())
}
