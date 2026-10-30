import { describe, it, expect } from 'vitest';

import { collect, planApply } from '../src/plan';

describe('collect()', () => {
  it('drops empty-text layers and builds {key,text} entries', () => {
    const { entries, assignments } = collect([
      { layerId: '1', existingKey: null, pathSegments: ['Home', 'Title'], text: 'Welcome' },
      { layerId: '2', existingKey: null, pathSegments: ['Home', 'Blank'], text: '   ' },
    ]);
    expect(entries).toEqual([{ key: 'home/title', text: 'Welcome' }]);
    expect(assignments).toEqual([{ layerId: '1', key: 'home/title', isNew: true }]);
  });

  it('reuses an existing key and flags it as not new (no re-persist)', () => {
    const { entries, assignments } = collect([
      { layerId: '9', existingKey: 'kept/key', pathSegments: ['ignored'], text: 'Hi' },
    ]);
    expect(entries).toEqual([{ key: 'kept/key', text: 'Hi' }]);
    expect(assignments[0].isNew).toBe(false);
  });
});

describe('planApply()', () => {
  it('writes only layers that have both a key and a translation', () => {
    const { writes, skipped } = planApply(
      [
        { layerId: '1', key: 'home/title' },
        { layerId: '2', key: 'home/cta' }, // no translation this locale
        { layerId: '3', key: null }, // never pushed
      ],
      { 'home/title': 'Bienvenue' },
    );
    expect(writes).toEqual([{ layerId: '1', text: 'Bienvenue' }]);
    expect(skipped).toEqual([
      { key: 'home/cta', reason: 'not-translated' },
      { key: '', reason: 'no-key' },
    ]);
  });

  it('applies an empty-string translation (a real, intentional value)', () => {
    const { writes } = planApply([{ layerId: '1', key: 'k' }], { k: '' });
    expect(writes).toEqual([{ layerId: '1', text: '' }]);
  });
});
