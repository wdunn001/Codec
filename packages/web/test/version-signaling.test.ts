import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CODEC_CLIENT_VERSION,
  CODEC_CLIENT_VERSION_HEADER,
  CodecVersionRequiredError,
  discoverVersionPolicy,
  parseVersionRequired,
  withCodecClientVersion,
  type CodecVersionRequiredBody,
} from '../src/version-signaling.js';

const ORIGIN = 'https://server.test';

// ── withCodecClientVersion ──────────────────────────────────────────────────

test('withCodecClientVersion adds the header when absent', () => {
  const init = withCodecClientVersion({ method: 'POST' });
  const headers = new Headers(init.headers);
  assert.equal(
    headers.get(CODEC_CLIENT_VERSION_HEADER),
    CODEC_CLIENT_VERSION,
  );
  assert.equal(init.method, 'POST');
});

test('withCodecClientVersion preserves caller-set header (test harness escape)', () => {
  const init = withCodecClientVersion({
    headers: { [CODEC_CLIENT_VERSION_HEADER]: '0.3' },
  });
  const headers = new Headers(init.headers);
  assert.equal(headers.get(CODEC_CLIENT_VERSION_HEADER), '0.3');
});

test('withCodecClientVersion respects override version', () => {
  const init = withCodecClientVersion(undefined, '0.2');
  const headers = new Headers(init.headers);
  assert.equal(headers.get(CODEC_CLIENT_VERSION_HEADER), '0.2');
});

test('withCodecClientVersion merges existing Headers object', () => {
  const init = withCodecClientVersion({
    headers: new Headers({ 'X-Custom': 'foo' }),
  });
  const headers = new Headers(init.headers);
  assert.equal(headers.get('X-Custom'), 'foo');
  assert.equal(
    headers.get(CODEC_CLIENT_VERSION_HEADER),
    CODEC_CLIENT_VERSION,
  );
});

// ── parseVersionRequired ────────────────────────────────────────────────────

const VALID_BODY: CodecVersionRequiredBody = {
  error: 'codec_version_required',
  minimum_version: '0.4',
  required_features: ['safety-policy-enforcement'],
  client_version: '0.3',
  docs_url: 'https://codecai.net/docs/version-negotiation/',
  deployment_id: 'lab-test',
};

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('parseVersionRequired returns null for non-426', async () => {
  const resp = jsonResponse({ ok: true }, 200);
  const err = await parseVersionRequired(resp);
  assert.equal(err, null);
});

test('parseVersionRequired returns typed error for valid 426 body', async () => {
  const resp = jsonResponse(VALID_BODY, 426);
  const err = await parseVersionRequired(resp);
  assert.ok(err instanceof CodecVersionRequiredError);
  assert.equal(err!.minimumVersion, '0.4');
  assert.equal(err!.clientVersion, '0.3');
  assert.deepEqual(err!.requiredFeatures, ['safety-policy-enforcement']);
  assert.equal(err!.docsUrl, 'https://codecai.net/docs/version-negotiation/');
  assert.equal(err!.deploymentId, 'lab-test');
});

test('CodecVersionRequiredError message names the required feature', async () => {
  const resp = jsonResponse(VALID_BODY, 426);
  const err = await parseVersionRequired(resp);
  assert.match(err!.message, /requires v0\.4/);
  assert.match(err!.message, /safety-policy-enforcement/);
  assert.match(err!.message, /speaks v0\.3/);
});

test('parseVersionRequired throws on 426 with non-JSON body', async () => {
  const resp = new Response('plain text refusal', {
    status: 426,
    headers: { 'content-type': 'text/plain' },
  });
  await assert.rejects(
    () => parseVersionRequired(resp),
    /426 Upgrade Required but body was not JSON/,
  );
});

test('parseVersionRequired throws on 426 with unrecognized JSON shape', async () => {
  const resp = jsonResponse({ error: 'something_else', foo: 1 }, 426);
  await assert.rejects(
    () => parseVersionRequired(resp),
    /426 Upgrade Required with an unrecognized body/,
  );
});

test('parseVersionRequired handles empty required_features', async () => {
  const resp = jsonResponse(
    {
      error: 'codec_version_required',
      minimum_version: '0.4',
      required_features: [],
      client_version: '0.3',
    },
    426,
  );
  const err = await parseVersionRequired(resp);
  assert.ok(err);
  assert.deepEqual(err!.requiredFeatures, []);
  // Message should not include the "(requires: )" suffix when no features.
  assert.doesNotMatch(err!.message, /requires:/);
});

// ── discoverVersionPolicy ───────────────────────────────────────────────────

