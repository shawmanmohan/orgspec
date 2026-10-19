import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { diffRules, loadBundle, type Rule, type RuleExtractor } from '@orgspec/constitution';
import { exists, loadOrgConfig, nowIso, PersonaSchema, readText, writeFileAtomic } from '@orgspec/core';
import type { Diagnostic } from '@orgspec/spec-engine';
import { parseDocument, parse as parseYaml, stringify as toYaml } from 'yaml';
import { addWaiver, adminCompile, adminEval, claudeExtractor, currentRules } from './admin.js';
import type { AppContext } from './context.js';
import { proposeChange } from './prs.js';

// Admin mode: sources and compile runs, bundle review, waivers, personas and sync defaults.
// Every change to orgspec-config goes out as a pull request; nothing takes effect until it merges.

const kvGet = <T>(ctx: AppContext, k: string): T | undefined => {
  const v = (ctx.db().prepare('select value from kv where key = ?').get(k) as { value: string } | undefined)?.value;
  return v ? (JSON.parse(v) as T) : undefined;
};
const kvSet = (ctx: AppContext, k: string, v: unknown) =>
  ctx.db().prepare('insert or replace into kv (key, value) values (?, ?)').run(k, JSON.stringify(v));

const configDir = (ctx: AppContext): string => {
  if (!ctx.configDir) throw new Error('orgspec-config is not set up');
  return ctx.configDir;
};

// ---- Sources ----

export interface SourceRow {
  pageId: string;
  title: string;
  space: string;
  feeds: string[];
  owners: string[];
  compiled?: number;
  current?: number;
  status: 'up to date' | 'changed' | 'unreadable' | 'not compiled';
  error?: string;
}

/** Each constitution source page with the version compiled into the live bundles and the current one. */
export async function sourcesStatus(ctx: AppContext, o: { live?: boolean } = {}): Promise<SourceRow[]> {
  const cfg = ctx.config();
  if (!cfg) return [];
  const compiled = new Map<string, number>();
  for (const p of cfg.personas) {
    const b = ctx.bundle(p).bundle;
    for (const s of b?.manifest.sources ?? []) compiled.set(s.pageId, Math.max(compiled.get(s.pageId) ?? 0, s.version));
  }
  const rows = new Map<string, SourceRow>();
  for (const ov of cfg.overlays) {
    for (const s of ov.spec.sources) {
      const id = s.confluence.pageId;
      const row = rows.get(id) ?? {
        pageId: id,
        title: s.confluence.title,
        space: s.confluence.space,
        feeds: [],
        owners: [],
        status: 'not compiled' as const,
      };
      row.feeds.push(ov.spec.layer === 'base' ? 'base' : ov.metadata.id);
      row.owners.push(...ov.metadata.owners.filter((x) => !row.owners.includes(x)));
      rows.set(id, row);
    }
  }
  for (const row of rows.values()) {
    const c = compiled.get(row.pageId);
    if (c !== undefined) row.compiled = c;
    let current =
      (
        ctx.db().prepare('select version from cache_confluence_pages where page_id = ?').get(row.pageId) as
          | { version?: number }
          | undefined
      )?.version ?? undefined;
    if (o.live) {
      try {
        const p = await ctx.workplace().confluence.get(row.pageId);
        current = p.version;
        row.title = p.title || row.title;
        ctx
          .db()
          .prepare(
            'insert or replace into cache_confluence_pages (page_id, title, space, version, fetched_at) values (?, ?, ?, ?, ?)',
          )
          .run(row.pageId, p.title, row.space, p.version, nowIso());
      } catch (e) {
        row.status = 'unreadable';
        row.error = (e as Error).message;
      }
    }
    if (current !== undefined && current !== null) row.current = current;
    if (row.status !== 'unreadable')
      row.status =
        c === undefined ? 'not compiled' : row.current === undefined || row.current === c ? 'up to date' : 'changed';
  }
  return [...rows.values()];
}

// ---- Compile runs ----

export interface CompileRun {
  id: string;
  startedAt: string;
  finishedAt?: string;
  state: 'running' | 'done' | 'failed';
  changedOnly: boolean;
  steps: { step: string; detail?: string; at: string }[];
  error?: string;
}

