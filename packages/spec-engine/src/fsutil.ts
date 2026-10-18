import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

export const exists = (p: string): boolean => existsSync(p);

export const isDir = (p: string): boolean => existsSync(p) && statSync(p).isDirectory();

export const readText = (p: string): string => readFileSync(p, 'utf8');

export function writeText(p: string, text: string): void {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text, 'utf8');
}

/** All files under `dir` (recursive), as paths relative to `dir` with forward slashes, sorted. */
export function walkFiles(dir: string, options: { ignoreDirs?: readonly string[] } = {}): string[] {
  const ignore = new Set(options.ignoreDirs ?? []);
  const out: string[] = [];
  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!ignore.has(entry.name)) visit(full);
      } else if (entry.isFile()) {
        out.push(relative(dir, full).split(sep).join('/'));
      }
    }
  };
  if (isDir(dir)) visit(dir);
  return out.sort();
}

export const toPosix = (p: string): string => p.split(sep).join('/');
