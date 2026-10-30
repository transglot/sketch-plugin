/**
 * The Sketch HOST adapter — the thin command layer the manifest's `handlers.run` names.
 * It is the ONLY file that imports the Sketch runtime (`sketch/dom`, `sketch/settings`,
 * `sketch/ui`) and supplies native HTTP transport. It reads/writes real Text layers and delegates every
 * decision to the PURE modules (api/keys/plan). It cannot run headless, so it carries no
 * unit tests — the compiler + the README manual checklist are its safety net.
 *
 * The IIFE bundle exposes global handlers matching the manifest's `handlers.run` names.
 */
import { getSelectedDocument, type Document, type Layer } from 'sketch/dom';
import * as Settings from 'sketch/settings';
import * as UI from 'sketch/ui';

import {
  createClient,
  ApiError,
  isTerminal,
  type ApiClient,
  type Batch,
} from './api';
import { collect, planApply, type LayerSnapshot } from './plan';
import { nativeFetch, nativeSleep } from './native-runtime';

const PLUGIN_VERSION = '0.1.1';
/**
 * MACHINE surface — the hosted API host, where every REST call goes. The human-facing
 * host is a DIFFERENT origin (https://app.transglot.ai): the API host serves only
 * `/v1/…` and 404s every browser page. This plugin opens no browser links, so the app
 * host is documented here rather than declared as an unused constant.
 */
const DEFAULT_URL = 'https://api.transglot.ai';
const KEY_TOKEN = 'tgl_token';
const KEY_URL = 'tgl_url';
const LAYER_KEY = 'taiKey';

/** Ask the user for a single string (Sketch's native modal), promisified. */
function prompt(message: string, initialValue = ''): Promise<string | null> {
  return new Promise((resolve) => {
    UI.getInputFromUser(message, { initialValue }, (err, value) => {
      resolve(err ? null : value);
    });
  });
}

function connect(): ApiClient | null {
  const token = Settings.settingForKey<string>(KEY_TOKEN);
  const url = Settings.settingForKey<string>(KEY_URL) ?? DEFAULT_URL;

  if (!token) {
    UI.message('transglot: run “Set token…” first.');

    return null;
  }

  return createClient({
    url,
    token,
    version: PLUGIN_VERSION,
    fetchImpl: nativeFetch,
    sleep: nativeSleep,
  });
}

/** Depth-first walk to every non-empty Text layer under a selection layer (or itself). */
function textLayersIn(layer: Layer): Layer[] {
  if (layer.type === 'Text') {
    return [layer];
  }

  if (Array.isArray(layer.layers)) {
    return layer.layers.flatMap(textLayersIn);
  }

  return [];
}

/** page / artboard / …groups / name — top-down, for a human-readable derived key. */
function layerPath(layer: Layer): string[] {
  const names: string[] = [];
  let cursor: Layer | Document | undefined = layer;

  while (cursor && 'type' in cursor && cursor.type !== 'Document') {
    names.push((cursor as Layer).name);
    cursor = (cursor as Layer).parent;
  }

  return names.reverse();
}

/** All selected text layers as pure snapshots the planners can reason about. */
function selectedTextLayers(
  document: Document,
): { layer: Layer; snapshot: LayerSnapshot }[] {
  return document.selectedLayers.layers.flatMap(textLayersIn).map((layer) => ({
    layer,
    snapshot: {
      layerId: layer.id,
      existingKey:
        Settings.layerSettingForKey<string>(layer, LAYER_KEY) ?? null,
      pathSegments: layerPath(layer),
      text: layer.text ?? '',
    },
  }));
}

function reportError(error: unknown): void {
  if (error instanceof ApiError) {
    UI.alert(
      'transglot',
      error.hint ? `${error.message}\n\n${error.hint}` : error.message,
    );

    return;
  }

  UI.alert('transglot', error instanceof Error ? error.message : String(error));
}

// ---------------------------------------------------------------------------------------
// Commands (each is a manifest `handlers.run` target).
// ---------------------------------------------------------------------------------------

