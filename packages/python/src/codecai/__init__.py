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
from .discover import (
    MapDiscoveryError,
    MapDiscoveryNotFoundError,
    MapIndex,
    MapPointer,
    WELL_KNOWN_BASE,
    ZstdDictDiscoveryError,
    ZstdDictHashMismatchError,
    discover_index,
    discover_map,
    discover_zstd_dict,
    well_known_dict_url,
    well_known_index_url,
    well_known_map_url,
)
from .tool_watcher import (
    ToolWatcher,
    ToolWatcherError,
    WatcherEvent,
)
from .translate import (
    Translator,
    static_translation_table,
    translate,
)
from .compression import (
    CodecZstdDictError,
    hash_zstd_dict,
    select_zstd_dict_for_response,
)
from .safety_policy import (
    POLICY_WELL_KNOWN_BASE,
    Category as SafetyCategory,
    ClassifierBlock as SafetyClassifierBlock,
    ClientHooksBlock as SafetyClientHooksBlock,
    MemorySafetyPolicyCache,
    PublisherBlock as SafetyPublisherBlock,
    RulesSummary as SafetyRulesSummary,
    SafetyPolicyCache,
    SafetyPolicyDescriptor,
    SafetyPolicyDiscoveryError,
    SafetyPolicyDiscoveryNotFoundError,
    SafetyPolicyHashMismatchError,
    SafetyPolicyPointer,
    SafetyPolicyValidationError,
    descriptor_canonical_bytes,
    descriptor_from_json,
    discover_safety_policy,
    hash_safety_policy,
    load_safety_policy,
    validate_safety_policy,
    well_known_policy_hash_url,
    well_known_policy_url,
)

__version__ = "0.2.0"

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
    # discovery
    "WELL_KNOWN_BASE",
    "MapDiscoveryError",
    "MapDiscoveryNotFoundError",
    "MapIndex",
    "MapPointer",
    "discover_index",
    "discover_map",
    "well_known_index_url",
    "well_known_map_url",
    # tool watcher
    "ToolWatcher",
    "ToolWatcherError",
    "WatcherEvent",
    # translate
    "Translator",
    "translate",
    "static_translation_table",
    # compression
    "CodecZstdDictError",
    "hash_zstd_dict",
    "select_zstd_dict_for_response",
    # safety policy (slice 11)
    "POLICY_WELL_KNOWN_BASE",
    "MemorySafetyPolicyCache",
    "SafetyCategory",
    "SafetyClassifierBlock",
    "SafetyClientHooksBlock",
    "SafetyPolicyCache",
    "SafetyPolicyDescriptor",
    "SafetyPolicyDiscoveryError",
    "SafetyPolicyDiscoveryNotFoundError",
    "SafetyPolicyHashMismatchError",
    "SafetyPolicyPointer",
    "SafetyPolicyValidationError",
    "SafetyPublisherBlock",
    "SafetyRulesSummary",
    "descriptor_canonical_bytes",
    "descriptor_from_json",
    "discover_safety_policy",
    "hash_safety_policy",
    "load_safety_policy",
    "validate_safety_policy",
    "well_known_policy_hash_url",
    "well_known_policy_url",
    # v0.4 version negotiation
    "CODEC_CLIENT_VERSION",
    "CODEC_CLIENT_VERSION_HEADER",
    "CODEC_MIN_VERSION_HEADER",
    "CODEC_REQUIRED_FEATURES_HEADER",
    "with_codec_client_version",
    "parse_version_required",
    "discover_version_policy",
    "parse_version_policy_document",
    "well_known_version_policy_url",
    "CodecVersionRequiredError",
    "CodecVersionRequiredBody",
    "CodecVersionPolicyDocument",
    "__version__",
]


from .version_signaling import (
    CODEC_CLIENT_VERSION,
    CODEC_CLIENT_VERSION_HEADER,
    CODEC_MIN_VERSION_HEADER,
    CODEC_REQUIRED_FEATURES_HEADER,
    CodecVersionPolicyDocument,
    CodecVersionRequiredBody,
    CodecVersionRequiredError,
    discover_version_policy,
    parse_version_policy_document,
    parse_version_required,
    well_known_version_policy_url,
    with_codec_client_version,
)
