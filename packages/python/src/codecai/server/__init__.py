"""
codecai.server: server-side encoding utilities for the Codec binary transport.

Most users of `codecai` are *clients*: they decode token-ID frames from a
remote inference server. This submodule is the other side: helpers a
*server* uses to *produce* Codec frames.

Currently only the latent modality (v0.3+) is exposed here, since the
text modalities are vendored directly inside each engine fork (see
`codec_frame.py` in vllm/sglang/llama.cpp). The latent helpers were
written from-scratch for v0.3 and live here so every latent-aware
server fork (ComfyUI, diffusers reference, future ones) can vendor a
single canonical copy with a tested home.

Optional install:

    pip install codecai[server]

The `[server]` extra pulls in numpy (the latent pipelines need real
tensor math). The base `codecai` install stays numpy-free.
"""

from .latent_frame import (
    LatentStreamEncoder,
    encode_latent_header_msgpack,
    encode_latent_header_protobuf,
    encode_latent_frame_msgpack,
    encode_latent_frame_protobuf,
    PIPELINE_NAMES,
    PROTO_SCHEMA,
)

__all__ = [
    "LatentStreamEncoder",
    "encode_latent_header_msgpack",
    "encode_latent_header_protobuf",
    "encode_latent_frame_msgpack",
    "encode_latent_frame_protobuf",
    "PIPELINE_NAMES",
    "PROTO_SCHEMA",
]
