import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { OrgConfig, Overlay } from '@orgspec/core';
import { type Diagnostic, error, warning } from '@orgspec/spec-engine';
import { z } from 'zod';
import { type BundleContent, type Manifest, writeBundle } from './bundle.js';
import { type LayerRules, mergeLayers } from './layering.js';
import { isGrounded, storageToText } from './normalize.js';
import { CheckSchema, ENFORCEABLE, type Rule, RuleSchema } from './rules.js';

export interface PageSnapshot {
  pageId: string;
  version: number;
  title: string;
  space: string;
  /** Normalised text the extractor reads and quotes are grounded against. */
  text: string;
  hash: string;
}

/** Fetches a Confluence page at its current version (through the Confluence MCP server). */
export interface SourceFetcher {
  fetch(source: {
    pageId: string;
    space: string;
    title: string;
  }): Promise<{ version: number; title: string; storage: string }>;
}

/** Turns one page into candidate rules (a `claude -p --agent constitution-compiler` run). Output is untrusted. */
export interface RuleExtractor {
  readonly model: string;
  extract(input: { overlay: Overlay; page: PageSnapshot; knownIds: string[] }): Promise<unknown>;
}

/** Pipeline progress: fetch, extract, ground, merge, budget, render (evals run after, in admin). */
export type CompileProgress = (
  step: 'fetch' | 'extract' | 'ground' | 'merge' | 'budget' | 'render',
  detail?: string,
) => void;

export const COMPILER_VERSION = '0.1.0';

/** What the extractor must return for each rule; the compiler fills in layer, scope and source version. */
export const CandidateSchema = z.object({
  id: z.string(),
  title: z.string(),
  statement: z.string(),
  rationale: z.string().default(''),
  quote: z.string(),
  appliesTo: RuleSchema.shape.appliesTo.optional(),
  enforcement: z.enum(['advisory', 'review', 'ci', 'hook']),
  severity: z.enum(['advisory', 'warning', 'blocking']).default('warning'),
  check: z.unknown().optional(),
});
export type Candidate = z.infer<typeof CandidateSchema>;

export interface DroppedCandidate {
  overlay: string;
  pageId: string;
  id?: string;
  reason: string;
}

export interface OverlayResult {
  overlay: Overlay;
  rules: Rule[];
  dropped: DroppedCandidate[];
  snapshots: PageSnapshot[];
  diagnostics: Diagnostic[];
}

const sha = (text: string): string => `sha256:${createHash('sha256').update(text).digest('hex')}`;

/** Fetch → normalise → extract → ground → classify for one overlay. */
export async function compileOverlay(
  overlay: Overlay,
  deps: { fetcher: SourceFetcher; extractor: RuleExtractor; knownIds?: string[]; onStep?: CompileProgress },
): Promise<OverlayResult> {
  const result: OverlayResult = { overlay, rules: [], dropped: [], snapshots: [], diagnostics: [] };
  for (const src of overlay.spec.sources) {
    const { pageId, space, title } = src.confluence;
    let page: PageSnapshot;
    deps.onStep?.('fetch', `${overlay.metadata.id}: ${title}`);
    try {
      const fetched = await deps.fetcher.fetch({ pageId, space, title });
      const text = storageToText(fetched.storage);
      page = { pageId, version: fetched.version, title: fetched.title, space, text, hash: sha(text) };
    } catch (e) {
      result.diagnostics.push(
        error('source_unreadable', `Cannot read page ${pageId} "${title}": ${(e as Error).message}`, {
          fix: 'Check that your account can read the space; the last good snapshot stays in use',
        }),
      );
      continue;
    }
    result.snapshots.push(page);
    deps.onStep?.('extract', `${overlay.metadata.id}: ${title} v${page.version}`);

    let raw: unknown;
    try {
      raw = await deps.extractor.extract({ overlay, page, knownIds: deps.knownIds ?? [] });
    } catch (e) {
      result.diagnostics.push(
        error('extract_failed', `Rule extraction failed for page ${pageId}: ${(e as Error).message}`),
      );
      continue;
    }
    const list = z.array(z.unknown()).safeParse(Array.isArray(raw) ? raw : (raw as { rules?: unknown })?.rules);
    if (!list.success) {
      result.diagnostics.push(error('extract_invalid', `Extractor output for page ${pageId} is not a list of rules`));
      continue;
    }
    for (const item of list.data) {
      const c = CandidateSchema.safeParse(item);
      const id = (item as { id?: string })?.id;
      if (!c.success) {
        result.dropped.push({
          overlay: overlay.metadata.id,
          pageId,
          ...(id ? { id } : {}),
          reason: `invalid shape: ${c.error.issues[0]?.message}`,
        });
        continue;
      }
      const rule = classify(c.data, overlay, page, result);
      if (rule) result.rules.push(rule);
    }
  }
  deps.onStep?.('ground', `${overlay.metadata.id}: ${result.rules.length} kept, ${result.dropped.length} dropped`);
  if (result.rules.length > overlay.spec.budget.maxRules) {
    result.diagnostics.push(
      error(
        'budget_exceeded',
        `${overlay.metadata.id} has ${result.rules.length} rules; its budget is ${overlay.spec.budget.maxRules}`,
        {
          fix: 'Merge or drop low-value rules in the source pages, or raise the budget in the overlay',
        },
      ),
    );
  }
  return result;
}

