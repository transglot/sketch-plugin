/** Key derivation for Sketch text layers. PURE: no Sketch runtime, fully unit-tested. */

const MAX_KEY_LEN = 200;

/** Sanitize ONE path segment to [a-z0-9_.-]; spaces -> '-', everything else dropped. */
export function sanitizeSegment(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_.-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Build a human-readable candidate key from a layer's path (page/artboard/.../name). */
export function deriveKey(pathSegments: string[]): string {
  const joined = pathSegments
    .map(sanitizeSegment)
    .filter((s) => s.length > 0)
    .join('/');

  return joined.slice(0, MAX_KEY_LEN) || 'untitled';
}

/** Short deterministic suffix from a layer id (Sketch ids are UUID strings). */
export function suffixFromLayerId(layerId: string): string {
  let h = 0;

  for (let i = 0; i < layerId.length; i++) {
    h = (h * 31 + layerId.charCodeAt(i)) >>> 0;
  }

  return h.toString(36).padStart(4, '0').slice(0, 4);
}

export interface KeyInput {
  layerId: string;
  existingKey: string | null; // Settings.layerSettingForKey(layer, 'taiKey') || null
  pathSegments: string[];
}

export interface KeyResult {
  layerId: string;
  key: string;
  isNew: boolean; // true when derived this run (must be persisted back to layer settings)
}

/**
 * Resolve final keys for a batch of layers. Precedence: an existing taiKey wins verbatim
 * (idempotency anchor). Otherwise derive from the path; within the batch, resolve
 * collisions by appending a deterministic layerId suffix. New keys are flagged so the
 * caller persists them to the layer's settings.
 */
export function resolveKeys(inputs: KeyInput[]): KeyResult[] {
  const taken = new Set<string>();
  const seenExisting = new Set<string>();

  // First occurrence of each existing key claims its slot, so new derivations never
  // collide onto an existing key that appears later in the batch.
  for (const i of inputs) {
    if (i.existingKey) {
      taken.add(i.existingKey);
    }
  }

  return inputs.map((i) => {
    // An existing taiKey wins verbatim the FIRST time it is seen. Design tools copy plugin
    // data when a layer is duplicated, so two layers can carry the same persisted key; the
    // copy is re-derived to a fresh, persisted key instead of last-wins collapsing onto one.
    if (i.existingKey && !seenExisting.has(i.existingKey)) {
      seenExisting.add(i.existingKey);

      return { layerId: i.layerId, key: i.existingKey, isNew: false };
    }

    let candidate = deriveKey(i.pathSegments);

    if (taken.has(candidate)) {
      candidate = `${candidate}-${suffixFromLayerId(i.layerId)}`;
    }

    taken.add(candidate);

    return { layerId: i.layerId, key: candidate, isNew: true };
  });
}
