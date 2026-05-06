"""
codecai — Python client for the Codec binary transport protocol.

The Python twin of `@codecai/web` (browser/Node) and `Codec.Net` (.NET).
Same tokenizer dialect maps work everywhere.

Quick start::

    from codecai import load_map, Detokenizer, decode_msgpack_stream
    import httpx

    map = await load_map(url="https://cdn.jsdelivr.net/gh/wdunn001/codec-maps/maps/qwen/qwen2.json",
                         hash="sha256:c73972f7a580…")
    detok = Detokenizer(map)
    async with httpx.AsyncClient() as client:
        async with client.stream("POST", "http://localhost:8000/v1/completions",
                                 json={"model": "...", "prompt": "Explain entropy.",
                                       "stream_format": "msgpack", "max_tokens": 256}) as resp:
            async for frame in decode_msgpack_stream(resp.aiter_raw()):
                print(detok.render(frame.ids, partial=not frame.done), end="", flush=True)
"""

from .types import (
    CodecFrame,
    MapCache,
    MemoryMapCache,
    TokenizerMap,
    TokenizerMapValidationError,
)
from .encoder import (
    METASPACE,
    decode_byte_level_token,
    encode_byte_level_chars,
)
from .detokenize import Detokenizer, detokenize
from .tokenize import (
    BPETokenizer,
    LongestMatchTokenizer,
    Tokenizer,
    pick_tokenizer,
    tokenize,
)
from .stream import (
    decode_msgpack_stream,
    decode_protobuf_frame,
    decode_protobuf_stream,
    decode_stream,
)
from .map_loader import (
    LoadOptions,
    TokenizerMapHashMismatchError,
    load_map,
)

__version__ = "0.1.0"

__all__ = [
    # types
    "CodecFrame",
    "MapCache",
    "MemoryMapCache",
    "TokenizerMap",
    "TokenizerMapValidationError",
    # encoder
    "METASPACE",
    "decode_byte_level_token",
    "encode_byte_level_chars",
    # detokenize
    "Detokenizer",
    "detokenize",
    # tokenize
    "BPETokenizer",
    "LongestMatchTokenizer",
    "Tokenizer",
    "pick_tokenizer",
    "tokenize",
    # stream
    "decode_msgpack_stream",
    "decode_protobuf_frame",
    "decode_protobuf_stream",
    "decode_stream",
    # map loader
    "LoadOptions",
    "TokenizerMapHashMismatchError",
    "load_map",
    "__version__",
]
