/**
 * Public types for @codecai/web's latent modality (v0.3+).
 *
 * A `LatentSpaceMap` is a per-model dialect for image-/video-latent streams.
 * It mirrors `TokenizerMap` for text-tokens — a content-addressed JSON
 * document that names the latent shape/dtype, references one or more
 * runtime-portable decoder graphs (ONNX / ggml / safetensors / WGSL) by
 * sha256 hash, lists the transform pipelines the latents may travel under,
 * and optionally declares pre-trained zstd dictionaries per (format,
 * pipeline) pair.
 *
 * Schema: spec/latent-space-map.schema.json (v1).
 */

/**
 * Named transform pipelines applied to latent tensors before they hit the
 * wire. Bit-level math pinned in spec/PIPELINES.md.
 *
 * `raw` is the universal floor and the negotiation fallback — every
 * implementation supports it; if client and server share no other pipeline,
 * they MUST land on `raw`.
 */
export type LatentPipeline =
  | 'raw'
  | 'int8'
  | 'int4'
  | 'int8-adaptive'
  | 'int4-adaptive'
  | 'delta+int8'
  | 'delta+int4';

/** Decoder runtimes a client may declare via `accept_decoders` at HELLO. */
export type LatentDecoderRuntime =
  | 'onnx-web'
  | 'onnx'
  | 'torch'
  | 'ggml'
  | 'wgsl'
  | 'safetensors-pt';

/**
 * A runtime-portable decoder graph reference. A `LatentSpaceMap` carries one
 * or more of these so a single map can serve clients across runtimes from one
 * CDN pin. All entries on a map MUST decode the same latent space — i.e.
 * plug-compatible at the latent boundary.
 */
export interface LatentDecoder {
  readonly runtime: LatentDecoderRuntime;
  readonly url: string;
  readonly hash: string;
  readonly size_bytes: number;

  /** Decoder graph input shape including batch dim, e.g. `[1, 4, 64, 64]`. */
  readonly input_shape: readonly number[];

  /** Element dtype the decoder expects at its input. */
  readonly input_dtype: 'fp32' | 'fp16' | 'bf16';

  readonly output: {
    readonly format: 'rgb_uint8' | 'rgb_fp16' | 'bgr_uint8' | 'yuv420p_uint8';
    readonly shape: readonly number[];
    readonly dtype: 'uint8' | 'fp16' | 'fp32';
  };

  /** SPDX license identifier or `"proprietary"`. */
  readonly license?: string;
}

/**
 * Pre-trained zstd dictionary keyed by `(format, pipeline)` — the two axes
 * that define the byte distribution the dict is trained against. A dict
 * trained for one pair is meaningless against any other pair; servers MUST
 * NOT respond with `Content-Encoding: zstd` unless they have loaded a dict
 * whose `(format, pipeline)` matches the response.
 */
export interface LatentZstdDictionaryEntry {
  readonly format: 'msgpack' | 'protobuf';
  readonly pipeline: LatentPipeline;
  readonly url: string;
  readonly hash: string;
  readonly size_bytes: number;
}

/** Optional video-modality metadata. Absent on image-only VAE maps. */
export interface LatentVideoMetadata {
  readonly default_fps?: number;
  readonly keyframe_interval?: number;
  readonly temporal_axis?: 'per-frame' | 'block';
}

/**
 * A per-model dialect for image-/video-latent streams. Loaded lazily by the
 * client and cached by `(id, hash)`.
 */
export interface LatentSpaceMap {
  /** Stable, globally unique latent-space identifier (e.g. `stabilityai/sd-vae-ft-mse`). */
  readonly id: string;

  /** Schema version. Currently `"1"`. */
  readonly version: string;

  /** Kind of learned compression. `"vae"` is the only v1 option. */
  readonly space_kind: 'vae';

  /**
   * Per-frame latent tensor shape, **excluding** the batch dimension.
   * For SD-1 at 512×512 this is `[4, 64, 64]` (channels, height, width).
   */
  readonly shape: readonly number[];

  /**
   * Element dtype of the **raw** latent — the dtype the model produces before
   * any pipeline transform. Pipelines like `int8` convert at the wire boundary.
   */
  readonly dtype: 'fp32' | 'fp16' | 'bf16' | 'int8' | 'int4';

  /**
   * The model's known latent scale factor (e.g. 0.18215 for SD-1, 0.13025 for
   * SDXL). Decoders multiply latents by this scale before the first conv block.
   */
  readonly vae_scale_factor?: number;

  /** One or more runtime-portable decoder graph references. MUST be non-empty. */
  readonly decoders: readonly LatentDecoder[];

  /**
   * Names of the transform pipelines this map supports on the wire. MUST
   * include `"raw"` — the negotiation fallback. Each entry MUST appear in the
   * normative pipeline registry defined by `spec/PIPELINES.md`.
   */
  readonly pipelines: readonly LatentPipeline[];

  /** Pre-trained zstd dictionaries, optional, keyed by `(format, pipeline)`. */
  readonly zstd_dictionaries?: readonly LatentZstdDictionaryEntry[];

  /** Video-modality metadata. Absent on image-only VAE maps. */
  readonly video?: LatentVideoMetadata;

  readonly published_at?: string;
}

/**
 * Pluggable cache for loaded latent-space maps. Default is in-memory; same
 * pattern as `MapCache` for tokenizer maps, with a separate type so the two
 * caches don't collide.
 */
export interface LatentSpaceMapCache {
  get(key: string): Promise<LatentSpaceMap | undefined>;
  set(key: string, map: LatentSpaceMap): Promise<void>;
}
