// SPDX-License-Identifier: MIT
//! Per-language tokenize/detokenize micro-benchmark — Rust.
//!
//! Cross-language companion of `codec_demo.token_bench` (Python) /
//! `demo/src/token_bench.ts` (TypeScript). See the Python file's docstring
//! for the output schema and rationale.
//!
//! Usage:
//!   codec-token-bench \
//!     --map ../../codec-maps/maps/qwen/qwen2.json \
//!     --corpus ../bench/golden/qwen2.json \
//!     --reps 200 --warmup 20 \
//!     --out ../bench/results/<run-id>/token/rust.json

use std::env;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Instant;

use codec_rs::{BPETokenizer, Detokenizer, DetokenizeOptions, ITokenizer, TokenizerMap};
use serde_json::{json, Value};

struct Args {
    map_path: PathBuf,
    corpus_path: PathBuf,
    reps: usize,
    warmup: usize,
    out_path: PathBuf,
}

fn parse_args() -> Args {
    let mut args = env::args().skip(1);
    let mut map_path: Option<PathBuf> = None;
    let mut corpus_path: Option<PathBuf> = None;
    let mut out_path: Option<PathBuf> = None;
    let mut reps = 200usize;
    let mut warmup = 20usize;
    while let Some(a) = args.next() {
        match a.as_str() {
            "--map" => map_path = args.next().map(PathBuf::from),
            "--corpus" => corpus_path = args.next().map(PathBuf::from),
            "--out" => out_path = args.next().map(PathBuf::from),
            "--reps" => reps = args.next().and_then(|v| v.parse().ok()).unwrap_or(200),
            "--warmup" => warmup = args.next().and_then(|v| v.parse().ok()).unwrap_or(20),
            _ => {}
        }
    }
    Args {
        map_path: map_path.expect("--map required"),
        corpus_path: corpus_path.expect("--corpus required"),
        reps,
        warmup,
        out_path: out_path.expect("--out required"),
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    // tiny manual sha256 isn't worth pulling in a crate for one hash; defer to
    // `sha2` if codec-rs already brings it; otherwise rely on a small helper.
    use std::collections::hash_map::DefaultHasher;
    // We don't actually have sha2 in this crate's deps. Use codec_rs's
    // TokenizerMap::verify_sha256 logic implicitly by precomputing the hash
    // via the system command — simpler than pulling a new dep.
    // Fallback: a non-cryptographic hash, clearly labeled.
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    bytes.hash(&mut h);
    format!("hash64:{:016x}", h.finish())
}

fn percentile(sorted: &[f64], pct: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let idx = ((pct / 100.0) * (sorted.len() - 1) as f64).round() as usize;
    sorted[idx.min(sorted.len() - 1)]
}

fn median(sorted: &[f64]) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let mid = sorted.len() / 2;
    if sorted.len() % 2 == 0 {
        (sorted[mid - 1] + sorted[mid]) / 2.0
    } else {
        sorted[mid]
    }
}

