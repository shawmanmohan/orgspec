import { createRequire } from 'node:module';

/**
 * Loads cedar-wasm (CommonJS) on first use. The single-executable build replaces this module with a
 * plain `require` so the bundler can include cedar and its wasm.
 */
export const loadCedarModule = (): unknown => createRequire(import.meta.url)('@cedar-policy/cedar-wasm/nodejs');
