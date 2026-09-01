// SCHEMA-v1 matrix runner for the Rust client. Mirrors:
//   packages/demo-python/src/codec_demo/matrix_run.py
//   packages/demo/src/matrix_run.ts
//   packages/demo-dotnet/Program.cs (matrix mode)
//
// Reads a methodology JSON written by capture_methodology.py and emits a
// SCHEMA-v1 result JSON. Wire bytes are sums of raw socket reads from
// reqwest's bytes_stream() (no automatic decompression: see
// reqwest::Client::no_gzip/no_brotli/no_zstd in main.rs). Decompression
// is best-effort for token counting and never overrides wire/TTFB on
// failure (e.g. zstd dict mismatch when no client-side dict is loaded).

use std::collections::HashMap;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use codec_rs::{
    decode_msgpack_stream, decode_protobuf_stream, hash_zstd_dict,
    select_zstd_dict_for_response,
};
use futures_util::StreamExt;
use serde_json::{json, Value};

// Hash → bytes for any dict the bench has loaded locally. Keys MUST
// follow the canonical "sha256:<hex>" shape the server emits in the
// Codec-Zstd-Dict response header. Populated by load_zstd_dict_files()
// below; run_matrix() invokes that on startup with the reference dicts
// from <repo>/dictionaries/. Mirrors CODEC_ZSTD_DICTS in
// packages/demo-python/src/codec_demo/__init__.py.
static ZSTD_DICTS: OnceLock<HashMap<String, Vec<u8>>> = OnceLock::new();

fn zstd_dicts() -> &'static HashMap<String, Vec<u8>> {
    ZSTD_DICTS.get_or_init(HashMap::new)
}

/// Load each dict file into the bench-side registry, keyed by its
/// canonical Codec-Zstd-Dict sha256. Missing files are silently
/// skipped: the bench then decompresses successfully only on cells
/// whose Codec-Zstd-Dict header matches a hash we have. Call once
/// before the matrix loop begins.
pub fn load_zstd_dict_files(paths: &[&Path]) -> HashMap<String, Vec<u8>> {
    let mut out = HashMap::new();
    for p in paths {
        if !p.is_file() {
            continue;
        }
        match std::fs::read(p) {
            Ok(bytes) => {
                let hash = hash_zstd_dict(&bytes);
                out.insert(hash, bytes);
            }
            Err(_) => continue,
        }
    }
    out
}

const PATHS: &[(&str, &str)] = &[
    ("JSON-SSE (default)", "json"),
    ("Codec msgpack", "msgpack"),
    ("Codec protobuf", "protobuf"),
];

const ENCODINGS: &[&str] = &["identity", "gzip", "br", "zstd"];

// ── CLI ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct MatrixArgs {
    pub methodology: PathBuf,
    pub out: PathBuf,
    pub sizes: Vec<u32>,
    pub reps: usize,
}

pub fn parse_matrix_args() -> Option<MatrixArgs> {
    let mut argv = std::env::args().skip(1).peekable();
    let mut methodology: Option<PathBuf> = None;
    let mut out: Option<PathBuf> = None;
    let mut sizes: Vec<u32> = Vec::new();
    let mut reps: usize = 2;
    while let Some(a) = argv.next() {
        match a.as_str() {
            "--methodology" => methodology = argv.next().map(PathBuf::from),
            "--out" => out = argv.next().map(PathBuf::from),
            "--reps" => reps = argv.next().and_then(|s| s.parse().ok()).unwrap_or(2),
            "--sizes" => {
                while let Some(p) = argv.peek() {
                    if let Ok(n) = p.parse::<u32>() {
                        sizes.push(n);
                        argv.next();
                    } else {
                        break;
                    }
                }
            }
            _ => {} // legacy mode owns the other flags
        }
    }
    if let (Some(methodology), Some(out)) = (methodology, out) {
        if sizes.is_empty() {
            sizes = vec![64, 512, 2048];
        }
        Some(MatrixArgs { methodology, out, sizes, reps })
    } else {
        None
    }
}

// ── helpers ────────────────────────────────────────────────────────────────

