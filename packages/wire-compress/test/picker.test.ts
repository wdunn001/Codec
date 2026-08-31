import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  pick,
  parseAcceptEncoding,
  buildAcceptEncoding,
  describeRule,
} from '../src/index.ts';

describe('parseAcceptEncoding', () => {
  it('null → unspecified, identity-only', () => {
    const r = parseAcceptEncoding(null);
    assert.equal(r.unspecified, true);
    assert.deepEqual(r.accepted, ['identity']);
  });

  it('orders by q-value desc', () => {
    const r = parseAcceptEncoding('br;q=0.5, gzip;q=1.0, zstd;q=0.8');
    assert.deepEqual(r.accepted, ['gzip', 'zstd', 'br', 'identity']);
  });

  it('drops q=0 entries', () => {
    const r = parseAcceptEncoding('gzip;q=0, zstd;q=1.0');
    assert.deepEqual(r.accepted, ['zstd', 'identity']);
  });

  it('appends identity by default', () => {
    const r = parseAcceptEncoding('gzip');
    assert.ok(r.accepted.includes('identity'));
  });

  it('respects identity;q=0', () => {
    const r = parseAcceptEncoding('gzip, identity;q=0');
    assert.ok(!r.accepted.includes('identity'));
  });
});

// Selection rule under the new model: zstd is chosen ONLY when both
// `zstdHasDict` and `zstdEnabled` are true. Otherwise gzip > br > identity.
// No-dict zstd is never picked: RESULTS.md §1d showed it's catastrophically
// slow on shipped middleware, and §1f showed its byte advantage over gzip is
// noise on Codec streams.

