// Builds dist/orgspec: one esbuild bundle injected into a copy of the node binary (Node SEA).
// Usage: node scripts/package.mjs [--bundle-only]
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist');
const require = createRequire(join(root, 'packages/gateway/package.json'));
const cedarJs = require.resolve('@cedar-policy/cedar-wasm/nodejs');
const wasm = join(dirname(cedarJs), 'cedar_wasm_bg.wasm');
const version = process.env.ORGSPEC_VERSION ?? JSON.parse(readFileSync(join(root, 'packages/cli/package.json'), 'utf8')).version;

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

/** Resolves workspace packages to their TypeScript sources and swaps the cedar loader. */
const orgspecPlugin = {
  name: 'orgspec',
  setup(b) {
    b.onResolve({ filter: /^@orgspec\// }, (args) => {
      const [, name, sub] = /^@orgspec\/([^/]+)(?:\/(.+))?$/.exec(args.path);
      return { path: join(root, 'packages', name, 'src', `${sub ?? 'index'}.ts`) };
    });
    b.onResolve({ filter: /cedar-load\.js$/ }, () => ({ path: 'cedar-load', namespace: 'orgspec-virtual' }));
    b.onLoad({ filter: /^cedar-load$/, namespace: 'orgspec-virtual' }, () => ({
      contents: `export const loadCedarModule = () => require(${JSON.stringify(cedarJs)});`,
      resolveDir: root,
      loader: 'js',
    }));
    b.onLoad({ filter: /cedar_wasm\.js$/ }, (args) => ({
      contents: readFileSync(args.path, 'utf8').replace(
        "const wasmBytes = require('fs').readFileSync(wasmPath);",
        `const wasmBytes = (() => {
  try { const sea = require('node:sea'); if (sea.isSea()) return Buffer.from(sea.getAsset('cedar_wasm_bg.wasm')); } catch {}
  return require('fs').readFileSync(require('path').join(__dirname, 'cedar_wasm_bg.wasm'));
})();`,
      ),
      loader: 'js',
    }));
  },
};

const bundle = join(out, 'orgspec.cjs');
await build({
  entryPoints: [join(root, 'packages/cli/src/sea.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: bundle,
  plugins: [orgspecPlugin],
  define: { 'process.env.ORGSPEC_BUILD': JSON.stringify(version) },
  legalComments: 'none',
  logLevel: 'warning',
});
copyFileSync(wasm, join(out, 'cedar_wasm_bg.wasm'));
console.log(`bundle: ${bundle} (${(statSync(bundle).size / 1e6).toFixed(1)} MB)`);
if (process.argv.includes('--bundle-only')) process.exit(0);

const blob = join(out, 'sea-prep.blob');
writeFileSync(
  join(out, 'sea-config.json'),
  JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, useCodeCache: true, assets: { 'cedar_wasm_bg.wasm': wasm } }),
);
execFileSync(process.execPath, ['--experimental-sea-config', join(out, 'sea-config.json')], { stdio: 'inherit' });
const exe = join(out, process.platform === 'win32' ? 'orgspec.exe' : 'orgspec');
copyFileSync(process.execPath, exe);
if (process.platform === 'darwin') execFileSync('codesign', ['--remove-signature', exe]);
const postject = join(root, 'node_modules/.bin/postject');
const args = [exe, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'];
if (process.platform === 'darwin') args.push('--macho-segment-name', 'NODE_SEA');
execFileSync(postject, args, { stdio: 'inherit' });
if (process.platform === 'darwin') execFileSync('codesign', ['--sign', '-', exe]);
console.log(`executable: ${exe} (${(statSync(exe).size / 1e6).toFixed(0)} MB)`);