/** Store the server URL + project token, then verify against GET /v1/project. */
export function onSetToken(): void {
  void (async () => {
    const url =
      (await prompt(
        'transglot server URL',
        Settings.settingForKey<string>(KEY_URL) ?? DEFAULT_URL,
      )) ?? '';

    if (!url) {
      return;
    }

    const token = await prompt('Project access token (starts with tgl_)');

    if (!token) {
      return;
    }

    try {
      const client = createClient({
        url,
        token,
        version: PLUGIN_VERSION,
        fetchImpl: nativeFetch,
        sleep: nativeSleep,
      });
      const project = await client.project(); // verify BEFORE persisting
      Settings.setSettingForKey(KEY_URL, url);
      Settings.setSettingForKey(KEY_TOKEN, token);
      UI.message(
        `transglot: connected to “${project.name}” (${project.locales.length} locales).`,
      );
    } catch (error) {
      reportError(error);
    }
  })();
}

/** Collect the selected Text layers, persist their keys, and push as source strings. */
export function onPush(): void {
  const client = connect();

  if (!client) {
    return;
  }

  void (async () => {
    const document = getSelectedDocument();

    if (!document) {
      UI.message('transglot: open a document first.');

      return;
    }

    const layers = selectedTextLayers(document);

    if (layers.length === 0) {
      UI.message('transglot: select at least one text layer to push.');

      return;
    }

    const { entries, assignments } = collect(layers.map((l) => l.snapshot));
    // Persist newly-derived keys so re-runs resolve the same key (idempotency).
    const layerById = new Map(layers.map((l) => [l.snapshot.layerId, l.layer]));

    for (const a of assignments) {
      if (a.isNew) {
        const layer = layerById.get(a.layerId);

        if (layer) {
          Settings.setLayerSettingForKey(layer, LAYER_KEY, a.key);
        }
      }
    }

    try {
      const project = await client.project();
      const diff = await client.push({
        entries,
        sourceLocale: project.source_locale,
      });
      UI.message(
        `transglot: pushed ${entries.length} (${diff.keys_created} new, ${diff.source_updated} updated).`,
      );
    } catch (error) {
      reportError(error);
    }
  })();
}

/** Trigger an AI translation batch for missing locales and poll it to completion. */
export function onTranslate(): void {
  const client = connect();

  if (!client) {
    return;
  }

  void (async () => {
    try {
      let batch = await client.translate('missing');
      UI.message(`transglot: translating (batch #${batch.id})…`);

      // Poll until terminal (bounded; the server also caps batch runtime).
      for (let i = 0; i < 60 && !isTerminal(batch.status); i++) {
        await nativeSleep(2000);
        batch = await client.batch(batch.id);
      }

      summarizeBatch(batch);
    } catch (error) {
      reportError(error);
    }
  })();
}

function summarizeBatch(batch: Batch): void {
  UI.message(
    `transglot: batch #${batch.id} ${batch.status} (${batch.completed}/${batch.total} done, ${batch.failed} failed).`,
  );
}

/** Pull one locale and write each translation back onto its keyed Text layer. */
export function onPullApply(): void {
  const client = connect();

  if (!client) {
    return;
  }

  void (async () => {
    const document = getSelectedDocument();

    if (!document) {
      UI.message('transglot: open a document first.');

      return;
    }

    const locale = await prompt('Locale to pull (e.g. fr, de, ja)');

    if (!locale) {
      return;
    }

    const layers = selectedTextLayers(document);

    if (layers.length === 0) {
      UI.message('transglot: select the text layers to translate first.');

      return;
    }

    try {
      const { entries } = await client.pull({ locale });
      const { writes, skipped } = planApply(
        layers.map((l) => ({
          layerId: l.snapshot.layerId,
          key: l.snapshot.existingKey,
        })),
        entries,
      );
      const layerById = new Map(
        layers.map((l) => [l.snapshot.layerId, l.layer]),
      );

      for (const w of writes) {
        const layer = layerById.get(w.layerId);

        if (layer) {
          layer.text = w.text;
        }
      }

      const notTranslated = skipped.filter(
        (s) => s.reason === 'not-translated',
      ).length;
      const noKey = skipped.filter((s) => s.reason === 'no-key').length;
      UI.message(
        `transglot: applied ${writes.length} “${locale}” (${notTranslated} untranslated, ${noKey} not pushed yet).`,
      );
    } catch (error) {
      reportError(error);
    }
  })();
}
