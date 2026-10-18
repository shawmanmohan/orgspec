import { existsSync, readFileSync, statSync } from 'node:fs';

export const exists = (p: string): boolean => existsSync(p);
export const isDir = (p: string): boolean => existsSync(p) && statSync(p).isDirectory();
export const readText = (p: string): string => readFileSync(p, 'utf8');
