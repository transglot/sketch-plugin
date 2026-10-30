/**
 * The design-tool-agnostic collect + apply planners. PURE: they operate on plain records
 * (never a Sketch `Text` layer handle), so vitest exercises every branch with no runtime.
 * The Sketch host adapter (commands.ts) reads/writes real layers around these.
 *
 *  - collect(): selected text layers -> {entries to push, keys to persist}.
 *  - planApply(): pulled {key: translation} + the keyed layers -> per-layer text writes,
 *    with every non-applied key surfaced honestly (never silently dropped).
 */
import { resolveKeys } from './keys';

/** A plain snapshot of one selected text layer (no Sketch handle). */
export interface LayerSnapshot {
  layerId: string;
  existingKey: string | null;
  pathSegments: string[];
  text: string;
}

export interface CollectResult {
  /** {key,text} pairs to push as source strings (empty-text layers dropped). */
  entries: { key: string; text: string }[];
  /** Keys to persist back onto layers (only the newly-derived ones need writing). */
  assignments: { layerId: string; key: string; isNew: boolean }[];
}

/**
 * Resolve stable keys for the selected layers and build the push payload. Layers whose
 * trimmed text is empty are dropped (never pushed as a blank source string), matching the
 * Figma plugin's collect step.
 */
export function collect(layers: LayerSnapshot[]): CollectResult {
  const nonEmpty = layers.filter((l) => l.text.trim().length > 0);
  const keyed = resolveKeys(
    nonEmpty.map((l) => ({ layerId: l.layerId, existingKey: l.existingKey, pathSegments: l.pathSegments })),
  );
  const textById = new Map(nonEmpty.map((l) => [l.layerId, l.text]));

  return {
    entries: keyed.map((k) => ({ key: k.key, text: textById.get(k.layerId) ?? '' })),
    assignments: keyed.map((k) => ({ layerId: k.layerId, key: k.key, isNew: k.isNew })),
  };
}

/** Reasons a key was not applied — surfaced honestly in the UI (never silently dropped). */
export type SkipReason =
  | 'not-translated' // no translation pulled for this key/locale yet
  | 'no-key'; // the layer was never collected/pushed, so it has no stable key

/** A keyed layer that apply may write into (its stable taiKey). */
export interface ApplyTarget {
  layerId: string;
  key: string | null; // null = never collected/pushed
}

export interface ApplyResult {
  /** The text writes to perform, one per layer that has a matching translation. */
  writes: { layerId: string; text: string }[];
  /** Keys/layers that could not be applied, with the honest reason. */
  skipped: { key: string; reason: SkipReason }[];
}

/**
 * Map a pulled {key: translation} bag onto the keyed layers. A layer with no stored key is
 * skipped ('no-key'); a keyed layer with no translation for this locale is skipped
 * ('not-translated'). Only layers with both a key and a translation produce a write.
 */
export function planApply(targets: ApplyTarget[], translations: Record<string, string>): ApplyResult {
  const writes: { layerId: string; text: string }[] = [];
  const skipped: { key: string; reason: SkipReason }[] = [];

  for (const t of targets) {
    if (!t.key) {
      skipped.push({ key: '', reason: 'no-key' });
      continue;
    }

    const translated = translations[t.key];

    if (typeof translated !== 'string') {
      skipped.push({ key: t.key, reason: 'not-translated' });
      continue;
    }

    writes.push({ layerId: t.layerId, text: translated });
  }

  return { writes, skipped };
}