export interface CompileReview {
  runId: string;
  at: string;
  candidates: { persona: string; version: string; sha256: string; rules: number; tokens: number; maxRules: number }[];
  blocking: Diagnostic[];
  warnings: Diagnostic[];
  dropped: { overlay: string; pageId: string; id?: string; reason: string }[];
  changes: { persona: string; kind: 'added' | 'changed' | 'removed'; rule: Rule; fields?: string[] }[];
  evals: {
    persona: string;
    current: { passed: number; failed: number };
    candidate: { passed: number; failed: number };
    failures: { name: string; got: string; want: string }[];
  }[];
}

export const lastRun = (ctx: AppContext) => kvGet<CompileRun>(ctx, 'compile:run');
export const lastReview = (ctx: AppContext) => kvGet<CompileReview>(ctx, 'compile:review');

/** Reuses the live bundle's rules for pages whose version has not changed, so only edited pages go to Claude. */
export function cachedExtractor(ctx: AppContext, base: RuleExtractor): RuleExtractor {
  const previous: Rule[] = (ctx.config()?.personas ?? []).flatMap((p) => ctx.bundle(p).bundle?.rules ?? []);
  return {
    model: base.model,
    async extract(input) {
      const same = previous.filter(
        (r) => r.source.pageId === input.page.pageId && r.source.version === input.page.version,
      );
      if (!same.length) return base.extract(input);
      const seen = new Set<string>();
      return same
        .filter((r) => {
          if (seen.has(r.id)) return false;
          seen.add(r.id);
          return true;
        })
        .map((r) => ({
          id: r.id,
          title: r.title,
          statement: r.statement,
          rationale: r.rationale,
          quote: r.source.quote,
          appliesTo: r.appliesTo,
          enforcement: r.enforcement,
          severity: r.severity,
          ...(r.check ? { check: r.check } : {}),
        }));
    },
  };
}

/**
 * Starts a compile on this machine (in the background) and records each pipeline step, then runs the
 * golden evals on the current and candidate bundles for the review screen.
 */
export function startCompile(
  ctx: AppContext,
  o: { changedOnly?: boolean; extractor?: RuleExtractor } = {},
): CompileRun {
  const running = lastRun(ctx);
  if (running?.state === 'running' && Date.now() - Date.parse(running.startedAt) < 30 * 60_000)
    throw Object.assign(new Error('A compile is already running'), { statusCode: 409 });
  const run: CompileRun = {
    id: `run_${randomUUID().slice(0, 6)}`,
    startedAt: nowIso(),
    state: 'running',
    changedOnly: Boolean(o.changedOnly),
    steps: [],
  };
  kvSet(ctx, 'compile:run', run);
  const step = (s: string, detail?: string) => {
    run.steps.push({ step: s, ...(detail ? { detail } : {}), at: nowIso() });
    kvSet(ctx, 'compile:run', run);
  };
  const base = o.extractor ?? claudeExtractor(ctx);
  void (async () => {
    try {
      const before = Object.fromEntries(
        (ctx.config()?.personas ?? []).map((p) => [p.metadata.id, currentRules(ctx, p.metadata.id)]),
      );
      const r = await adminCompile(ctx, { extractor: o.changedOnly ? cachedExtractor(ctx, base) : base, onStep: step });
      step('evals');
      const cfg = ctx.config();
      const evals = r.bundles.map((b) => {
        const cur = adminEval(
          ctx,
          before[b.persona]?.version ? { [b.persona]: before[b.persona]?.version as string } : {},
        );
        const cand = adminEval(ctx, { [b.persona]: b.version });
        const mine = (x: typeof cur) => x.failed.filter((f) => f.name);
        return {
          persona: b.persona,
          current: { passed: cur.passed, failed: cur.failed.length },
          candidate: { passed: cand.passed, failed: cand.failed.length },
          failures: mine(cand),
        };
      });
      const changes: CompileReview['changes'] = [];
      for (const b of r.bundles) {
        const d = diffRules(before[b.persona]?.rules ?? [], b.rules);
        changes.push(...d.added.map((rule) => ({ persona: b.persona, kind: 'added' as const, rule })));
        changes.push(
          ...d.changed.map((c) => ({ persona: b.persona, kind: 'changed' as const, rule: c.after, fields: c.fields })),
        );
        changes.push(...d.removed.map((rule) => ({ persona: b.persona, kind: 'removed' as const, rule })));
      }
      const review: CompileReview = {
        runId: run.id,
        at: nowIso(),
        candidates: r.bundles.map((b) => {
          const ov = cfg?.overlays.find((x) => x.spec.layer === 'persona' && x.metadata.id === b.persona);
          return {
            persona: b.persona,
            version: b.version,
            sha256: b.manifest.sha256,
            rules: b.rules.length,
            tokens: Math.ceil(
              b.rules.reduce((n, x) => n + x.title.length + x.statement.length + x.rationale.length + 40, 0) / 4,
            ),
            maxRules: ov?.spec.budget.maxRules ?? 60,
          };
        }),
        blocking: r.diagnostics.filter((d) => d.severity === 'error'),
        warnings: r.diagnostics.filter((d) => d.severity !== 'error'),
        dropped: r.overlays.flatMap((x) => x.dropped),
        changes,
        evals,
      };
      kvSet(ctx, 'compile:review', review);
      run.state = 'done';
    } catch (e) {
      run.state = 'failed';
      run.error = (e as Error).message;
    }
    run.finishedAt = nowIso();
    kvSet(ctx, 'compile:run', run);
  })();
  return run;
}

