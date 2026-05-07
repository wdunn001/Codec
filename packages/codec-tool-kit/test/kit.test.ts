import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateManifest,
  findBinding,
  precache,
  renderTemplate,
  verifyCache,
  tokensResult,
  textResult,
  errorResult,
  type ToolManifest,
  type Tokenizer,
} from '../src/index.ts';

const VALID: ToolManifest = {
  schema: '1',
  name: 'get_current_time',
  version: '0.1.0',
  description: 'Return the current time in UTC.',
  argumentsSchema: { type: 'object', properties: {} },
  models: [
    {
      modelId: 'Qwen/Qwen2.5-0.5B-Instruct',
      tokenizerHash:
        'a'.repeat(64),
      cacheFile: 'cache/qwen25-0.5b.json',
    },
  ],
};

// A toy tokenizer for tests — splits on space, hashes characters into IDs.
const toy: Tokenizer = {
  encode(text: string): number[] {
    return text.split('').map((c) => c.charCodeAt(0) % 50_000);
  },
  hash(): string {
    return 'b'.repeat(64);
  },
};

describe('validateManifest', () => {
  it('accepts a valid manifest', () => {
    assert.equal(validateManifest(VALID), null);
  });

  it('rejects unknown schema version', () => {
    const bad = { ...VALID, schema: '99' } as unknown;
    assert.match(validateManifest(bad) ?? '', /schema/);
  });

  it('rejects empty name', () => {
    const bad = { ...VALID, name: '' };
    assert.match(validateManifest(bad) ?? '', /name/);
  });

  it('rejects empty models array', () => {
    const bad = { ...VALID, models: [] };
    assert.match(validateManifest(bad) ?? '', /models/);
  });

  it('rejects invalid tokenizer hash', () => {
    const bad = {
      ...VALID,
      models: [{ ...VALID.models[0]!, tokenizerHash: 'not-a-hash' }],
    };
    assert.match(validateManifest(bad) ?? '', /SHA-256/);
  });
});

describe('findBinding', () => {
  it('finds a present binding', () => {
    assert.equal(findBinding(VALID, 'Qwen/Qwen2.5-0.5B-Instruct')?.modelId,
                 'Qwen/Qwen2.5-0.5B-Instruct');
  });

  it('returns null for missing model', () => {
    assert.equal(findBinding(VALID, 'meta-llama/Llama-3-70B'), null);
  });
});

describe('precache — static fragments', () => {
  it('encodes static text once', () => {
    const cache = precache({
      fragments: [
        { id: 'prefix', kind: 'static', text: 'It is currently ' },
        { id: 'suffix', kind: 'static', text: ' UTC.' },
      ],
      tokenizer: toy,
    });
    const prefix = cache.fragments['prefix']!;
    assert.equal(prefix.kind, 'static');
    assert.ok((prefix as { ids: number[] }).ids.length > 0);
    assert.equal(cache.tokenizerHash, 'b'.repeat(64));
  });
});

describe('precache — template fragments', () => {
  it('splits a template on slot markers', () => {
    const cache = precache({
      fragments: [
        { id: 'weather', kind: 'template', text: '{city}: {temp}°F' },
      ],
      tokenizer: toy,
    });
    const tpl = cache.fragments['weather']!;
    assert.equal(tpl.kind, 'template');
    const parts = (tpl as { parts: ({ ids: number[] } | { slot: string })[] }).parts;
    // Expected order: {city} : ' ' : {temp} : '°F'   — actually
    //                {city} ': ' {temp} '°F' since the parser eats the
    //                literal between markers.
    assert.deepEqual(
      parts.map((p) => ('slot' in p ? `<${p.slot}>` : '<lit>')),
      ['<city>', '<lit>', '<temp>', '<lit>'],
    );
  });

  it('renders a template by filling slots', () => {
    const cache = precache({
      fragments: [{ id: 'weather', kind: 'template', text: '{city}: {temp}°F' }],
      tokenizer: toy,
    });
    const tpl = cache.fragments['weather']! as {
      kind: 'template';
      parts: ({ ids: number[] } | { slot: string })[];
    };
    const ids = renderTemplate(tpl, { city: 'SF', temp: '72' }, toy);
    // Should contain the literal IDs plus tokenized slot values.
    assert.ok(ids.length > 0);
    // Slot values must be present in the output.
    const expectedSF = toy.encode('SF');
    assert.ok(
      expectedSF.every((id) => ids.includes(id)),
      'rendered template must include tokenized slot values',
    );
  });

  it('throws on missing slot', () => {
    const cache = precache({
      fragments: [{ id: 'weather', kind: 'template', text: '{city}: {temp}°F' }],
      tokenizer: toy,
    });
    const tpl = cache.fragments['weather']! as {
      kind: 'template';
      parts: ({ ids: number[] } | { slot: string })[];
    };
    assert.throws(
      () => renderTemplate(tpl, { city: 'SF' }, toy),
      /missing slot "temp"/,
    );
  });
});

describe('verifyCache', () => {
  it('matches identical hashes case-insensitive', () => {
    assert.equal(verifyCache(
      { tokenizerHash: 'A'.repeat(64), fragments: {} },
      'a'.repeat(64),
    ), true);
  });

  it('rejects different hashes', () => {
    assert.equal(verifyCache(
      { tokenizerHash: 'a'.repeat(64), fragments: {} },
      'b'.repeat(64),
    ), false);
  });
});

describe('result helpers', () => {
  it('tokensResult shape', () => {
    const r = tokensResult(7, [1, 2, 3]);
    assert.deepEqual(r, { callId: 7, kind: 'tokens', responseIds: [1, 2, 3] });
  });

  it('textResult shape', () => {
    const r = textResult('abc', 'hello');
    assert.deepEqual(r, { callId: 'abc', kind: 'text', text: 'hello' });
  });

  it('errorResult shape', () => {
    const r = errorResult(1, 'boom', 'E_BOOM');
    assert.deepEqual(r, { callId: 1, kind: 'error', message: 'boom', code: 'E_BOOM' });
  });
});
