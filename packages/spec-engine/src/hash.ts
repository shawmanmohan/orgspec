import { createHash } from 'node:crypto';

/** Normalises line endings and trailing whitespace so cosmetic edits don't change a hash. */
export function normalizeBlock(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

export function hashText(text: string): string {
  return `sha256:${createHash('sha256').update(normalizeBlock(text)).digest('hex')}`;
}