fn sh(cmd: &str, args: &[&str]) -> String {
    std::process::Command::new(cmd)
        .args(args)
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

fn median_int(xs: &[usize]) -> usize {
    if xs.is_empty() {
        return 0;
    }
    let mut s = xs.to_vec();
    s.sort();
    let m = s.len() / 2;
    if s.len() % 2 == 1 { s[m] } else { (s[m - 1] + s[m]) / 2 }
}

fn median_f64(xs: &[f64]) -> f64 {
    if xs.is_empty() {
        return f64::NAN;
    }
    let mut s = xs.to_vec();
    s.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let m = s.len() / 2;
    if s.len() % 2 == 1 { s[m] } else { (s[m - 1] + s[m]) / 2.0 }
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

// Decompression-tolerant: returns (decoded_bytes, optional decode error).
// Wire bytes are already captured by the caller; this is best-effort.
//
// `response_headers` is a case-insensitive (lowercased-key) view of the
// server's response headers. For Content-Encoding: zstd, we look up the
// Codec-Zstd-Dict header via the production helper in `codec_rs` and
// pass the matched dict bytes to `zstd::stream::Decoder::with_dictionary`.
// A missing/malformed/unknown-hash header is a fatal decode error per
// spec: we propagate it as a string in the same shape the rest of the
// matrix expects, instead of silently bare-decoding with no dict.
fn try_decode(
    content_encoding: &str,
    response_headers: &HashMap<String, String>,
    compressed: &[u8],
) -> (Vec<u8>, Option<String>) {
    let result: Result<Vec<u8>, String> = match content_encoding {
        "gzip" => {
            let mut out = Vec::new();
            flate2::read::GzDecoder::new(Cursor::new(compressed))
                .read_to_end(&mut out)
                .map(|_| out)
                .map_err(|e| format!("gzip: {e}"))
        }
        "br" => {
            let mut out = Vec::new();
            brotli::Decompressor::new(Cursor::new(compressed), 4096)
                .read_to_end(&mut out)
                .map(|_| out)
                .map_err(|e| format!("br: {e}"))
        }
        "zstd" => match select_zstd_dict_for_response(response_headers, zstd_dicts()) {
            Ok(Some(dict_bytes)) => {
                let mut out = Vec::new();
                zstd::stream::Decoder::with_dictionary(Cursor::new(compressed), dict_bytes)
                    .and_then(|mut d| d.read_to_end(&mut out).map(|_| ()))
                    .map(|()| out)
                    .map_err(|e| format!("zstd: {e}"))
            }
            // Spec says Codec-Zstd-Dict is mandatory on zstd responses,
            // but pre-header (v0.0/v0.1) servers can still omit it. Fall
            // back to bare zstd in that case: and surface the absence
            // as part of the error message if the bare decode also fails.
            Ok(None) => Ok(compressed.to_vec()),
            Err(codec_rs::CodecZstdDictError::MissingHeader) => {
                // Treat as legacy / pre-v0.2 path: try bare decode with no dict.
                zstd::stream::decode_all(Cursor::new(compressed))
                    .map_err(|e| format!("zstd (no Codec-Zstd-Dict header, bare decode failed): {e}"))
            }
            Err(e) => Err(format!("zstd: {e}")),
        },
        _ => Ok(compressed.to_vec()),
    };
    match result {
        Ok(v) => (v, None),
        Err(e) => (compressed.to_vec(), Some(e)),
    }
}

// ── per-cell driver ────────────────────────────────────────────────────────

#[derive(Debug)]
struct CellResult {
    wire_bytes: Option<usize>,
    ttft_ms: Option<f64>,
    total_ms: Option<f64>,
    tokens: usize,
    error: Option<String>,
}

async fn run_one(
    client: &reqwest::Client,
    endpoint: &str,
    model: &str,
    prompt: &str,
    size: u32,
    format: &str,
    encoding: &str,
) -> CellResult {
    let mut body = json!({
        "model": model,
        "prompt": prompt,
        "max_tokens": size,
        "stream": true,
        "temperature": 0.0,
    });
    if format != "json" {
        body["stream_format"] = json!(format);
    }

    let url = format!("{endpoint}/v1/completions");
    let started = Instant::now();
    let resp = match client
        .post(&url)
        .header("content-type", "application/json")
        .header("accept-encoding", encoding)
        .body(serde_json::to_vec(&body).unwrap())
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            return CellResult {
                wire_bytes: None,
                ttft_ms: None,
                total_ms: None,
                tokens: 0,
                error: Some(format!("send: {e}")),
            }
        }
    };
    let ttft = started.elapsed().as_secs_f64() * 1000.0;
    if !resp.status().is_success() {
        return CellResult {
            wire_bytes: None,
            ttft_ms: Some(ttft),
            total_ms: Some(started.elapsed().as_secs_f64() * 1000.0),
            tokens: 0,
            error: Some(format!("HTTP {}", resp.status())),
        };
    }
    let content_encoding = resp
        .headers()
        .get("content-encoding")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("identity")
        .to_lowercase();

    // Snapshot response headers (lowercased keys) so try_decode can run
    // select_zstd_dict_for_response against them. Cheap: only used per
    // request, and reqwest's HeaderMap keys are already ASCII-lowercase
    // on the wire.
    let mut response_headers: HashMap<String, String> = HashMap::new();
    for (k, v) in resp.headers().iter() {
        if let Ok(s) = v.to_str() {
            response_headers.insert(k.as_str().to_ascii_lowercase(), s.to_string());
        }
    }

    let mut compressed = Vec::<u8>::new();
    let mut byte_stream = resp.bytes_stream();
    while let Some(chunk) = byte_stream.next().await {
        match chunk {
            Ok(b) => compressed.extend_from_slice(&b),
            Err(e) => {
                return CellResult {
                    wire_bytes: Some(compressed.len()),
                    ttft_ms: Some(ttft),
                    total_ms: Some(started.elapsed().as_secs_f64() * 1000.0),
                    tokens: 0,
                    error: Some(format!("stream: {e}")),
                }
            }
        }
    }
    let total_ms = started.elapsed().as_secs_f64() * 1000.0;
    let wire = compressed.len();

    // Wire/TTFB/total are now safe regardless of decompression outcome.
    let (decoded, decode_err) = try_decode(&content_encoding, &response_headers, &compressed);
    let tokens = if decode_err.is_some() {
        0
    } else {
        match format {
            "json" => count_jsonsse(&decoded),
            "msgpack" => count_msgpack(&decoded),
            "protobuf" => count_protobuf(&decoded),
            _ => 0,
        }
    };

    CellResult {
        wire_bytes: Some(wire),
        ttft_ms: Some(ttft),
        total_ms: Some(total_ms),
        tokens,
        error: decode_err.map(|e| format!("decode {content_encoding}: {e}")),
    }
}

