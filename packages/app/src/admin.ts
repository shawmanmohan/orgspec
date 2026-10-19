import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  type CompileProgress,
  type CompileResult,
  compileAll,
  describeDiff,
  diffRules,
  evaluateFileWrite,
  evaluateGitCommand,
  loadBundle,
  type Rule,
  type RuleExtractor,
  type SourceFetcher,
} from '@orgspec/constitution';
import { exists, loadOrgConfig, type OrgConfig, readText, WaiverSchema, writeFileAtomic } from '@orgspec/core';
import type { Diagnostic } from '@orgspec/spec-engine';
import { parseDocument, parse as parseYaml, stringify as toYaml } from 'yaml';
import { z } from 'zod';
import type { AppContext } from './context.js';
import { promptWith, runAgentJob } from './jobs.js';

/** Confluence pages through the Atlassian MCP server. */
export const mcpFetcher = (ctx: AppContext): SourceFetcher => ({
  async fetch({ pageId }) {
    const p = await ctx.workplace().confluence.get(pageId);
    return { version: p.version, title: p.title, storage: p.storage };
  },
});

/** Rule extraction as a `claude -p --agent constitution-compiler` job. */
export const claudeExtractor = (ctx: AppContext): RuleExtractor => ({
  model: 'opus',
  async extract({ overlay, page, knownIds }) {
    const job = await runAgentJob(ctx, {
      kind: 'constitution-extract',
      agent: 'constitution-compiler',
      prompt: promptWith(
        `Extract rules for the ${overlay.spec.layer} layer "${overlay.metadata.id}"${overlay.spec.scope ? ` (scope ${overlay.spec.scope})` : ''}. Return {"rules": [{"id","title","statement","rationale","quote","appliesTo","enforcement","severity","check"}]}.\nKnown rule IDs (reuse when the rule is the same): ${knownIds.join(', ') || 'none'}`,
        { [`confluence:${page.pageId}:v${page.version}`]: `# ${page.title}\n\n${page.text}` },
      ),
      schema: z.object({ rules: z.array(z.unknown()) }),
      input: { overlay: overlay.metadata.id, pageId: page.pageId, version: page.version },
    });
    return job.data.rules;
  },
});

const bump = (v: string) => {
  const [a = 0, b = 0, c = 0] = v.split('.').map(Number);
  return `${a}.${b}.${c + 1}`;
};

function requireConfig(ctx: AppContext): OrgConfig {
  const cfg = ctx.config();
  if (!cfg || !ctx.configDir) throw new Error('orgspec-config is not set up; run orgspec setup');
  return cfg;
}

/** Currently pinned bundle rules for a persona, if any. */
export function currentRules(ctx: AppContext, persona: string): { version?: string; rules: Rule[] } {
  const p = ctx.persona(persona);
  if (!p || !ctx.configDir) return { rules: [] };
  const { bundle } = loadBundle(join(ctx.configDir, p.spec.constitution.bundle));
  return bundle ? { version: bundle.manifest.version, rules: bundle.rules } : { rules: [] };
}

export interface CompileReport extends CompileResult {
  diffs: { persona: string; from?: string; to: string; summary: string }[];
}

/**
 * `orgspec admin compile`: compiles every overlay into new bundle versions in the local config
 * checkout. Nothing is published until `orgspec admin publish` opens a PR.
 */
export async function adminCompile(
  ctx: AppContext,
  deps: { fetcher?: SourceFetcher; extractor?: RuleExtractor; onStep?: CompileProgress } = {},
): Promise<CompileReport> {
  const cfg = requireConfig(ctx);
  const result = await compileAll(cfg, {
    fetcher: deps.fetcher ?? mcpFetcher(ctx),
    extractor: deps.extractor ?? claudeExtractor(ctx),
    version: (persona) => bump(currentRules(ctx, persona).version ?? '0.0.0'),
    ...(deps.onStep ? { onStep: deps.onStep } : {}),
  });
  const diffs = result.bundles.map((b) => {
    const cur = currentRules(ctx, b.persona);
    return {
      persona: b.persona,
      ...(cur.version ? { from: cur.version } : {}),
      to: b.version,
      summary: describeDiff(diffRules(cur.rules, b.rules)),
    };
  });
  return { ...result, diffs };
}

