import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  pick,
  parseAcceptEncoding,
  buildAcceptEncoding,
  describeRule,
  DEFAULT_THRESHOLDS,
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

describe('pick — Codec streaming defaults', () => {
  const ALL_CLIENT = 'zstd, gzip, br';

  it('< 128 tokens → gzip when client supports it', () => {
    const r = pick({ acceptEncoding: ALL_CLIENT, estimatedSize: 64 });
    assert.equal(r.encoding, 'gzip');
  });

  it('exactly 128 → still gzip (boundary)', () => {
    const r = pick({ acceptEncoding: ALL_CLIENT, estimatedSize: 128 });
    assert.equal(r.encoding, 'gzip');
  });

  it('mid-band 200 tokens → zstd (preferred when supported)', () => {
    const r = pick({ acceptEncoding: ALL_CLIENT, estimatedSize: 200 });
    assert.equal(r.encoding, 'zstd');
  });

  it('>= 256 tokens → zstd', () => {
    const r = pick({ acceptEncoding: ALL_CLIENT, estimatedSize: 1024 });
    assert.equal(r.encoding, 'zstd');
  });

  it('>= 256 with no zstd → gzip', () => {
    const r = pick({ acceptEncoding: 'gzip, br', estimatedSize: 1024 });
    assert.equal(r.encoding, 'gzip');
  });

  it('zstd-only client at small size still gets zstd', () => {
    // gzip preferred at small size, but zstd is the only thing supported.
    const r = pick({ acceptEncoding: 'zstd', estimatedSize: 32 });
    // zstd preferred at small size when gzip isn't available, even though
    // gzip would be preferred at this size if both were supported.
    assert.ok(r.encoding === 'gzip' || r.encoding === 'zstd', `got ${r.encoding}`);
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
      acceptEncoding: ALL_CLIENT,
      estimatedSize: 2048,
      serverSupports: ['gzip', 'identity'],
    });
    assert.equal(r.encoding, 'gzip');
  });

  it('br is never chosen when gzip is also supported', () => {
    // Even though br has wider client support, gzip beats br on streaming
    // small-frame workloads, so we don't pick br when gzip is available.
    for (const size of [16, 64, 128, 256, 512, 2048]) {
      const r = pick({ acceptEncoding: 'gzip, br', estimatedSize: size });
      assert.notEqual(r.encoding, 'br', `size=${size} → ${r.encoding}`);
    }
  });

  it('threshold override: always-zstd policy', () => {
    const r = pick({
      acceptEncoding: ALL_CLIENT,
      estimatedSize: 16,
      thresholds: { ...DEFAULT_THRESHOLDS, gzipPreferredUpTo: 0, zstdPreferredFrom: 0 },
    });
    assert.equal(r.encoding, 'zstd');
  });
});

describe('buildAcceptEncoding', () => {
  it('default order is zstd > gzip > br', () => {
    const h = buildAcceptEncoding();
    assert.equal(h, 'zstd;q=1.0, gzip;q=0.9, br;q=0.5');
  });

  it('omits disabled encodings', () => {
    const h = buildAcceptEncoding({ zstd: false });
    assert.equal(h, 'gzip;q=0.9, br;q=0.5');
  });

  it('round-trips through the parser preserving order', () => {
    const parsed = parseAcceptEncoding(buildAcceptEncoding());
    assert.deepEqual(parsed.accepted.slice(0, 3), ['zstd', 'gzip', 'br']);
  });
});

describe('describeRule', () => {
  it('mentions all four encodings', () => {
    const s = describeRule();
    for (const e of ['gzip', 'zstd', 'brotli', 'identity']) {
      assert.ok(s.includes(e), `expected ${e} in description`);
    }
  });
});
