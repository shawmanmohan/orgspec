import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { type Db, exists, readText, writeFileAtomic } from '@orgspec/core';
import { slugify, type Workspace } from '@orgspec/spec-engine';
import { parse as parseYaml } from 'yaml';

export interface DecisionRecord {
  adrId: string;
  repo: string;
  title: string;
  status: string;
  scopePaths: string[];
  scopeCapabilities: string[];
  body: string;
  file: string;
}

const FRONT = /^---\n([\s\S]*?)\n---\n?/;

export function parseDecision(text: string, file: string, repo: string): DecisionRecord | undefined {
  const m = FRONT.exec(text);
  const meta = (m ? (parseYaml(m[1] as string) as Record<string, unknown>) : {}) ?? {};
  const body = m ? text.slice(m[0].length) : text;
  const title = String(meta.title ?? /^#\s+(.+)$/m.exec(body)?.[1] ?? '').trim();
  const adrId = String(meta.id ?? /^(ADR-\d+)/i.exec(file.split('/').pop() ?? '')?.[1] ?? '').toUpperCase();
  if (!adrId || !title) return undefined;
  const scope = (meta.scope ?? {}) as { paths?: string[]; capabilities?: string[] };
  return {
    adrId,
    repo,
    title,
    status: String(meta.status ?? 'proposed'),
    scopePaths: scope.paths ?? [],
    scopeCapabilities: scope.capabilities ?? [],
    body: body.trim(),
    file,
  };
}

export function listDecisions(ws: Workspace, repo: string): DecisionRecord[] {
  if (!exists(ws.decisionsDir)) return [];
  return readdirSync(ws.decisionsDir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .flatMap((f) => {
      const file = join(ws.decisionsDir, f);
      const d = parseDecision(readText(file), relative(ws.repoRoot, file).split(sep).join('/'), repo);
      return d ? [d] : [];
    });
}

/** `orgspec decision new`: the next ADR number in this repo, with the standard sections. */
export function newDecision(
  ws: Workspace,
  o: { title: string; deciders?: string[]; paths?: string[]; capabilities?: string[]; change?: string },
): string {
  const nums = exists(ws.decisionsDir)
    ? readdirSync(ws.decisionsDir).flatMap((f) => {
        const n = /^ADR-(\d+)/i.exec(f)?.[1];
        return n ? [Number(n)] : [];
      })
    : [];
  const n = Math.max(0, ...nums) + 1;
  const id = `ADR-${String(n).padStart(4, '0')}`;
  const file = join(ws.decisionsDir, `${id}-${slugify(o.title)}.md`);
  const today = new Date().toISOString().slice(0, 10);
  writeFileAtomic(
    file,
    `---
id: ${id}
title: ${JSON.stringify(o.title)}
status: proposed
date: ${today}
deciders: [${(o.deciders ?? []).join(', ')}]
${o.change ? `change: ${o.change}\n` : ''}scope:
  paths: [${(o.paths ?? []).map((p) => JSON.stringify(p)).join(', ')}]
  capabilities: [${(o.capabilities ?? []).join(', ')}]
---

# ${o.title}

## Context

<!-- orgspec:todo What forces are at play? Link the discussion. -->

## Options considered

1. <!-- orgspec:todo -->

## Decision

<!-- orgspec:todo What was decided, and by whom. -->

## Consequences

<!-- orgspec:todo What becomes easier or harder. -->
`,
  );
  return file;
}

/** Replaces a repo's rows in the local FTS index. */
export function indexDecisions(db: Db, repo: string, records: readonly DecisionRecord[]): number {
  db.prepare('delete from decisions_fts where repo = ?').run(repo);
  const ins = db.prepare(
    'insert into decisions_fts (adr_id, repo, title, status, scope_paths, scope_capabilities, body, file) values (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  for (const r of records)
    ins.run(r.adrId, r.repo, r.title, r.status, r.scopePaths.join(' '), r.scopeCapabilities.join(' '), r.body, r.file);
  return records.length;
}

/** FTS5 query built from plain words, so user input never becomes query syntax. */
const ftsQuery = (q: string) =>
  q
    .split(/\s+/)
    .map((w) => w.replace(/["*^():]/g, ''))
    .filter(Boolean)
    .map((w) => `"${w}"*`)
    .join(' ');

export function searchDecisions(db: Db, query: string, limit = 10) {
  const q = ftsQuery(query);
  if (!q) return [];
  const rows = db
    .prepare(
      `select adr_id, repo, title, status, file, snippet(decisions_fts, 6, '[', ']', '…', 12) as snippet
       from decisions_fts where decisions_fts match ? order by rank limit ?`,
    )
    .all(q, limit) as { adr_id: string; repo: string; title: string; status: string; file: string; snippet: string }[];
  return rows.map((r) => ({
    adrId: r.adr_id,
    repo: r.repo,
    title: r.title,
    status: r.status,
    file: r.file,
    snippet: r.snippet,
  }));
}
