"""Capture the canonical methodology block for one (engine, run_id) pair.

Probes the running server, hashes the tokenizer, captures hardware +
git state, writes a JSON file at:

    packages/bench/methodology/{run_id}/{engine}.json

Every language demo runner reads this file and merges its own client +
bench_tool blocks before emitting unified result JSON.

Usage:
    python capture_methodology.py \
        --engine sglang \
        --endpoint http://192.168.1.88:30000 \
        --model Qwen/Qwen2.5-0.5B-Instruct \
        --run-id 2026-05-07T14-30-00Z \
        [--quantization fp16] \
        [--launch-flags "--mem-fraction-static 0.45"] \
        [--container-image lmsysorg/sglang:nightly-...] \
        [--notes "anything weird about this run"]
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

import httpx


REPO_ROOT = Path(__file__).resolve().parents[3]
METHODOLOGY_DIR = REPO_ROOT / "packages" / "bench" / "methodology"
PROMPTS_FILE = METHODOLOGY_DIR / "prompts.json"


# ---- helpers ---------------------------------------------------------------

def sh(cmd: list[str], cwd: Path | None = None, allow_fail: bool = False) -> str:
    try:
        r = subprocess.run(cmd, cwd=cwd or REPO_ROOT, capture_output=True, text=True,
                           timeout=30, check=not allow_fail)
        return (r.stdout or "").strip()
    except (subprocess.CalledProcessError, FileNotFoundError) as e:
        if allow_fail:
            return ""
        raise


def sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


# ---- block builders --------------------------------------------------------

def hardware_block(ssh_host: str | None) -> dict[str, Any]:
    """Capture hardware. If --ssh-host is provided, probe the remote box
    over SSH (where the engine actually runs). Otherwise probe locally.
    The bench client and the engine often run on different machines:
    we want the engine's hardware in the methodology block."""
    if ssh_host:
        runner = lambda cmd: sh(["ssh", ssh_host, cmd], allow_fail=True)
    else:
        runner = lambda cmd: sh(["bash", "-c", cmd], allow_fail=True)

    host = ssh_host.split("@", 1)[-1] if ssh_host else platform.node()
    cpu_model = ""
    ram_gb: float | None = None

    try:
        cpuinfo = runner("test -r /proc/cpuinfo && grep -m1 'model name' /proc/cpuinfo || true")
        if cpuinfo:
            cpu_model = cpuinfo.split(":", 1)[1].strip() if ":" in cpuinfo else ""
    except Exception:
        pass
    try:
        meminfo = runner("test -r /proc/meminfo && grep -m1 'MemTotal' /proc/meminfo || true")
        if meminfo:
            kib = int(meminfo.split()[1])
            ram_gb = round(kib / 1024 / 1024, 1)
    except Exception:
        pass

    kernel = runner("uname -sr") or platform.platform()

    gpu_model = ""
    gpu_count = 0
    gpu_driver = ""
    try:
        out = runner("command -v nvidia-smi >/dev/null && nvidia-smi --query-gpu=name,driver_version --format=csv,noheader || true")
        lines = [ln.strip() for ln in out.splitlines() if ln.strip()]
        if lines:
            gpu_count = len(lines)
            first = lines[0].split(",")
            gpu_model = first[0].strip()
            if len(first) > 1:
                gpu_driver = first[1].strip()
    except Exception:
        pass

    return {
        "host": host,
        "cpu_model": cpu_model,
        "gpu_model": gpu_model,
        "gpu_count": gpu_count,
        "gpu_driver": gpu_driver,
        "ram_gb": ram_gb,
        "kernel": kernel,
    }


