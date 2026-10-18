import { createHash } from 'node:crypto';
import { type Db, nowIso } from './store.js';

const GENESIS = 'sha256:genesis';

const hashOf = (prev: string, at: string, record: string): string =>
  `sha256:${createHash('sha256').update(`${prev}\n${at}\n${record}`).digest('hex')}`;

/** Appends to the local hash-chained audit log. Each tool's own audit log stays authoritative. */
export function appendAudit(db: Db, record: Record<string, unknown>): string {
  const last = db.prepare('select hash from audit order by seq desc limit 1').get() as { hash: string } | undefined;
  const prev = last?.hash ?? GENESIS;
  const at = nowIso();
  const body = JSON.stringify(record);
  const hash = hashOf(prev, at, body);
  db.prepare('insert into audit (at, record, prev, hash) values (?, ?, ?, ?)').run(at, body, prev, hash);
  return hash;
}

/** Returns the first sequence number whose chain no longer verifies, or undefined when intact. */
export function verifyAudit(db: Db): number | undefined {
  const rows = db.prepare('select seq, at, record, prev, hash from audit order by seq').all() as {
    seq: number;
    at: string;
    record: string;
    prev: string;
    hash: string;
  }[];
  // After pruning, the oldest kept row's stored `prev` is the trust anchor.
  let prev = rows[0]?.prev ?? GENESIS;
  for (const r of rows) {
    if (r.prev !== prev || r.hash !== hashOf(r.prev, r.at, r.record)) return r.seq;
    prev = r.hash;
  }
  return undefined;
}

export function pruneAudit(db: Db, olderThanDays: number): void {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
  db.prepare('delete from audit where at < ?').run(cutoff);
}
