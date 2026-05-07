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
// No-dict zstd is never picked — RESULTS.md §1d showed it's catastrophically
// slow on shipped middleware, and §1f showed its byte advantage over gzip is
// noise on Codec streams.

describe('pick — rule: zstd only with dict + streaming middleware', () => {
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

  it('zstdHasDict alone → still gzip (middleware not confirmed streaming)', () => {
    const r = pick({
      acceptEncoding: ALL_CLIENT,
      estimatedSize: 1024,
      zstdHasDict: true,
      // zstdEnabled not set
    });
    assert.equal(r.encoding, 'gzip');
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