// ---- Waivers ----

const waiverFile = (dir: string, id: string) => join(dir, 'waivers', `${id}.yaml`);

export async function newWaiverPr(
  ctx: AppContext,
  w: { rule: string; reason: string; approver: string; expires: string; scope: Record<string, unknown> },
): Promise<string> {
  const dir = configDir(ctx);
  const { id, file } = addWaiver(ctx, w);
  return proposeChange(ctx, dir, {
    branch: `waiver/${id}`,
    files: [file],
    message: `Waiver ${id} for ${w.rule}`,
    title: `Waiver ${id}: ${w.rule} until ${w.expires}`,
    body: `${w.reason}\n\nScope: ${JSON.stringify(w.scope)}\nApprover: ${w.approver}\n\nThe waiver applies only after the approver merges this PR, and stops applying on ${w.expires}.`,
  });
}

export async function renewWaiverPr(ctx: AppContext, id: string, expires: string): Promise<string> {
  const dir = configDir(ctx);
  const file = waiverFile(dir, id);
  if (!exists(file)) throw Object.assign(new Error(`No waiver ${id}`), { statusCode: 404 });
  if (Date.parse(expires) - Date.now() > 90 * 86_400_000)
    throw Object.assign(new Error('Waivers last at most 90 days'), { statusCode: 400 });
  const doc = parseDocument(readText(file));
  doc.set('expires', expires);
  writeFileAtomic(file, doc.toString());
  return proposeChange(ctx, dir, {
    branch: `waiver/${id}-renew`,
    files: [file],
    message: `Renew waiver ${id} until ${expires}`,
    title: `Renew waiver ${id} until ${expires}`,
    body: 'Renewal needs the rule owner’s approval again.',
  });
}

export async function revokeWaiverPr(ctx: AppContext, id: string): Promise<string> {
  const dir = configDir(ctx);
  const file = waiverFile(dir, id);
  if (!exists(file)) throw Object.assign(new Error(`No waiver ${id}`), { statusCode: 404 });
  rmSync(file);
  await ctx.git.call(dir, ['add', '-A', 'waivers']).catch(() => undefined);
  return proposeChange(ctx, dir, {
    branch: `waiver/${id}-revoke`,
    files: [file],
    message: `Revoke waiver ${id}`,
    title: `Revoke waiver ${id}`,
    body: 'The rule applies again once this merges.',
  });
}

// ---- Personas ----

export function personaFile(ctx: AppContext, id: string): string | undefined {
  const dir = join(configDir(ctx), 'personas');
  for (const f of ['yaml', 'yml'].map((e) => join(dir, `${id}.${e}`))) if (exists(f)) return f;
  return undefined;
}

export async function personaHistory(ctx: AppContext, id: string): Promise<{ date: string; subject: string }[]> {
  const f = personaFile(ctx, id);
  if (!f) return [];
  const out = await ctx.git
    .call(configDir(ctx), ['log', '-8', '--format=%ad%x09%s', '--date=short', '--', f])
    .catch(() => '');
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [date = '', subject = ''] = l.split('\t');
      return { date, subject };
    });
}

