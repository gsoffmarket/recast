import { describe, expect, it } from 'vitest';
import { canonicalJson, contentHash, redact } from '@recast/shared';

describe('canonicalJson', () => {
  it('sorts keys at every depth and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1], c: 'x' } })).toBe('{"a":{"c":"x","d":[3,1]},"b":1}');
  });
  it('gives the same hash regardless of key order', () => {
    expect(contentHash({ x: 1, y: [true, null] })).toBe(contentHash({ y: [true, null], x: 1 }));
  });
  it('rejects values with no stable JSON form', () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(/non-finite/);
    expect(() => canonicalJson({ d: new Date() })).toThrow(/unsupported object/);
  });
  it('drops undefined fields', () => {
    expect(canonicalJson({ a: undefined, b: 2 })).toBe('{"b":2}');
  });
});

describe('redact', () => {
  it('removes share tokens, UI tokens and home paths', () => {
    const t = redact('https://x/share/US_ABCDEFGHIJKLMNOPQRST?x /Users/alice/a Trino-UI-Token=abc.def');
    expect(t).not.toMatch(/US_ABCDEF|alice|abc\.def/);
  });
});
