/**
 * Synthetic token-stream generator. Real LLM streams emit chunks of varying
 * size (vLLM defaults to 1 token per chunk; some servers batch 2–8). We sweep
 * over realistic chunk sizes so the bench reflects observed behavior.
 */

export interface StreamShape {
  totalTokens: number;
  chunkSize: number; // tokens per emit; 1 = OpenAI default
  vocabSize: number; // upper bound on token IDs (Llama ~128k, Claude ~200k)
}

export interface SyntheticChunk {
  ids: number[];
  done: boolean;
}

/**
 * Deterministic generator (seeded LCG) so successive runs produce identical
 * byte counts — essential for repeatable comparisons.
 */
export function* synth(shape: StreamShape, seed = 0xdeadbeef): Generator<SyntheticChunk> {
  let s = seed >>> 0;
  let emitted = 0;
  while (emitted < shape.totalTokens) {
    const remaining = shape.totalTokens - emitted;
    const take = Math.min(shape.chunkSize, remaining);
    const ids: number[] = new Array(take);
    for (let i = 0; i < take; i++) {
      // xorshift32
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      s >>>= 0;
      ids[i] = s % shape.vocabSize;
    }
    emitted += take;
    yield { ids, done: emitted >= shape.totalTokens };
  }
}

export function collect(shape: StreamShape, seed?: number): SyntheticChunk[] {
  return Array.from(synth(shape, seed));
}
