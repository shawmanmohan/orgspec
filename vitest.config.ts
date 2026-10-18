import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@orgspec/core/paths': fileURLToPath(new URL('./packages/core/src/paths.ts', import.meta.url)),
      '@orgspec/app/hook': fileURLToPath(new URL('./packages/app/src/hook.ts', import.meta.url)),
      '@orgspec/core/glob': fileURLToPath(new URL('./packages/core/src/glob.ts', import.meta.url)),
      '@orgspec/constitution/hook': fileURLToPath(new URL('./packages/constitution/src/hook.ts', import.meta.url)),
      '@orgspec/spec-engine': pkg('spec-engine'),
      '@orgspec/core': pkg('core'),
      '@orgspec/constitution': pkg('constitution'),
      '@orgspec/claude': pkg('claude'),
      '@orgspec/gateway': pkg('gateway'),
      '@orgspec/integrations': pkg('integrations'),
      '@orgspec/app': pkg('app'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
  },
});