describe('pick: rule: zstd only with dict + streaming middleware', () => {
  const ALL_CLIENT = 'zstd, gzip, br';
  const READY = { zstdHasDict: true, zstdEnabled: true } as const;

  it('default (no flags) → gzip even with full client support', () => {
    const r = pick({ acceptEncoding: ALL_CLIENT, estimatedSize: 1024 });
    assert.equal(r.encoding, 'gzip');
  });

  it('zstdEnabled alone → still gzip (no dict, no zstd)', () => {
    // The point of the new rule: enabling zstd middleware without a dict
    // is a footgun. Picker refuses to use zstd until both gates open.
    const r = pick({
      acceptEncoding: ALL_CLIENT,
      estimatedSize: 1024,
      zstdEnabled: true,
      // zstdHasDict not set
    });
    assert.equal(r.encoding, 'gzip');
  });

  it('zstdHasDict alone (v0.5: zstdEnabled defaults true) → zstd', () => {
    // v0.5 contract change: zstdEnabled default flipped false → true,
    // since sglang/vllm/llamacpp all stream zstd correctly at v0.4.1+.
    // Operators with buffered-zstd middleware MUST set zstdEnabled=false
    // explicitly; the test below covers that opt-out case.
    const r = pick({
      acceptEncoding: ALL_CLIENT,
      estimatedSize: 1024,
      zstdHasDict: true,
      // zstdEnabled defaults to true at v0.5
    });
    assert.equal(r.encoding, 'zstd');
    assert.equal(r.reason_code, 'dict_zstd_default');
  });

  it('zstdHasDict + zstdEnabled=false (v0.5 opt-out) → gzip', () => {
    // Operators with buffered-zstd middleware opt out explicitly.
    const r = pick({
      acceptEncoding: ALL_CLIENT,
      estimatedSize: 1024,
      zstdHasDict: true,
      zstdEnabled: false,
    });
    assert.equal(r.encoding, 'gzip');
    assert.equal(r.reason_code, 'gzip_middleware_disabled');
  });

  it('both gates open + client supports zstd → zstd at every size', () => {
    for (const size of [16, 64, 128, 256, 1024, 8192]) {
      const r = pick({ ...READY, acceptEncoding: ALL_CLIENT, estimatedSize: size });
      assert.equal(r.encoding, 'zstd', `size=${size} → ${r.encoding}`);
    }
  });

  it('both gates open + interactive=true (default) → zstd', () => {
    // The dict's streaming-TTFB cost is +0.13 ms (RESULTS.md §1g),
    // dwarfed by network. Interactive flag no longer forces gzip.
    const r = pick({ ...READY, acceptEncoding: ALL_CLIENT, estimatedSize: 64, interactive: true });
    assert.equal(r.encoding, 'zstd');
  });

  it('both gates open + interactive=false → zstd', () => {
    const r = pick({ ...READY, acceptEncoding: ALL_CLIENT, estimatedSize: 64, interactive: false });
    assert.equal(r.encoding, 'zstd');
  });

  it('zstd-only client without dict → identity (refuse no-dict zstd)', () => {
    // Server doesn't have a dict. Client says zstd-only. Picker MUST NOT
    // return zstd (TTFT cliff + zero byte advantage). Returns identity.
    const r = pick({ acceptEncoding: 'zstd', estimatedSize: 1024 });
    assert.equal(r.encoding, 'identity');
  });

  it('zstd-only client with dict + streaming → zstd', () => {
    const r = pick({ ...READY, acceptEncoding: 'zstd', estimatedSize: 1024 });
    assert.equal(r.encoding, 'zstd');
  });

  it('br-only client → br fallback', () => {
    const r = pick({ acceptEncoding: 'br', estimatedSize: 1024 });
    assert.equal(r.encoding, 'br');
  });

  it('identity-only client → identity', () => {
    const r = pick({ acceptEncoding: 'identity', estimatedSize: 1024 });
    assert.equal(r.encoding, 'identity');
  });

  it('no Accept-Encoding header → uses identity (RFC fallback)', () => {
    const r = pick({ acceptEncoding: null, estimatedSize: 1024 });
    assert.equal(r.encoding, 'identity');
  });

  it('server-side capability restriction', () => {
    const r = pick({
      ...READY,
      acceptEncoding: ALL_CLIENT,
      estimatedSize: 2048,
      serverSupports: ['gzip', 'identity'],
    });
    assert.equal(r.encoding, 'gzip');
  });

  it('br is never chosen when gzip is also supported', () => {
    for (const size of [16, 64, 128, 256, 512, 2048]) {
      const r = pick({ acceptEncoding: 'gzip, br', estimatedSize: size });
      assert.notEqual(r.encoding, 'br', `size=${size} → ${r.encoding}`);
    }
  });

  it('zstd never chosen by default (both gates closed)', () => {
    for (const size of [16, 256, 2048]) {
      const r = pick({ acceptEncoding: 'zstd, gzip, br', estimatedSize: size });
      assert.notEqual(r.encoding, 'zstd', `size=${size} → ${r.encoding}`);
    }
  });

  it('reason string mentions dict requirement when zstd is suppressed', () => {
    const r = pick({ acceptEncoding: 'zstd, gzip', estimatedSize: 1024 });
    assert.equal(r.encoding, 'gzip');
    assert.ok(/dict/i.test(r.reason), `expected dict mention, got: ${r.reason}`);
  });
});

describe('buildAcceptEncoding', () => {
  it('default omits zstd; order is gzip > br', () => {
    const h = buildAcceptEncoding();
    assert.equal(h, 'gzip;q=1.0, br;q=0.5');
  });

  it('explicit opt-in adds zstd at low q', () => {
    const h = buildAcceptEncoding({ zstd: true });
    assert.equal(h, 'gzip;q=1.0, br;q=0.5, zstd;q=0.3');
  });

  it('omits disabled encodings', () => {
    const h = buildAcceptEncoding({ br: false });
    assert.equal(h, 'gzip;q=1.0');
  });

  it('round-trips through the parser preserving order', () => {
    const parsed = parseAcceptEncoding(buildAcceptEncoding());
    assert.deepEqual(parsed.accepted.slice(0, 2), ['gzip', 'br']);
  });
});

describe('describeRule', () => {
  it('mentions all four encodings and the dict precondition', () => {
    const s = describeRule();
    for (const e of ['gzip', 'zstd', 'brotli', 'identity']) {
      assert.ok(s.includes(e), `expected ${e} in description`);
    }
    assert.ok(/dict/i.test(s), 'expected dict precondition mention');
    assert.ok(/zstdHasDict/.test(s), 'expected zstdHasDict gate mention');
  });
});

// ── v0.5 picker rewrite: per-stack + content-aware ─────────────────────────

import {
  STACK_PROFILES,
  profileFor,
  shannonEntropyBitsPerByte,
  MAX_TTFT_RATIO,
} from '../src/index.ts';