function classify(c: Candidate, overlay: Overlay, page: PageSnapshot, result: OverlayResult): Rule | undefined {
  const drop = (reason: string) => {
    result.dropped.push({ overlay: overlay.metadata.id, pageId: page.pageId, id: c.id, reason });
    return undefined;
  };
  if (!isGrounded(c.quote, page.text)) return drop('quote not found verbatim in the source page');

  let enforcement = c.enforcement;
  let check: Rule['check'];
  if (c.check !== undefined) {
    const parsed = CheckSchema.safeParse(c.check);
    if (!parsed.success) {
      result.diagnostics.push(warning('rule_check_invalid', `${c.id}: check is not valid DSL; kept as advisory`));
    } else check = parsed.data;
  }
  if (enforcement === 'ci' || enforcement === 'hook') {
    if (!check || !ENFORCEABLE[check.kind].includes(enforcement)) {
      const downgraded = check?.kind === 'rubric' ? 'review' : 'advisory';
      result.diagnostics.push(
        warning(
          'rule_downgraded',
          `${c.id}: cannot be enforced as ${enforcement}${check ? ` with a ${check.kind} check` : ' without a check'}; labelled ${downgraded}`,
        ),
      );
      enforcement = downgraded;
    }
  } else if (enforcement === 'review' && check && check.kind !== 'rubric') {
    enforcement = ENFORCEABLE[check.kind][0] ?? 'review';
  }

  const candidate = {
    id: c.id,
    title: c.title,
    statement: c.statement,
    rationale: c.rationale,
    ...(c.appliesTo ? { appliesTo: c.appliesTo } : {}),
    enforcement,
    ...(check ? { check } : {}),
    severity: enforcement === 'advisory' && c.severity === 'blocking' ? 'warning' : c.severity,
    source: { pageId: page.pageId, version: page.version, quote: c.quote },
    layer: overlay.spec.layer,
    ...(overlay.spec.scope ? { scope: overlay.spec.scope } : {}),
  };
  const parsed = RuleSchema.safeParse(candidate);
  if (!parsed.success)
    return drop(`invalid rule: ${parsed.error.issues[0]?.path.join('.')}: ${parsed.error.issues[0]?.message}`);
  return parsed.data;
}

export interface CompileResult {
  overlays: OverlayResult[];
  bundles: { persona: string; version: string; dir: string; manifest: Manifest; rules: Rule[] }[];
  diagnostics: Diagnostic[];
}

/** Rough token estimate for the agent-facing render of a rule set. */
export const estimateTokens = (rules: readonly Rule[]): number =>
  Math.ceil(rules.reduce((n, r) => n + r.title.length + r.statement.length + r.rationale.length + 40, 0) / 4);

/**
 * Compiles every overlay and writes one bundle per persona into `<configDir>/compiled/<persona>/<version>/`.
 * Nothing is written when any blocking diagnostic appears.
 */