def engine_block(args: argparse.Namespace) -> dict[str, Any]:
    """Probe the running server for its capabilities. The engine version
    is taken from the CLI arg (--engine-version) since the OpenAI-compat
    /v1/models endpoint only exposes the model id, not the server build."""
    endpoint = args.endpoint.rstrip("/")

    # Confirm the server is alive.
    try:
        r = httpx.get(f"{endpoint}/v1/models", timeout=5.0)
        if r.status_code != 200:
            sys.exit(f"server not healthy at {endpoint}: HTTP {r.status_code}")
    except Exception as e:
        sys.exit(f"server not reachable at {endpoint}: {e}")

    # Probe stream_format support. Send each format with stream_format set
    # and check the response Content-Type.
    stream_formats = ["json"]
    for fmt in ("msgpack", "protobuf"):
        try:
            with httpx.stream(
                "POST",
                f"{endpoint}/v1/completions",
                json={"model": args.model, "prompt": "hi", "max_tokens": 2,
                      "stream": True, "stream_format": fmt, "temperature": 0.0},
                timeout=10.0,
            ) as r:
                ct = r.headers.get("content-type", "").lower()
                if f"x-{fmt}" in ct or f"application/{fmt}" in ct or fmt in ct:
                    stream_formats.append(fmt)
        except Exception:
            pass

    # Probe compression support on the Codec path (msgpack if supported,
    # else json). sglang's JSON-SSE doesn't honour Accept-Encoding even
    # when the Codec path does, so this needs to ask the right question.
    probe_format = "msgpack" if "msgpack" in stream_formats else "json"
    compression = ["identity"]
    body = {"model": args.model, "prompt": "hi", "max_tokens": 2,
            "stream": True, "temperature": 0.0}
    if probe_format != "json":
        body["stream_format"] = probe_format
    for enc in ("gzip", "br", "zstd"):
        try:
            with httpx.stream(
                "POST",
                f"{endpoint}/v1/completions",
                json=body,
                headers={"Accept-Encoding": enc},
                timeout=10.0,
            ) as r:
                ce = r.headers.get("content-encoding", "").lower()
                if enc in ce:
                    compression.append(enc)
        except Exception:
            pass

    endpoint_kind = "wan"
    host = endpoint.split("://", 1)[1].split(":", 1)[0]
    if host in ("localhost", "127.0.0.1", "::1"):
        endpoint_kind = "localhost"
    elif host.startswith(("10.", "192.168.", "172.")):
        endpoint_kind = "lan"

    return {
        "name": args.engine,
        "version": args.engine_version or "",
        "branch": args.engine_branch or "",
        "commit": args.engine_commit or "",
        "container_image": args.container_image,
        "launch_flags": args.launch_flags.split() if args.launch_flags else [],
        "endpoint": endpoint,
        "endpoint_kind": endpoint_kind,
        "stream_format_supported": stream_formats,
        "compression_supported": compression,
        "compression_probe_format": probe_format,
    }


def model_block(args: argparse.Namespace) -> dict[str, Any]:
    """Hash the tokenizer if HF cache is reachable, else mark unknown."""
    tokenizer_sha = args.tokenizer_sha or ""
    vocab_size = args.vocab_size

    if not tokenizer_sha:
        # Try to hash from the local HF cache.
        cache_root = Path(os.environ.get("HF_HOME") or Path.home() / ".cache" / "huggingface")
        snapshots = cache_root / "hub" / f"models--{args.model.replace('/', '--')}" / "snapshots"
        if snapshots.exists():
            for snap in snapshots.iterdir():
                tk = snap / "tokenizer.json"
                if tk.exists():
                    tokenizer_sha = sha256_file(tk)
                    if not vocab_size:
                        try:
                            j = json.loads(tk.read_text())
                            vocab_size = len(j.get("model", {}).get("vocab", {})) or None
                        except Exception:
                            pass
                    break

    return {
        "id": args.model,
        "quantization": args.quantization,
        "tokenizer_sha256": tokenizer_sha,
        "vocab_size": vocab_size,
        "model_sha256": None,
    }


def workload_block() -> dict[str, Any]:
    if not PROMPTS_FILE.exists():
        sys.exit(f"prompts.json missing at {PROMPTS_FILE}")
    return {
        "prompts_file": "methodology/prompts.json",
        "prompts_sha256": sha256_file(PROMPTS_FILE),
        "stream": True,
        "temperature": 0.0,
    }


