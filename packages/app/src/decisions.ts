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
  date?: string;
  owner?: string;
  review?: string;
  sources: string[];
  supersedes?: string;
  supersededBy?: string;
  /** Markdown sections by heading (Decision, Context, Options considered, Consequences…). */
  sections: Record<string, string>;
}

const FRONT = /^---\n([\s\S]*?)\n---\n?/;

export function sectionsOf(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  const parts = body.split(/^##\s+/m).slice(1);
  for (const p of parts) {
    const nl = p.indexOf('\n');
    const head = (nl < 0 ? p : p.slice(0, nl)).trim();
    out[head] = (nl < 0 ? '' : p.slice(nl + 1)).replace(/<!--[\s\S]*?-->/g, '').trim();
  }
  return out;
}

export function parseDecision(text: string, file: string, repo: string): DecisionRecord | undefined {
  const m = FRONT.exec(text);
  const meta = (m ? (parseYaml(m[1] as string) as Record<string, unknown>) : {}) ?? {};
  const body = m ? text.slice(m[0].length) : text;
  const title = String(meta.title ?? /^#\s+(.+)$/m.exec(body)?.[1] ?? '').trim();
  const adrId = String(meta.id ?? /^(ADR-\d+)/i.exec(file.split('/').pop() ?? '')?.[1] ?? '').toUpperCase();
  if (!adrId || !title) return undefined;
  const scope = (meta.scope ?? {}) as { paths?: string[]; capabilities?: string[] };
  const str = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : String(v));
  const date = str(meta.date);
  const owner =
    str(meta.owner) ?? (Array.isArray(meta.deciders) && meta.deciders.length ? String(meta.deciders[0]) : undefined);
  const review = str(meta.review);
  const supersedes = str(meta.supersedes);
  const supersededBy = str(meta.superseded_by);
  return {
    adrId,
    repo,
    title,
    status: String(meta.status ?? 'proposed'),
    scopePaths: scope.paths ?? [],
    scopeCapabilities: scope.capabilities ?? [],
    body: body.trim(),
    file,
    sources: Array.isArray(meta.sources) ? meta.sources.map(String) : [],
    sections: sectionsOf(body),
    ...(date ? { date } : {}),
    ...(owner ? { owner } : {}),
    ...(review ? { review } : {}),
    ...(supersedes ? { supersedes } : {}),
    ...(supersededBy ? { supersededBy } : {}),
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

export interface NewDecision {
  title: string;
  deciders?: string[];
  owner?: string;
  paths?: string[];
  capabilities?: string[];
  change?: string;
  decision?: string;
  context?: string;
  options?: string;
  review?: string;
  sources?: string[];
  supersedes?: string;
}

const todo = (hint: string) => `<!-- orgspec:todo ${hint} -->`;

/** `orgspec decision new`: the next ADR number in this repo, with the standard sections. */
export function newDecision(ws: Workspace, o: NewDecision): string {
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
  const q = (v: string) => JSON.stringify(v);
  writeFileAtomic(
    file,
    `---
id: ${id}
title: ${q(o.title)}
status: proposed
date: ${today}
${o.owner ? `owner: ${q(o.owner)}\n` : ''}deciders: [${(o.deciders ?? []).map(q).join(', ')}]
${o.review ? `review: ${o.review}\n` : ''}${o.supersedes ? `supersedes: ${o.supersedes}\n` : ''}${o.change ? `change: ${o.change}\n` : ''}sources: [${(o.sources ?? []).map(q).join(', ')}]
scope:
  paths: [${(o.paths ?? []).map(q).join(', ')}]
  capabilities: [${(o.capabilities ?? []).join(', ')}]
---

# ${o.title}

## Decision

${o.decision?.trim() || todo('What was decided, and by whom.')}

## Context

${o.context?.trim() || todo('What forces are at play? Link the discussion.')}

## Options considered

${o.options?.trim() || `1. ${todo('')}`}

## Consequences

${todo('What becomes easier or harder.')}
`,
  );
  const sup = o.supersedes;
  if (sup) {
    // The superseded record stays in history and points forward; it becomes "superseded" when this merges.
    const old = readdirSync(ws.decisionsDir).find((f) => f.toUpperCase().startsWith(`${sup.toUpperCase()}-`));
    if (old) {
      const path = join(ws.decisionsDir, old);
      const text = readText(path);
      if (!/^superseded_by:/m.test(text)) writeFileAtomic(path, text.replace(/^---\n/, `---\nsuperseded_by: ${id}\n`));
    }
  }
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