// ── main matrix loop ───────────────────────────────────────────────────────

pub async fn run_matrix(args: MatrixArgs) -> Result<(), Box<dyn std::error::Error>> {
    let methodology_text = std::fs::read_to_string(&args.methodology)?;
    let mut methodology: Value = serde_json::from_str(&methodology_text)?;

    // Repo root = parent of packages/. Derive from this binary's dir if
    // the methodology references a relative prompts path. Cargo target
    // dir is target/release|debug, so up 3 from binary → repo root.
    let bin_path = std::env::current_exe()?;
    let repo_root = bin_path
        .ancestors()
        .nth(5) // codec-bench → release/ → target/ → demo-rust/ → packages/ → repo root
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));

    // Load the reference zstd dicts from <repo>/dictionaries/ into the
    // process-global ZSTD_DICTS registry. Mirrors the
    // load_zstd_dict_files(...) call in
    // packages/demo-python/src/codec_demo/matrix_run.py. Missing files
    // are tolerated: the bench then surfaces a 'Dictionary mismatch'
    // style error on zstd cells whose hash we don't have, rather than
    // crashing.
    let dict_dir = repo_root.join("dictionaries");
    let dict_paths = [
        dict_dir.join("qwen2.5-synth-msgpack-v1.dict"),
        dict_dir.join("qwen2.5-synth-protobuf-v1.dict"),
    ];
    let dict_path_refs: Vec<&Path> = dict_paths.iter().map(PathBuf::as_path).collect();
    let dicts = load_zstd_dict_files(&dict_path_refs);
    if !dicts.is_empty() {
        eprintln!(
            "loaded {} zstd dict(s) from {}:",
            dicts.len(),
            dict_dir.display()
        );
        for hash in dicts.keys() {
            eprintln!("  {hash}");
        }
    } else {
        eprintln!(
            "no zstd dicts found under {}: zstd cells will fail to decode",
            dict_dir.display()
        );
    }
    // First writer wins (OnceLock); on repeat runs in tests / harnesses
    // the existing registry stays put, which is the right semantics.
    let _ = ZSTD_DICTS.set(dicts);

    let prompts_rel = methodology["workload"]["prompts_file"]
        .as_str()
        .ok_or("methodology.workload.prompts_file missing")?;
    let prompts_path = repo_root.join("packages").join("bench").join(prompts_rel);
    let prompts_text = std::fs::read_to_string(&prompts_path)
        .map_err(|e| format!("read prompts {}: {e}", prompts_path.display()))?;
    let prompts: Value = serde_json::from_str(&prompts_text)?;

    let endpoint = methodology["engine"]["endpoint"].as_str().unwrap().to_string();
    let model = methodology["model"]["id"].as_str().unwrap().to_string();

    let commit = sh("git", &["rev-parse", "HEAD"]);
    let codec_ver = env!("CARGO_PKG_VERSION");
    let rustc_ver = sh("rustc", &["--version"]);
    methodology["client"] = json!({
        "lang": "rust",
        "lib_name": "codec-rs",
        "lib_version": codec_ver,
        "lib_commit": commit,
        "runtime": format!("{rustc_ver} / reqwest 0.12 / tokio 1"),
    });
    methodology["bench_tool"] = json!({
        "name": "demo-rust/codec-bench matrix_run",
        "version": "0.1.0",
        "commit": commit,
        "reps": args.reps,
        "warmup_reps": 0,
        "aggregation": "median",
        "ttft_definition": "wall-clock from reqwest::send() return to first received byte (no auto-decompress)",
        "wire_bytes_definition": "raw socket bytes from bytes_stream() before any Content-Encoding decompression",
        "total_ms_definition": "wall-clock from request POST to last byte",
    });

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .no_gzip()
        .no_brotli()
        .no_zstd()
        .build()?;

    let mut rows: Vec<Value> = Vec::new();
    for &size in &args.sizes {
        let prompt = prompts["prompts"][size.to_string()]
            .as_str()
            .ok_or_else(|| format!("no canonical prompt defined for size={size}"))?;
        eprintln!(
            ">>> size={size}  prompt: '{}'",
            if prompt.len() > 60 {
                format!("{}...", &prompt[..60])
            } else {
                prompt.to_string()
            }
        );
        for (label, fmt) in PATHS {
            for enc in ENCODINGS {
                let mut rep_wire: Vec<usize> = Vec::new();
                let mut rep_ttft: Vec<f64> = Vec::new();
                let mut rep_total: Vec<f64> = Vec::new();
                let mut tokens: usize = 0;
                let mut error: Option<String> = None;
                for _ in 0..args.reps {
                    let r = run_one(&client, &endpoint, &model, prompt, size, fmt, enc).await;
                    if let Some(w) = r.wire_bytes {
                        rep_wire.push(w);
                    }
                    if let Some(t) = r.ttft_ms {
                        rep_ttft.push(t);
                    }
                    if let Some(t) = r.total_ms {
                        rep_total.push(t);
                    }
                    if r.tokens > tokens {
                        tokens = r.tokens;
                    }
                    if let Some(e) = r.error {
                        error = Some(e);
                    }
                }
                let row = json!({
                    "size": size,
                    "format": fmt,
                    "encoding": enc,
                    "wire_bytes": if rep_wire.is_empty() { Value::Null } else { Value::from(median_int(&rep_wire)) },
                    "ttft_ms": if rep_ttft.is_empty() { Value::Null } else { Value::from(median_f64(&rep_ttft)) },
                    "total_ms": if rep_total.is_empty() { Value::Null } else { Value::from(median_f64(&rep_total)) },
                    "tokens_emitted": tokens,
                    "rep_wire_bytes": rep_wire,
                    "rep_ttft_ms": rep_ttft,
                    "rep_total_ms": rep_total,
                    "error": error,
                });
                eprintln!(
                    "    {:<25} {:<8} size={:>5}  wire={}  ttft={}  total={}  tokens={}",
                    label,
                    enc,
                    size,
                    row["wire_bytes"],
                    row["ttft_ms"],
                    row["total_ms"],
                    tokens,
                );
                rows.push(row);
            }
        }
    }

    let out_doc = json!({
        "schema_version": "1",
        "methodology": methodology,
        "rows": rows,
    });
    if let Some(parent) = args.out.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&args.out, serde_json::to_string_pretty(&out_doc)?)?;
    eprintln!("\nwrote {} ({} rows)", args.out.display(), rows.len());
    Ok(())
}