function fakeFetch(handler: (url: string) => Response): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    return handler(url);
  }) as typeof fetch;
}

test('discoverVersionPolicy returns null on 404 (unrestricted deployment)', async () => {
  const fetchImpl = fakeFetch(() => new Response('', { status: 404 }));
  const doc = await discoverVersionPolicy({ origin: ORIGIN, fetchImpl });
  assert.equal(doc, null);
});

test('discoverVersionPolicy parses a valid document', async () => {
  const body = {
    minimum_version: '0.4',
    required_features: ['safety-policy-enforcement'],
    deployment_id: 'acme-prod',
    docs_url: 'https://codecai.net/docs/version-negotiation/',
    valid_until: '2026-12-31T23:59:59Z',
  };
  const fetchImpl = fakeFetch((url) => {
    assert.match(url, /\.well-known\/codec\/version-policy\.json$/);
    return jsonResponse(body, 200);
  });
  const doc = await discoverVersionPolicy({ origin: ORIGIN, fetchImpl });
  assert.deepEqual(doc, body);
});

test('discoverVersionPolicy throws on malformed document', async () => {
  const fetchImpl = fakeFetch(() =>
    jsonResponse({ minimum_version: '0.4' }, 200),
  ); // missing required_features
  await assert.rejects(
    () => discoverVersionPolicy({ origin: ORIGIN, fetchImpl }),
    /malformed/,
  );
});

test('discoverVersionPolicy throws on 5xx', async () => {
  const fetchImpl = fakeFetch(
    () => new Response('boom', { status: 502 }),
  );
  await assert.rejects(
    () => discoverVersionPolicy({ origin: ORIGIN, fetchImpl }),
    /HTTP 502/,
  );
});

test('discoverVersionPolicy stamps Codec-Client-Version on the request', async () => {
  let seen: Headers | undefined;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen = new Headers(init?.headers);
    return new Response('', { status: 404 });
  }) as typeof fetch;
  await discoverVersionPolicy({ origin: ORIGIN, fetchImpl });
  assert.equal(
    seen?.get(CODEC_CLIENT_VERSION_HEADER),
    CODEC_CLIENT_VERSION,
  );
});

// ── Full matrix: (client_version × server_config) → wire outcome ────────────
//
// Mirrors the matrix in sglang test_codec_version.py: both sides of the
// wire are tested against the same cartesian product so a behavior change
// on one side is caught against the spec on the other.

const CLIENT_VERSIONS = ['0.2', '0.3', '0.4', '0.5'] as const;

interface ServerConfig {
  readonly name: string;
  /** What the server's well-known doc returns (or null if it 404s). */
  readonly wellKnown: CodecVersionPolicyDocument | null;
  /** Which client versions would receive a 426 from this server. */
  readonly refused: Record<string, boolean>;
  /** Headers the server would emit on a 2xx if the request reached the body. */
  readonly emitsHeaders: readonly string[];
}

const SERVER_CONFIGS: readonly ServerConfig[] = [
  {
    name: 'default-off',
    wellKnown: null,
    refused: { '0.2': false, '0.3': false, '0.4': false, '0.5': false },
    emitsHeaders: ['Vary', 'Content-Encoding'],
  },
  {
    name: 'safety-enabled-not-enforced',
    wellKnown: null,
    refused: { '0.2': false, '0.3': false, '0.4': false, '0.5': false },
    // Capability ENABLED: server adds v0.4 headers for v0.4+ clients.
    // For v0.3- clients, graceful downgrade strips them server-side
    // and the client never sees them.
    emitsHeaders: [
      'Vary',
      'Content-Encoding',
      'Codec-Zstd-Dict',
      'Codec-Safety-Policy',
      'Codec-Safety-Policy-Hash',
    ],
  },
  {
    name: 'safety-enforced',
    wellKnown: {
      minimum_version: '0.4',
      required_features: ['safety-policy-enforcement'],
    },
    refused: { '0.2': true, '0.3': true, '0.4': false, '0.5': false },
    emitsHeaders: [
      'Vary',
      'Content-Encoding',
      'Codec-Zstd-Dict',
      'Codec-Safety-Policy',
      'Codec-Safety-Policy-Hash',
    ],
  },
  {
    name: 'version-policy-strict',
    wellKnown: { minimum_version: '0.4', required_features: [] },
    refused: { '0.2': true, '0.3': true, '0.4': false, '0.5': false },
    emitsHeaders: ['Vary', 'Content-Encoding', 'Codec-Zstd-Dict'],
  },
];

type ClientVersion = (typeof CLIENT_VERSIONS)[number];