def git_block() -> dict[str, Any]:
    commit = sh(["git", "rev-parse", "HEAD"], allow_fail=True)
    branch = sh(["git", "rev-parse", "--abbrev-ref", "HEAD"], allow_fail=True)
    status = sh(["git", "status", "--porcelain"], allow_fail=True)
    dirty_files: list[str] = []
    if status:
        for line in status.splitlines():
            # ' M path' or '?? path' etc.
            m = re.match(r"^.{2}\s+(.+)$", line)
            if m:
                dirty_files.append(m.group(1))
    return {
        "repo_commit": commit,
        "repo_branch": branch,
        "repo_clean": len(dirty_files) == 0,
        "repo_dirty_files": dirty_files,
    }


# ---- fingerprint -----------------------------------------------------------

EXCLUDE_FROM_FINGERPRINT = {
    ("client",),
    ("bench_tool",),
    ("captured_at",),
    ("notes",),
    ("git", "repo_dirty_files"),
}


def _strip_for_fingerprint(d: dict[str, Any]) -> dict[str, Any]:
    """Return a deep copy of `d` with fingerprint-excluded fields removed."""
    out: dict[str, Any] = {}
    for k, v in d.items():
        if (k,) in EXCLUDE_FROM_FINGERPRINT:
            continue
        if isinstance(v, dict):
            sub_excl = {tuple(p[1:]) for p in EXCLUDE_FROM_FINGERPRINT if len(p) > 1 and p[0] == k}
            out[k] = {sk: sv for sk, sv in v.items() if (sk,) not in sub_excl}
        else:
            out[k] = v
    # Remove client/bench_tool entirely; remove fingerprint itself if present.
    out.pop("fingerprint", None)
    return out


def compute_fingerprint(methodology: dict[str, Any]) -> str:
    stripped = _strip_for_fingerprint(methodology)
    canonical = json.dumps(stripped, sort_keys=True, separators=(",", ":")).encode()
    return sha256_bytes(canonical)


# ---- main ------------------------------------------------------------------

def main() -> None:
    ap = argparse.ArgumentParser(prog="capture_methodology")
    ap.add_argument("--engine", required=True, choices=["sglang", "vllm", "llama.cpp"])
    ap.add_argument("--endpoint", required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--run-id", default=dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ"))
    ap.add_argument("--quantization", default="fp16")
    ap.add_argument("--engine-version", default="")
    ap.add_argument("--engine-branch", default="")
    ap.add_argument("--engine-commit", default="")
    ap.add_argument("--container-image", default=None)
    ap.add_argument("--launch-flags", default="")
    ap.add_argument("--tokenizer-sha", default="")
    ap.add_argument("--vocab-size", type=int, default=None)
    ap.add_argument("--ssh-host", default=None,
                    help="ssh user@host to probe hardware on the engine's box (e.g. vinez@192.168.1.88)")
    ap.add_argument("--notes", default="")
    args = ap.parse_args()

    methodology: dict[str, Any] = {
        "schema_version": "1",
        "captured_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "run_id": args.run_id,
        "hardware": hardware_block(args.ssh_host),
        "engine": engine_block(args),
        "model": model_block(args),
        # client + bench_tool are filled in per-language by each demo runner;
        # placeholders here so the schema validates as a typed object.
        "client": None,
        "bench_tool": None,
        "workload": workload_block(),
        "git": git_block(),
        "notes": args.notes,
    }

    methodology["fingerprint"] = compute_fingerprint(methodology)

    out_dir = METHODOLOGY_DIR / args.run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{args.engine}.json"
    out_path.write_text(json.dumps(methodology, indent=2))

    print(f"wrote {out_path}", file=sys.stderr)
    print(f"fingerprint: {methodology['fingerprint']}", file=sys.stderr)
    print(f"engine.stream_format_supported: {methodology['engine']['stream_format_supported']}", file=sys.stderr)
    print(f"engine.compression_supported:   {methodology['engine']['compression_supported']}", file=sys.stderr)
    if not methodology["git"]["repo_clean"]:
        print(f"WARNING: repo dirty ({len(methodology['git']['repo_dirty_files'])} files)", file=sys.stderr)
    print(out_path)


if __name__ == "__main__":
    main()
