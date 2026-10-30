import { describe, it, expect } from 'vitest';

import { sanitizeSegment, deriveKey, resolveKeys } from '../src/keys';

describe('sanitizeSegment', () => {
  it('lowercases, turns spaces into hyphens, and drops junk', () => {
    expect(sanitizeSegment('  Hero Title! ')).toBe('hero-title');
    expect(sanitizeSegment('CTA — Buy Now')).toBe('cta-buy-now');
    expect(sanitizeSegment('a__b.c-d')).toBe('a__b.c-d');
  });

  it('collapses repeated hyphens and trims leading/trailing ones', () => {
    expect(sanitizeSegment('--a  b--')).toBe('a-b');
  });
});

describe('deriveKey', () => {
  it('joins non-empty path segments with slashes', () => {
    expect(deriveKey(['Home', 'Hero', 'Title'])).toBe('home/hero/title');
  });

  it('falls back to "untitled" when nothing survives', () => {
    expect(deriveKey(['', '   ', '!!!'])).toBe('untitled');
  });
});

describe('resolveKeys', () => {
  it('keeps an existing key verbatim (idempotency anchor)', () => {
    const out = resolveKeys([{ layerId: '1', existingKey: 'kept/key', pathSegments: ['Page', 'X'] }]);
    expect(out[0]).toEqual({ layerId: '1', key: 'kept/key', isNew: false });
  });

  it('derives new keys and disambiguates collisions with a deterministic suffix', () => {
    const out = resolveKeys([
      { layerId: 'aaaa', existingKey: null, pathSegments: ['Home', 'Label'] },
      { layerId: 'bbbb', existingKey: null, pathSegments: ['Home', 'Label'] },
    ]);
    expect(out[0].key).toBe('home/label');
    expect(out[0].isNew).toBe(true);
    expect(out[1].key).not.toBe('home/label'); // collision -> suffixed
    expect(out[1].key.startsWith('home/label-')).toBe(true);
    // Deterministic: same layerId => same suffix.
    expect(resolveKeys([{ layerId: 'bbbb', existingKey: null, pathSegments: ['Home', 'Label'] }])[0].key).toBe(
      'home/label',
    );
  });

  it('never lets a new derivation collide onto an existing key', () => {
    const out = resolveKeys([
      { layerId: '1', existingKey: 'home/label', pathSegments: ['ignored'] },
      { layerId: '2', existingKey: null, pathSegments: ['Home', 'Label'] },
    ]);
    expect(out[1].key.startsWith('home/label-')).toBe(true);
  });

  it('re-keys a duplicated layer that carries the same persisted key (5.4)', () => {
    const out = resolveKeys([
      { layerId: 'aaaa', existingKey: 'hero/title', pathSegments: ['Home', 'Hero', 'Title'] },
      { layerId: 'bbbb', existingKey: 'hero/title', pathSegments: ['Home', 'Hero', 'Title'] },
    ]);
    // First occurrence keeps the key verbatim (idempotency anchor).
    expect(out[0]).toEqual({ layerId: 'aaaa', key: 'hero/title', isNew: false });
    // The duplicate is minted a fresh, distinct key that must be persisted back.
    expect(out[1].key).not.toBe('hero/title');
    expect(out[1].isNew).toBe(true);
    expect(out[0].key).not.toBe(out[1].key); // two layers -> two keys, never last-wins
  });
});