/** Repoints a persona at a bundle, keeping comments in the YAML. */
export function pinPersona(configDir: string, persona: string, bundleRel: string, sha256: string): string {
  const dir = join(configDir, 'personas');
  const file = readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => join(dir, f))
    .find((f) => (parseYaml(readText(f)) as { metadata?: { id?: string } })?.metadata?.id === persona);
  if (!file) throw new Error(`No persona file for ${persona}`);
  const doc = parseDocument(readText(file));
  doc.setIn(['spec', 'constitution', 'bundle'], bundleRel);
  doc.setIn(['spec', 'constitution', 'sha256'], sha256);
  const v = String(doc.getIn(['metadata', 'version']) ?? '0.0.0');
  doc.setIn(['metadata', 'version'], bump(v));
  writeFileAtomic(file, doc.toString());
  return file;
}

/** Bundles available for a persona, newest first. */
export function bundleVersions(configDir: string, persona: string): string[] {
  const dir = join(configDir, 'compiled', persona);
  if (!exists(dir)) return [];
  return readdirSync(dir)
    .filter((v) => /^\d+\.\d+\.\d+$/.test(v))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
}

/**
 * Opens a PR on orgspec-config that pins personas to the given bundle versions. Process owners
 * approve it on GitHub; merging is what publishes.
 */
export async function adminPublish(
  ctx: AppContext,
  pins: { persona: string; version: string }[],
  o: { title?: string; body?: string; rollback?: boolean } = {},
): Promise<string> {
  const cfg = requireConfig(ctx);
  const dir = cfg.dir;
  const branch =
    `orgspec/${o.rollback ? 'rollback' : 'publish'}-${pins.map((p) => `${p.persona}-${p.version}`).join('-')}`.slice(
      0,
      100,
    );
  await ctx.git.call(dir, ['checkout', '-B', branch]);
  const lines: string[] = [];
  for (const p of pins) {
    const bdir = join(dir, 'compiled', p.persona, p.version);
    const { bundle, diagnostics } = loadBundle(bdir);
    if (!bundle)
      throw new Error(`Bundle ${p.persona} ${p.version} is invalid: ${diagnostics.map((d) => d.message).join('; ')}`);
    const before = currentRules(ctx, p.persona);
    pinPersona(dir, p.persona, relative(dir, bdir), bundle.manifest.sha256);
    lines.push(
      `### ${p.persona}: ${before.version ?? 'none'} → ${p.version}\n\n${describeDiff(diffRules(before.rules, bundle.rules))}`,
    );
  }
  await ctx.git.call(dir, ['add', 'compiled', 'personas']);
  await ctx.git.call(dir, [
    'commit',
    '-m',
    o.title ??
      `${o.rollback ? 'Roll back' : 'Publish'} constitution ${pins.map((p) => `${p.persona} ${p.version}`).join(', ')}`,
  ]);
  await ctx.git.call(dir, ['push', '-u', 'origin', branch]);
  return ctx.gh.prCreate({
    cwd: dir,
    title:
      o.title ??
      `${o.rollback ? 'Roll back' : 'Publish'} constitution: ${pins.map((p) => `${p.persona} ${p.version}`).join(', ')}`,
    body: `${o.body ?? 'Compiled by orgspec admin compile. Every rule cites the Confluence page version it came from.'}\n\n${lines.join('\n\n')}`,
    draft: false,
  });
}

/** Rolls a persona back to its previous bundle (as a PR). */
export async function adminRollback(ctx: AppContext, persona: string, to?: string): Promise<string> {
  const cfg = requireConfig(ctx);
  const versions = bundleVersions(cfg.dir, persona);
  const cur = currentRules(ctx, persona).version;
  const target = to ?? versions.find((v) => cur && v.localeCompare(cur, undefined, { numeric: true }) < 0);
  if (!target) throw new Error(`No earlier bundle for ${persona}`);
  return adminPublish(ctx, [{ persona, version: target }], { rollback: true });
}