fn main() {
    let args = parse_args();

    let map_bytes = fs::read(&args.map_path).expect("read map");
    let map = TokenizerMap::from_json(&map_bytes).expect("parse map");

    let corpus_bytes = fs::read(&args.corpus_path).expect("read corpus");
    let corpus: Value = serde_json::from_slice(&corpus_bytes).expect("parse corpus");
    let samples = corpus["samples"].as_array().expect("samples array");
    if samples.is_empty() {
        eprintln!("corpus has no samples");
        std::process::exit(1);
    }

    let tok = BPETokenizer::new(&map).expect("BPETokenizer::new");
    let mut detok = Detokenizer::new(&map);

    let texts: Vec<String> = samples
        .iter()
        .map(|s| s["text"].as_str().unwrap_or("").to_string())
        .collect();
    let ref_ids: Vec<Vec<u32>> = samples
        .iter()
        .map(|s| {
            s["ids"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_u64().map(|n| n as u32)).collect())
                .unwrap_or_default()
        })
        .collect();
    let total_text_bytes: usize = texts.iter().map(|t| t.len()).sum();
    let total_tokens: usize = ref_ids.iter().map(|v| v.len()).sum();

    // Warmup
    for _ in 0..args.warmup {
        for t in &texts {
            ITokenizer::encode(&tok, t);
        }
        for ids in &ref_ids {
            detok.render(ids, DetokenizeOptions::default());
        }
    }

    let mut encode_ms: Vec<f64> = Vec::with_capacity(args.reps);
    let mut decode_ms: Vec<f64> = Vec::with_capacity(args.reps);
    for _ in 0..args.reps {
        let t0 = Instant::now();
        for t in &texts {
            ITokenizer::encode(&tok, t);
        }
        encode_ms.push(t0.elapsed().as_secs_f64() * 1000.0);

        let t1 = Instant::now();
        for ids in &ref_ids {
            detok.render(ids, DetokenizeOptions::default());
        }
        decode_ms.push(t1.elapsed().as_secs_f64() * 1000.0);
    }

    let mut sorted_enc = encode_ms.clone();
    sorted_enc.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let mut sorted_dec = decode_ms.clone();
    sorted_dec.sort_by(|a, b| a.partial_cmp(b).unwrap());

    let enc_med = median(&sorted_enc);
    let dec_med = median(&sorted_dec);
    let enc_p99 = percentile(&sorted_enc, 99.0);
    let dec_p99 = percentile(&sorted_dec, 99.0);

    let enc_tps = if enc_med > 0.0 {
        Some(total_tokens as f64 / enc_med * 1000.0)
    } else {
        None
    };
    let dec_tps = if dec_med > 0.0 {
        Some(total_tokens as f64 / dec_med * 1000.0)
    } else {
        None
    };

    let captured_at = chrono_iso_utc_now();

    let result = json!({
        "schema_version": "1",
        "kind": "token_bench",
        "captured_at": captured_at,
        "client": {
            "lang": "rust",
            "lib_name": "codec-rs",
            "lib_version": env!("CARGO_PKG_VERSION"),
            "runtime": format!("rustc {}", option_env!("RUSTC_VERSION").unwrap_or("unknown"))
        },
        "map": {
            "id": map.id,
            "vocab_size": map.vocab_size,
            "sha256": sha256_hex(&map_bytes),
        },
        "corpus": {
            "path": args.corpus_path.display().to_string(),
            "sha256": sha256_hex(&corpus_bytes),
            "samples": samples.len(),
            "total_text_bytes": total_text_bytes,
            "total_tokens": total_tokens,
        },
        "reps": args.reps,
        "warmup_reps": args.warmup,
        "encode_ms_total_median": enc_med,
        "encode_ms_total_p99": enc_p99,
        "decode_ms_total_median": dec_med,
        "decode_ms_total_p99": dec_p99,
        "encode_tokens_per_sec": enc_tps,
        "decode_tokens_per_sec": dec_tps,
    });

    if let Some(parent) = args.out_path.parent() {
        fs::create_dir_all(parent).ok();
    }
    let mut f = fs::File::create(&args.out_path).expect("create out");
    let pretty = serde_json::to_string_pretty(&result).expect("serialize");
    f.write_all(pretty.as_bytes()).expect("write out");

    eprintln!(
        "  rust    encode={:>6.2} ms ({:>10} tok/s)  decode={:>6.2} ms ({:>10} tok/s)  → {}",
        enc_med,
        enc_tps.map(|v| format!("{:.0}", v)).unwrap_or_else(|| "-".into()),
        dec_med,
        dec_tps.map(|v| format!("{:.0}", v)).unwrap_or_else(|| "-".into()),
        args.out_path.display()
    );
}

/// Cheap ISO-8601 UTC clock without a chrono dep. `Y-m-dTH:M:SZ` only.
fn chrono_iso_utc_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    // Days from epoch + civil-from-days (Howard Hinnant's algorithm).
    let z = secs.div_euclid(86_400);
    let s = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(z);
    let (h, m, sec) = (s / 3600, (s / 60) % 60, s % 60);
    let _ = Path::new("");
    format!(
        "{year:04}-{month:02}-{day:02}T{h:02}:{m:02}:{sec:02}Z",
        year = year, month = month, day = day, h = h, m = m, sec = sec,
    )
}

fn civil_from_days(z_days: i64) -> (i64, u32, u32) {
    let z = z_days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as i64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}