export async function compileAll(
  config: OrgConfig,
  deps: {
    fetcher: SourceFetcher;
    extractor: RuleExtractor;
    version: (persona: string) => string;
    extraFiles?: (persona: string) => Record<string, string>;
    outDir?: string;
    onStep?: CompileProgress;
  },
): Promise<CompileResult> {
  const diagnostics: Diagnostic[] = [];
  const overlays: OverlayResult[] = [];
  const knownIds: string[] = [];
  for (const o of config.overlays) {
    const r = await compileOverlay(o, {
      fetcher: deps.fetcher,
      extractor: deps.extractor,
      knownIds,
      ...(deps.onStep ? { onStep: deps.onStep } : {}),
    });
    knownIds.push(...r.rules.map((x) => x.id));
    overlays.push(r);
    diagnostics.push(...r.diagnostics);
  }

  const shared = overlays.filter((o) => o.overlay.spec.layer !== 'persona');
  const result: CompileResult = { overlays, bundles: [], diagnostics };
  const plans: { persona: string; version: string; content: BundleContent; rules: Rule[] }[] = [];

  for (const persona of config.personas) {
    const pid = persona.metadata.id;
    const own = overlays.filter((o) => o.overlay.spec.layer === 'persona' && o.overlay.metadata.id === pid);
    const layers: LayerRules[] = [...shared, ...own].map((o) => ({
      layer: o.overlay.spec.layer,
      ...(o.overlay.spec.scope ? { scope: o.overlay.spec.scope } : {}),
      rules: o.rules.map((r) =>
        o.overlay.spec.layer === 'persona'
          ? {
              ...r,
              appliesTo: { ...r.appliesTo, personas: r.appliesTo.personas.length ? r.appliesTo.personas : [pid] },
            }
          : r,
      ),
    }));
    deps.onStep?.('merge', pid);
    const merged = mergeLayers(layers);
    diagnostics.push(...merged.diagnostics);
    const rules = merged.rules.filter((r) => r.appliesTo.personas.length === 0 || r.appliesTo.personas.includes(pid));
    const budget = own[0]?.overlay.spec.budget.maxTokens ?? 6000;
    deps.onStep?.('budget', `${pid}: ${rules.length} rules, about ${estimateTokens(rules)} tokens`);
    if (estimateTokens(rules) > budget) {
      diagnostics.push(
        error(
          'budget_exceeded',
          `${pid} rules render to about ${estimateTokens(rules)} tokens; the budget is ${budget}`,
        ),
      );
    }
    const version = deps.version(pid);
    const sources = [...shared, ...own].flatMap((o) =>
      o.snapshots.map((s) => ({ pageId: s.pageId, version: s.version, title: s.title, hash: s.hash })),
    );
    plans.push({
      persona: pid,
      version,
      rules,
      content: {
        persona: pid,
        version,
        rules,
        sources,
        compiler: { version: COMPILER_VERSION, model: deps.extractor.model },
        ...(deps.extraFiles ? { extraFiles: deps.extraFiles(pid) } : {}),
      },
    });
  }

  if (diagnostics.some((d) => d.severity === 'error')) return result;
  deps.onStep?.('render', plans.map((p) => `${p.persona} ${p.version}`).join(', '));
  for (const p of plans) {
    const dir = join(deps.outDir ?? join(config.dir, 'compiled'), p.persona, p.version);
    const manifest = writeBundle(dir, p.content);
    result.bundles.push({ persona: p.persona, version: p.version, dir, manifest, rules: p.rules });
  }
  return result;
}

export interface RuleDiff {
  added: Rule[];
  removed: Rule[];
  changed: { before: Rule; after: Rule; fields: string[] }[];
}

/** Plain diff between two rule sets, for the review screen and the publish PR. */
export function diffRules(before: readonly Rule[], after: readonly Rule[]): RuleDiff {
  const key = (r: Rule) => `${r.layer}:${r.scope ?? ''}:${r.id}`;
  const b = new Map(before.map((r) => [key(r), r]));
  const a = new Map(after.map((r) => [key(r), r]));
  const diff: RuleDiff = { added: [], removed: [], changed: [] };
  for (const [k, r] of a) {
    const old = b.get(k);
    if (!old) diff.added.push(r);
    else {
      const fields = (['statement', 'enforcement', 'severity', 'check', 'appliesTo', 'title'] as const).filter(
        (f) => JSON.stringify(old[f]) !== JSON.stringify(r[f]),
      );
      if (fields.length) diff.changed.push({ before: old, after: r, fields });
    }
  }
  for (const [k, r] of b) if (!a.has(k)) diff.removed.push(r);
  return diff;
}

export function describeDiff(diff: RuleDiff): string {
  const lines: string[] = [];
  for (const r of diff.added) lines.push(`Added ${r.id} (${r.enforcement}): ${r.statement}`);
  for (const c of diff.changed)
    lines.push(`Changed ${c.after.id}: ${c.fields.join(', ')} — now "${c.after.statement}"`);
  for (const r of diff.removed) lines.push(`Removed ${r.id}: ${r.statement}`);
  return lines.join('\n') || 'No rule changes.';
}