export const EvalCaseSchema = z.object({
  name: z.string(),
  persona: z.string(),
  tier: z.enum(['low', 'medium', 'high']).default('medium'),
  bash: z.string().optional(),
  write: z.object({ path: z.string(), namedInSpec: z.string().default('') }).optional(),
  expect: z.enum(['allow', 'deny', 'ask']),
  rule: z.string().optional(),
});

/** Golden cases in `orgspec-config/evals/*.yaml`, run against compiled bundles before publishing. */
export function adminEval(
  ctx: AppContext,
  versions: Record<string, string> = {},
): { passed: number; failed: { name: string; got: string; want: string }[] } {
  const cfg = requireConfig(ctx);
  const dir = join(cfg.dir, 'evals');
  const cases = exists(dir)
    ? readdirSync(dir)
        .filter((f) => /\.ya?ml$/.test(f))
        .flatMap((f) => z.array(EvalCaseSchema).parse(parseYaml(readText(join(dir, f))) ?? []))
    : [];
  const failed: { name: string; got: string; want: string }[] = [];
  let passed = 0;
  const cache = new Map<string, Rule[]>();
  for (const c of cases) {
    if (!cache.has(c.persona)) {
      const v = versions[c.persona];
      cache.set(
        c.persona,
        v
          ? (loadBundle(join(cfg.dir, 'compiled', c.persona, v)).bundle?.rules ?? [])
          : currentRules(ctx, c.persona).rules,
      );
    }
    const rules = cache.get(c.persona) ?? [];
    const d = c.bash
      ? evaluateGitCommand(rules, c.bash, { tier: c.tier })
      : evaluateFileWrite(
          rules,
          { absolute: `/ticket/repos/r/${c.write?.path}`, repoRelative: c.write?.path ?? '' },
          { tier: c.tier, ticketFolder: '/ticket', namedInSpec: c.write?.namedInSpec ?? '' },
        );
    if (d.decision === c.expect && (!c.rule || d.ruleId === c.rule)) passed++;
    else
      failed.push({
        name: c.name,
        got: `${d.decision}${d.ruleId ? ` (${d.ruleId})` : ''}`,
        want: `${c.expect}${c.rule ? ` (${c.rule})` : ''}`,
      });
  }
  return { passed, failed };
}

/** Writes a waiver file; it takes effect when merged into orgspec-config. */
export function addWaiver(ctx: AppContext, w: Omit<z.input<typeof WaiverSchema>, 'id'>): { id: string; file: string } {
  const cfg = requireConfig(ctx);
  const dir = join(cfg.dir, 'waivers');
  const ids = cfg.waivers.map((x) => Number(x.id.slice(2)));
  const id = `W-${Math.max(0, ...ids) + 1}`;
  const waiver = WaiverSchema.parse({ ...w, id });
  const maxDays = 90;
  if (Date.parse(waiver.expires) - Date.now() > maxDays * 86_400_000)
    throw new Error(`Waivers last at most ${maxDays} days`);
  const file = join(dir, `${id}.yaml`);
  writeFileAtomic(file, toYaml(waiver));
  return { id, file };
}

/** Config validation for the admin screen: schema errors, missing bundles, persona pins. */
export function adminCheck(ctx: AppContext): Diagnostic[] {
  const dir = ctx.configDir;
  if (!dir) return [{ severity: 'error', code: 'config_missing', message: 'orgspec-config is not set up' }];
  const cfg = loadOrgConfig(dir);
  const out = [...cfg.diagnostics];
  for (const p of cfg.personas) {
    const { diagnostics } = loadBundle(join(dir, p.spec.constitution.bundle), p.spec.constitution.sha256);
    out.push(...diagnostics.map((d) => ({ ...d, message: `${p.metadata.id}: ${d.message}` })));
  }
  return out;
}