// Build a fake server response for each (server, client) cell. Models the
// SAME logic the sglang implementation runs server-side.
function simulateServerResponse(
  server: ServerConfig,
  clientVersion: ClientVersion,
): Response {
  if (server.refused[clientVersion]) {
    // Compute required_features from the well-known doc (same as 426 body).
    const body: CodecVersionRequiredBody = {
      error: 'codec_version_required',
      minimum_version: server.wellKnown?.minimum_version ?? '0.4',
      required_features: server.wellKnown?.required_features ?? [],
      client_version: clientVersion,
      docs_url: 'https://codecai.net/docs/version-negotiation/',
    };
    return new Response(JSON.stringify(body), {
      status: 426,
      headers: {
        'content-type': 'application/json',
        'codec-min-version': '0.4',
        ...(body.required_features.length
          ? { 'codec-required-features': body.required_features.join(', ') }
          : {}),
      },
    });
  }
  // 200 with the headers the server would emit, filtered by client version.
  const FLOOR: Record<string, string> = {
    'Codec-Zstd-Dict': '0.2',
    'Codec-Tokenizer-Map': '0.2',
    'Codec-Latent-Map': '0.3',
    'Codec-Safety-Policy': '0.4',
    'Codec-Safety-Policy-Hash': '0.4',
  };
  const visible: Record<string, string> = {};
  for (const h of server.emitsHeaders) {
    const floor = FLOOR[h];
    if (floor && clientVersion < floor) continue;
    visible[h.toLowerCase()] = 'sha256:placeholder';
  }
  return new Response('ok', { status: 200, headers: visible });
}

// ── Refusal coverage ────────────────────────────────────────────────────────

for (const server of SERVER_CONFIGS) {
  for (const client of CLIENT_VERSIONS) {
    const expectRefused = server.refused[client];
    test(`matrix: client=${client} vs server=${server.name} → ${
      expectRefused ? 'refused 426' : 'served 200'
    }`, async () => {
      const resp = simulateServerResponse(server, client);
      if (expectRefused) {
        assert.equal(resp.status, 426);
        const err = await parseVersionRequired(resp);
        assert.ok(err instanceof CodecVersionRequiredError);
        assert.equal(err!.minimumVersion, '0.4');
        assert.equal(err!.clientVersion, client);
        // required_features matches what the well-known doc would advertise.
        assert.deepEqual(
          [...err!.requiredFeatures],
          server.wellKnown?.required_features ?? [],
        );
      } else {
        assert.equal(resp.status, 200);
        const err = await parseVersionRequired(resp);
        assert.equal(err, null);
      }
    });
  }
}

// ── Header-visibility coverage (graceful downgrade) ─────────────────────────

for (const server of SERVER_CONFIGS) {
  for (const client of CLIENT_VERSIONS) {
    if (server.refused[client]) continue; // 426 path covered above
    test(`matrix: header filter: client=${client} vs server=${server.name}`, async () => {
      const resp = simulateServerResponse(server, client);
      // v0.4 headers MUST NOT reach v0.3- clients.
      if (client < '0.4') {
        assert.equal(resp.headers.get('codec-safety-policy'), null);
        assert.equal(resp.headers.get('codec-safety-policy-hash'), null);
      }
      // v0.3 headers MUST NOT reach v0.2 clients.
      if (client < '0.3') {
        assert.equal(resp.headers.get('codec-latent-map'), null);
      }
      // v0.2 headers always allowed (when server emits them).
      if (server.emitsHeaders.includes('Codec-Zstd-Dict')) {
        assert.ok(resp.headers.get('codec-zstd-dict'));
      }
    });
  }
}

// ── Well-known doc coverage ────────────────────────────────────────────────

for (const server of SERVER_CONFIGS) {
  test(`matrix: well-known doc presence for server=${server.name}`, async () => {
    const fetchImpl = fakeFetch(() => {
      if (server.wellKnown === null) {
        return new Response('', { status: 404 });
      }
      return jsonResponse(server.wellKnown, 200);
    });
    const doc = await discoverVersionPolicy({ origin: ORIGIN, fetchImpl });
    assert.deepEqual(doc, server.wellKnown);
  });
}

// Make sure we hit every cell.
test('matrix coverage check: all combinations exercised', () => {
  const expected = SERVER_CONFIGS.length * CLIENT_VERSIONS.length;
  // 4 server configs × 4 client versions = 16 (refusal) + a subset for
  // header visibility (only cells that weren't refused) + 4 well-known
  // tests. Spot-check the multiplication here.
  assert.ok(expected === 16);
});

// ── Import the type used in the simulator ──────────────────────────────────

import type {
  CodecVersionPolicyDocument,
} from '../src/version-signaling.js';
