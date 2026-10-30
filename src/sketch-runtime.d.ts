/**
 * Minimal ambient typings for the Sketch JS API surface this plugin touches. The full
 * `@types` are not published for Sketch, so we declare only what commands.ts uses — enough
 * for `tsc` to type the host adapter without pulling the whole runtime. The load-bearing
 * logic lives in the PURE modules (api/keys/plan), which never import these.
 *
 * See https://developer.sketch.com/reference/api/ for the real shapes.
 */

declare module 'sketch/dom' {
  export interface Layer {
    readonly id: string;
    readonly type: string; // 'Text' | 'Group' | 'Artboard' | 'Page' | ...
    name: string;
    text?: string; // Text layers only
    readonly parent?: Layer | Document;
    readonly layers?: Layer[]; // Group / Artboard / Page containers
  }

  export interface Selection {
    readonly layers: Layer[];
    readonly length: number;
  }

  export interface Document {
    readonly selectedLayers: Selection;
    readonly pages: Layer[];
  }

  export function getSelectedDocument(): Document | undefined;
}

declare module 'sketch/settings' {
  import type { Layer } from 'sketch/dom';

  export function settingForKey<T = unknown>(key: string): T | undefined;
  export function setSettingForKey(key: string, value: unknown): void;
  export function layerSettingForKey<T = unknown>(layer: Layer, key: string): T | undefined;
  export function setLayerSettingForKey(layer: Layer, key: string, value: unknown): void;
}

declare module 'sketch/ui' {
  export const INPUT_TYPE: { string: 'string'; selection: 'selection' };
  export function message(text: string): void;
  export function alert(title: string, text: string): void;
  export function getInputFromUser(
    message: string,
    options: { initialValue?: string; type?: string; possibleValues?: string[] },
    callback: (err: unknown, value: string) => void,
  ): void;
}
