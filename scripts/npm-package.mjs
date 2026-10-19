// Assembles dist/npm: the publishable npm package (one bundled CLI, the Cedar wasm, the demo workplace and examples).
// Usage: node scripts/npm-package.mjs [--version 1.2.3]   (default: packages/cli/package.json version)
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist/npm');
const NAME = '@shawmanmohan/orgspec';

const flag = process.argv.indexOf('--version');
const raw = flag > 0 ? process.argv[flag + 1] : JSON.parse(readFileSync(join(root, 'packages/cli/package.json'), 'utf8')).version;
const version = raw.replace(/^v/, '');
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`not a semver version: ${raw}`);

// 1. The CLI bundle and the Cedar wasm it loads from its own folder.
execFileSync(process.execPath, [join(root, 'scripts/package.mjs'), '--bundle-only'], {
  stdio: 'inherit',
  env: { ...process.env, ORGSPEC_VERSION: version },
});
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'bin'), { recursive: true });
const cli = join(out, 'bin/orgspec.cjs');
writeFileSync(cli, `#!/usr/bin/env node\n${readFileSync(join(root, 'dist/orgspec.cjs'), 'utf8')}`);
chmodSync(cli, 0o755);
copyFileSync(join(root, 'dist/cedar_wasm_bg.wasm'), join(out, 'bin/cedar_wasm_bg.wasm'));

// 2. The demo workplace, with the MCP SDK bundled in so it runs from the installed package.
const demo = join(root, 'scripts/demo-workplace.mjs');
await build({
  stdin: {
    contents: readFileSync(demo, 'utf8').replace(/^const require = createRequire\(.*\);$/m, ''),
    resolveDir: join(root, 'packages/gateway'),
    sourcefile: 'demo-workplace.mjs',
    loader: 'js',
  },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: join(out, 'demo/demo-workplace.mjs'),
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module';\nconst require = __cr(import.meta.url);" },
  legalComments: 'none',
  logLevel: 'warning',
});
chmodSync(join(out, 'demo/demo-workplace.mjs'), 0o755);

// 3. Example configuration and CI steps.
cpSync(join(root, 'examples'), join(out, 'examples'), { recursive: true });

// 4. Manifest and docs.
const pkg = {
  name: NAME,
  version,
  description: 'Spec-driven development that follows your organisation’s constitution, run locally through the Claude CLI.',
  type: 'commonjs',
  bin: { orgspec: 'bin/orgspec.cjs', 'orgspec-demo-workplace': 'demo/demo-workplace.mjs' },
  files: ['bin', 'demo', 'examples', 'README.md'],
  engines: { node: '>=22.13' },
  os: ['darwin', 'linux'],
  repository: { type: 'git', url: 'git+https://github.com/shawmanmohan/orgspec.git' },
  publishConfig: { access: 'restricted' },
  license: 'UNLICENSED',
};
writeFileSync(join(out, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
copyFileSync(join(root, 'README.md'), join(out, 'README.md'));
console.log(`npm package: ${out} (${NAME}@${version})`);