/** Validates an edited persona manifest and opens a PR with it. A persona can only narrow access, never widen it. */
export async function savePersonaPr(
  ctx: AppContext,
  id: string,
  yamlText: string,
  o: { create?: boolean } = {},
): Promise<string> {
  const parsed = PersonaSchema.safeParse(parseYaml(yamlText));
  if (!parsed.success)
    throw Object.assign(new Error(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')), {
      statusCode: 400,
    });
  if (parsed.data.metadata.id !== id && !o.create)
    throw Object.assign(new Error('The manifest id must stay the same'), { statusCode: 400 });
  const pid = parsed.data.metadata.id;
  const file = personaFile(ctx, pid) ?? join(configDir(ctx), 'personas', `${pid}.yaml`);
  if (o.create && exists(file)) throw Object.assign(new Error(`Persona ${pid} already exists`), { statusCode: 409 });
  writeFileAtomic(file, yamlText.endsWith('\n') ? yamlText : `${yamlText}\n`);
  return proposeChange(ctx, configDir(ctx), {
    branch: `persona/${pid}-${parsed.data.metadata.version}`,
    files: [file],
    message: `${o.create ? 'Add' : 'Update'} persona ${pid} ${parsed.data.metadata.version}`,
    title: `${o.create ? 'Add' : 'Update'} persona ${parsed.data.metadata.name} ${parsed.data.metadata.version}`,
    body: 'Edited in OrgSpec admin mode. Process owners approve it on GitHub; merging is what publishes.',
  });
}

export function personaTemplate(): string {
  return `apiVersion: orgspec/v1
kind: Persona
metadata:
  id: new-persona
  name: New persona
  version: 0.1.0
  owners: []
spec:
  eligibility:
    teams: []
  constitution:
    bundle: compiled/new-persona/0.1.0
    sha256: "sha256:${'0'.repeat(64)}"
  agents: []
  mcp: []
  views: [my-work, my-agents, task-inbox, decisions]
`;
}

export function personaYaml(ctx: AppContext, id: string): string {
  const f = personaFile(ctx, id);
  return f ? readFileSync(f, 'utf8') : '';
}

/** Validity of every persona manifest in the config checkout, by file. */
export function personaDiagnostics(ctx: AppContext): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const d of loadOrgConfig(configDir(ctx)).diagnostics) {
    if (!d.path?.includes('/personas/')) continue;
    const id =
      d.path
        .split('/')
        .pop()
        ?.replace(/\.ya?ml$/, '') ?? d.path;
    out.set(id, [...(out.get(id) ?? []), d.message]);
  }
  return out;
}

export function bundleUsable(ctx: AppContext, personaId: string): { ok: boolean; message?: string } {
  const p = ctx.persona(personaId);
  if (!p) return { ok: false, message: 'not loaded' };
  const { bundle, diagnostics } = loadBundle(
    join(configDir(ctx), p.spec.constitution.bundle),
    p.spec.constitution.sha256,
  );
  return bundle ? { ok: true } : { ok: false, message: diagnostics[0]?.message ?? 'no bundle compiled' };
}

// ---- Sync defaults ----

export async function saveSyncPr(
  ctx: AppContext,
  source: string,
  o: {
    every: string;
    offHours: 'slow' | 'pause' | 'same';
    offHoursEvery?: string;
    personal: boolean;
    min?: string;
    max?: string;
  },
): Promise<string> {
  const dir = configDir(ctx);
  const file = join(dir, 'sync.yaml');
  const doc = exists(file) ? parseDocument(readText(file)) : parseDocument(toYaml({ sources: {} }));
  const cur = (ctx.config()?.sync.sources[source] ?? {}) as Record<string, unknown>;
  doc.setIn(['sources', source], {
    ...cur,
    every: o.every,
    offHours: o.offHours,
    ...(o.offHoursEvery ? { offHoursEvery: o.offHoursEvery } : {}),
    personal: o.personal,
    ...(o.min ? { min: o.min } : {}),
    ...(o.max ? { max: o.max } : {}),
  });
  writeFileAtomic(file, doc.toString());
  return proposeChange(ctx, dir, {
    branch: `sync/${source}-${o.every}`,
    files: [file],
    message: `Sync: ${source} every ${o.every}`,
    title: `Sync defaults: ${source} every ${o.every}`,
    body: 'After this merges, every machine picks up the new interval on its next config pull, within 15 minutes.',
  });
}

export interface SyncStat {
  day: string;
  runs: number;
  slowestMs: number;
}

/** Per-source run counts and the slowest run today, on this machine. */
export function recordSyncStat(ctx: AppContext, source: string, ms: number): void {
  const day = nowIso().slice(0, 10);
  const k = `syncstat:${source}`;
  const cur = kvGet<SyncStat>(ctx, k);
  const next =
    cur?.day === day
      ? { day, runs: cur.runs + 1, slowestMs: Math.max(cur.slowestMs, ms) }
      : { day, runs: 1, slowestMs: ms };
  kvSet(ctx, k, next);
}
export const syncStat = (ctx: AppContext, source: string) => kvGet<SyncStat>(ctx, `syncstat:${source}`);
