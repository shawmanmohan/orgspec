import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

export interface Migration {
  version: number;
  sql: string;
}

/** Opens (and migrates) a SQLite file. `:memory:` works for tests. */
export function openDb(file: string, migrations: readonly Migration[]): Db {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('pragma journal_mode = wal; pragma foreign_keys = on; pragma busy_timeout = 3000;');
  db.exec('create table if not exists schema_version (version integer not null)');
  const row = db.prepare('select max(version) as v from schema_version').get() as { v: number | null } | undefined;
  const current = row?.v ?? 0;
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (m.version <= current) continue;
    db.exec('begin');
    try {
      db.exec(m.sql);
      db.prepare('insert into schema_version (version) values (?)').run(m.version);
      db.exec('commit');
    } catch (e) {
      db.exec('rollback');
      throw e;
    }
  }
  return db;
}

export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('begin');
  try {
    const out = fn();
    db.exec('commit');
    return out;
  } catch (e) {
    db.exec('rollback');
    throw e;
  }
}

export const nowIso = (): string => new Date().toISOString();

/** The per-machine cache: tool metadata, jobs, findings, scores, reminders, audit. Rebuildable. */
export const CORE_MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
create table kv (key text primary key, value text not null);
create table jobs (
  id text primary key, kind text not null, folder text not null, state text not null,
  input text, result text, error text, attempts integer not null default 0,
  created_at text not null, started_at text, finished_at text
);
create index jobs_state on jobs(state, created_at);
create table sync_state (
  source text primary key, last_run_at text, last_success_at text, cursor text,
  effective_interval_ms integer, clean_runs integer not null default 0, status text not null default 'idle', message text
);
create table cache_jira_issues (
  key text primary key, project text, type text, status text, summary text, assignee text, priority text,
  tier text, gate_fields text, links text, epic text, labels text, story_points real,
  created_at text, resolved_at text, source_updated_at text, fetched_at text not null
);
create table cache_jira_snapshots (program text not null, day text not null, data text not null, primary key (program, day));
create table cache_confluence_pages (
  page_id text primary key, title text, space text, version integer, hash text, labels text,
  source_updated_at text, fetched_at text not null
);
create table cache_github_prs (
  repo text not null, number integer not null, branch text, title text, state text, author text, review_decision text,
  url text, created_at text, updated_at text, fetched_at text not null, primary key (repo, number)
);
create table cache_ci_runs (
  id text primary key, repo text, branch text, sha text, status text, conclusion text, steps text, url text,
  source_updated_at text, fetched_at text not null
);
create table findings (
  id text primary key, subject text not null, rubric_id text not null, severity text not null, confidence real,
  quote text, finding text not null, question text, status text not null default 'open', edited text, created_at text not null
);
create virtual table decisions_fts using fts5(adr_id, repo, title, status, scope_paths, scope_capabilities, body, file unindexed);
create table risk_scores (
  program_id text not null, score real not null, band text not null, drivers text not null, computed_at text not null,
  primary key (program_id, computed_at)
);
create table reminders (
  id text primary key, kind text not null, subject text not null, title text not null, url text,
  due_at text not null, snoozed_until text, done integer not null default 0, delivered_at text
);
create table pending_actions (
  id text primary key, server text not null, tool text not null, args text not null, summary text not null,
  persona text, ticket text, state text not null, created_at text not null, decided_at text, result text
);
create table nudges (id text primary key, ticket text not null, recipient text not null, channel text not null, sent_at text not null);
create table audit (seq integer primary key autoincrement, at text not null, record text not null, prev text not null, hash text not null);
`,
  },
];

/** The private database: never leaves the machine; payloads are encrypted with a keychain-held key. */
export const PRIVATE_MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
create table inbox_tasks (
  id text primary key, conversation text not null, kind text not null, payload text not null,
  group_key text, rank real not null default 0, state text not null default 'open', pinned integer not null default 0,
  created_at text not null, updated_at text not null, closed_at text
);
create table inbox_cursor (conversation text primary key, last_ts text not null);
create table summaries (id text primary key, payload text not null, created_at text not null);
create table notes (id text primary key, subject text not null, payload text not null, updated_at text not null);
create table briefs (id text primary key, report text not null, payload text not null, created_at text not null);
`,
  },
];