describe('v0.5 picker: per-stack profile drops', () => {
  const ALL = 'zstd, gzip, br';

  it('custom profile with zstd ttftRatio > MAX → drops zstd', () => {
    const buffered = {
      name: 'custom-buffered-zstd',
      encodings: {
        gzip: { wireCoeff: 0.05, ttftRatio: 1.0 },
        br: { wireCoeff: 0.5, ttftRatio: 1.0 },
        zstd: { wireCoeff: 0.05, ttftRatio: MAX_TTFT_RATIO + 100 },
      },
    };
    const r = pick({
      acceptEncoding: ALL,
      estimatedSize: 1024,
      zstdHasDict: true,
      zstdEnabled: true,
      stackProfile: buffered,
    });
    assert.equal(r.encoding, 'gzip');
    assert.equal(r.reason_code, 'per_stack_overrode_zstd');
  });

  it('sglang profile (v0.5: zstd ttftRatio=1.0) → zstd', () => {
    const r = pick({
      acceptEncoding: ALL,
      estimatedSize: 1024,
      zstdHasDict: true,
      stackProfile: STACK_PROFILES.sglang,
    });
    assert.equal(r.encoding, 'zstd');
  });

  it('profileFor unknown stack falls back to default', () => {
    const p = profileFor('not-a-real-stack');
    assert.equal(p.name, 'default');
  });
});

describe('v0.5 picker: content-aware tiebreaker', () => {
  const ALL = 'zstd, gzip, br';
  const READY = { zstdHasDict: true } as const;

  it('low-entropy sample + br + zstd both viable → br', () => {
    // Long run of one byte → very low entropy.
    const sample = new Uint8Array(256).fill(0x41);
    const r = pick({
      ...READY,
      acceptEncoding: ALL,
      estimatedSize: 1024,
      sampleBytes: sample,
    });
    assert.equal(r.encoding, 'br');
    assert.equal(r.reason_code, 'br_content_sample_low_entropy');
  });

  it('high-entropy sample → zstd default', () => {
    // Uniform random bytes → entropy near 8.
    const sample = new Uint8Array(256);
    for (let i = 0; i < sample.length; i++) sample[i] = (i * 31 + 17) & 0xff;
    const r = pick({
      ...READY,
      acceptEncoding: ALL,
      estimatedSize: 1024,
      sampleBytes: sample,
    });
    assert.equal(r.encoding, 'zstd');
    assert.equal(r.reason_code, 'dict_zstd_default');
  });

  it('no sample provided → behaviour unchanged', () => {
    const r = pick({ ...READY, acceptEncoding: ALL, estimatedSize: 1024 });
    assert.equal(r.encoding, 'zstd');
    assert.equal(r.reason_code, 'dict_zstd_default');
  });
});

describe('v0.5 picker: reason_code enum coverage', () => {
  it('every output carries a typed reason_code matching the encoding choice', () => {
    const cases: Array<{ input: Parameters<typeof pick>[0]; encoding: string }> = [
      { input: { acceptEncoding: 'gzip', estimatedSize: 1024 }, encoding: 'gzip' },
      { input: { acceptEncoding: 'br', estimatedSize: 1024 }, encoding: 'br' },
      { input: { acceptEncoding: '', estimatedSize: 1024 }, encoding: 'identity' },
    ];
    for (const { input, encoding } of cases) {
      const r = pick(input);
      assert.equal(r.encoding, encoding);
      assert.ok(typeof r.reason_code === 'string' && r.reason_code.length > 0);
    }
  });

  it('considered[] is populated', () => {
    const r = pick({ acceptEncoding: 'gzip, br', estimatedSize: 1024 });
    assert.ok(Array.isArray(r.considered));
    assert.ok(r.considered!.length >= 1);
  });
});

describe('shannonEntropyBitsPerByte', () => {
  it('all-zero bytes → 0 entropy', () => {
    const e = shannonEntropyBitsPerByte(new Uint8Array(100).fill(0));
    assert.equal(e, 0);
  });

  it('uniform-distribution bytes → ~8 entropy', () => {
    const bs = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bs[i] = i;
    const e = shannonEntropyBitsPerByte(bs);
    assert.ok(e > 7.5 && e <= 8, `expected ~8, got ${e}`);
  });

  it('empty buffer → 0', () => {
    assert.equal(shannonEntropyBitsPerByte(new Uint8Array(0)), 0);
  });
});
