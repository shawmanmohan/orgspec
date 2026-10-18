import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { exists, writeFileAtomic } from '@orgspec/core';
import { type Diagnostic, error } from '@orgspec/spec-engine';
import { z } from 'zod';
import { type Rule, RuleSchema } from './rules.js';

export const ManifestSchema = z.object({
  persona: z.string(),
  version: z.string(),
  sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  files: z.record(z.string(), z.string()),
  sources: z.array(z.object({ pageId: z.string(), version: z.number(), title: z.string(), hash: z.string() })),
  compiler: z.object({ version: z.string(), model: z.string() }),
  builtAt: z.string(),
  approvedBy: z.array(z.string()).default([]),
});
export type Manifest = z.infer<typeof ManifestSchema>;

export interface BundleContent {
  persona: string;
  version: string;
  rules: Rule[];
  sources: Manifest['sources'];
  compiler: Manifest['compiler'];
  /** Extra rendered files: playbooks, rule docs. */
  extraFiles?: Record<string, string>;
}

export interface LoadedBundle {
  dir: string;
  manifest: Manifest;
  rules: Rule[];
}

const sha = (text: string): string => `sha256:${createHash('sha256').update(text).digest('hex')}`;

/** The bundle hash covers every file except the manifest, in sorted order. */
export const bundleHash = (files: Record<string, string>): string =>
  sha(
    Object.keys(files)
      .sort()
      .map((k) => `${k}:${files[k]}`)
      .join('\n'),
  );

function renderConstitution(persona: string, version: string, rules: readonly Rule[]): string {
  const section = (title: string, list: readonly Rule[]) =>
    list.length
      ? `## ${title}\n\n${list
          .map(
            (r) =>
              `### ${r.title} (\`${r.id}\`)\n\n${r.statement}\n\n${r.rationale ? `Why: ${r.rationale}\n\n` : ''}Source: page ${r.source.pageId} v${r.source.version} — "${r.source.quote}"${r.layer !== 'base' ? ` · layer ${r.layer}${r.scope ? ` (${r.scope})` : ''}` : ''}`,
          )
          .join('\n\n')}\n`
      : '';
  return [
    `# Constitution: ${persona} ${version}`,
    '',
    'Compiled from the organisation’s Confluence pages and approved by a process owner. Rules marked enforced are checked by hooks or CI; advisory rules are guidance.',
    '',
    section(
      'Enforced by hooks',
      rules.filter((r) => r.enforcement === 'hook'),
    ),
    section(
      'Enforced in CI',
      rules.filter((r) => r.enforcement === 'ci'),
    ),
    section(
      'Review rubric',
      rules.filter((r) => r.enforcement === 'review'),
    ),
    section(
      'Advisory',
      rules.filter((r) => r.enforcement === 'advisory'),
    ),
  ]
    .filter((s) => s !== '')
    .join('\n');
}

export function renderBundleFiles(content: BundleContent): Record<string, string> {
  const files: Record<string, string> = {
    'constitution.md': renderConstitution(content.persona, content.version, content.rules),
    'rules.json': `${JSON.stringify({ persona: content.persona, version: content.version, rules: content.rules }, null, 2)}\n`,
    'checks.json': `${JSON.stringify(
      content.rules
        .filter((r) => r.check && (r.enforcement === 'ci' || r.enforcement === 'hook'))
        .map((r) => ({ id: r.id, enforcement: r.enforcement, severity: r.severity, check: r.check })),
      null,
      2,
    )}\n`,
    ...(content.extraFiles ?? {}),
  };
  const byArtifact = new Map<string, Rule[]>();
  for (const r of content.rules) {
    if (r.check?.kind !== 'rubric') continue;
    byArtifact.set(r.check.artifact, [...(byArtifact.get(r.check.artifact) ?? []), r]);
  }
  for (const [artifact, rules] of byArtifact) {
    files[`rubrics/${artifact}.json`] = `${JSON.stringify(
      rules.map((r) => ({
        id: r.id,
        question: r.check?.kind === 'rubric' ? r.check.question : '',
        severity: r.severity,
        statement: r.statement,
      })),
      null,
      2,
    )}\n`;
  }
  return files;
}

/** Writes `compiled/<persona>/<version>/` with a manifest; returns the manifest. */
export function writeBundle(dir: string, content: BundleContent, builtAt = new Date().toISOString()): Manifest {
  const files = renderBundleFiles(content);
  const hashes = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, sha(v)]));
  const manifest: Manifest = {
    persona: content.persona,
    version: content.version,
    sha256: bundleHash(hashes),
    files: hashes,
    sources: content.sources,
    compiler: content.compiler,
    builtAt,
    approvedBy: [],
  };
  for (const [k, v] of Object.entries(files)) writeFileAtomic(join(dir, k), v);
  writeFileAtomic(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const visit = (d: string) => {
    for (const e of readdirSync(d)) {
      const full = join(d, e);
      if (statSync(full).isDirectory()) visit(full);
      else out.push(relative(dir, full).split(sep).join('/'));
    }
  };
  visit(dir);
  return out;
}

/** Loads a bundle and verifies every file against the manifest, and the manifest against `expected`. */
export function loadBundle(dir: string, expected?: string): { bundle?: LoadedBundle; diagnostics: Diagnostic[] } {
  const manifestFile = join(dir, 'manifest.json');
  if (!exists(manifestFile)) return { diagnostics: [error('bundle_missing', `No bundle at ${dir}`)] };
  const parsed = ManifestSchema.safeParse(JSON.parse(readFileSync(manifestFile, 'utf8')));
  if (!parsed.success) return { diagnostics: [error('bundle_manifest_invalid', `Manifest in ${dir} is invalid`)] };
  const manifest = parsed.data;
  const diagnostics: Diagnostic[] = [];

  const onDisk = listFiles(dir).filter((f) => f !== 'manifest.json');
  const actual: Record<string, string> = {};
  for (const f of onDisk) actual[f] = sha(readFileSync(join(dir, f), 'utf8'));
  for (const [f, h] of Object.entries(manifest.files)) {
    if (actual[f] !== h) diagnostics.push(error('bundle_tampered', `${f} does not match the bundle manifest`));
  }
  for (const f of onDisk) {
    if (!(f in manifest.files)) diagnostics.push(error('bundle_tampered', `${f} is not listed in the bundle manifest`));
  }
  if (bundleHash(manifest.files) !== manifest.sha256) {
    diagnostics.push(error('bundle_tampered', 'Bundle hash does not match its file list'));
  }
  if (expected && manifest.sha256 !== expected) {
    diagnostics.push(error('bundle_hash_mismatch', `Bundle is ${manifest.sha256}; the persona pins ${expected}`));
  }
  if (diagnostics.length) return { diagnostics };

  const rulesDoc = JSON.parse(readFileSync(join(dir, 'rules.json'), 'utf8')) as { rules: unknown[] };
  const rules = z.array(RuleSchema).parse(rulesDoc.rules);
  return { bundle: { dir, manifest, rules }, diagnostics };
}
