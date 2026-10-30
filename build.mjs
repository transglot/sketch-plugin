import { copyFile, readFile, writeFile, mkdir } from 'node:fs/promises';

import { build } from 'esbuild';

// A Sketch plugin ships as a `.sketchplugin` BUNDLE: a folder whose
// Contents/Sketch/ holds the compiled command script + manifest.json, and
// Contents/Resources/ holds assets. We assemble that layout under dist/ so the
// output can be double-clicked (or symlinked into ~/Library/.../Plugins) as-is.
const BUNDLE = 'dist/transglot.sketchplugin';
const SKETCH_DIR = `${BUNDLE}/Contents/Sketch`;
const RESOURCES_DIR = `${BUNDLE}/Contents/Resources`;

await mkdir(SKETCH_DIR, { recursive: true });
await mkdir(RESOURCES_DIR, { recursive: true });

// Vanilla Sketch looks up global handler names. esbuild's CommonJS exports alone do
// not register those names (skpm normally supplies that bridge, but we do not use it).
await build({
  entryPoints: ['src/commands.ts'],
  outfile: `${SKETCH_DIR}/transglot.js`,
  bundle: true,
  format: 'iife',
  globalName: 'TransglotPlugin',
  target: 'es2019',
  platform: 'neutral',
  // The `sketch` / `sketch/*` modules are injected by the Sketch runtime at load
  // time — keep the `require(...)` calls in the bundle for Sketch to resolve.
  external: ['sketch', 'sketch/*'],
  footer: {
    js: ['onSetToken', 'onPush', 'onTranslate', 'onPullApply']
      .map(
        (handler) =>
          `function ${handler}(context) { return TransglotPlugin.${handler}(context); }`,
      )
      .join('\n'),
  },
});

// The manifest travels beside the script inside Contents/Sketch/.
const manifest = await readFile('manifest.json', 'utf8');
await writeFile(`${SKETCH_DIR}/manifest.json`, manifest);

// The plugin mark, at the path manifest.json's `icon` already names. Without this
// Contents/Resources/ shipped empty and Sketch drew the generic plugin placeholder
// in the menu and in Preferences → Plugins.
await copyFile('assets/icon.png', `${RESOURCES_DIR}/icon.png`);
await copyFile('LICENSE', `${RESOURCES_DIR}/LICENSE`);

// eslint-disable-next-line no-console
console.log(`Built ${BUNDLE}`);
