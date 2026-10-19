// Writes examples/orgspec-config/compiled/* from seed rules and pins each persona to its bundle hash.
// Real bundles come from `orgspec admin compile`; these exist so the example config works offline.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { writeBundle } from '../packages/constitution/dist/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'orgspec-config');
const src = (pageId, quote) => ({ pageId, version: 1, quote });
const all = ['low', 'medium', 'high'];

const engineer = [
  { id: 'eng.git.no-force-push', title: 'No force pushes', statement: 'Never force-push; add commits or open a new branch.', enforcement: 'hook', severity: 'blocking', check: { kind: 'git-op', deny: ['force-push'], ask: [], tiers: all }, source: src('100001', 'Never force-push to a branch someone else may have pulled') },
  { id: 'eng.git.draft-prs', title: 'Open pull requests as drafts', statement: 'Open pull requests as drafts; a person marks them ready.', enforcement: 'hook', severity: 'warning', check: { kind: 'git-op', deny: [], ask: ['pr-ready'], tiers: all }, source: src('100001', 'pull requests start as drafts') },
  { id: 'eng.ci.workflows-in-spec', title: 'CI workflows change only with a spec', statement: 'Change .github/workflows only when the change folder names the file.', enforcement: 'hook', severity: 'blocking', check: { kind: 'file-scope', deny: ['.github/workflows/**'], allowWhenNamedInSpec: true, tiers: all }, source: src('100002', 'Pipeline definitions change only through a reviewed change') },
  { id: 'eng.tier.migrations-high', title: 'Migrations are high tier', statement: 'Changes under db/migrations need a high-tier change.', enforcement: 'ci', severity: 'blocking', check: { kind: 'path-rule', paths: ['db/migrations/**'], minTier: 'high' }, appliesTo: { paths: ['db/migrations/**'] }, source: src('100002', 'Schema migrations are always high risk') },
  { id: 'eng.trace.scenarios', title: 'Scenarios are tested', statement: 'Every new or changed scenario is cited by a test at medium and high tier.', enforcement: 'ci', severity: 'blocking', check: { kind: 'trace-coverage', tiers: ['medium', 'high'] }, source: src('100001', 'every behaviour change ships with a test') },
  { id: 'eng.design.approval', title: 'High-tier designs need a staff engineer', statement: 'A staff engineer approves design.md for high-tier changes.', enforcement: 'ci', severity: 'blocking', check: { kind: 'approval', artifact: 'design.md', role: 'staff-engineer', count: 1 }, appliesTo: { tiers: ['high'] }, source: src('100002', 'High-risk designs are approved by a staff engineer') },
  { id: 'eng.design.rollback', title: 'Designs explain rollback', statement: 'design.md says how to roll the change back.', enforcement: 'review', severity: 'warning', check: { kind: 'rubric', artifact: 'design', question: 'Does the design explain how to roll the change back?' }, source: src('100002', 'Describe how you would roll back') },
  { id: 'eng.secrets.none', title: 'No secrets in code', statement: 'Never commit credentials.', enforcement: 'ci', severity: 'blocking', check: { kind: 'pattern-forbid', paths: ['**/*.ts', '**/*.js', '**/*.py', '**/*.go'], pattern: '(AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)' }, source: src('100001', 'Credentials never go into source control') },
];
const pm = [
  { id: 'pm.prd.metrics', title: 'PRDs define success metrics', statement: 'Every PRD states measurable success metrics with targets.', enforcement: 'review', severity: 'blocking', check: { kind: 'rubric', artifact: 'prd', question: 'Does the PRD define measurable success metrics with targets?' }, source: src('300001', 'State how you will measure success') },
  { id: 'pm.prd.non-goals', title: 'PRDs list non-goals', statement: 'Every PRD lists what is out of scope.', enforcement: 'review', severity: 'warning', check: { kind: 'rubric', artifact: 'prd', question: 'Does the PRD list non-goals?' }, source: src('300001', 'List what you are not doing') },
];

const em = [
  { id: 'em.oneonone.not-evaluation', title: '1:1 briefs are preparation aids', statement: 'Use 1:1 briefs to prepare conversations, never as performance evidence or for pay and promotion decisions.', enforcement: 'advisory', severity: 'warning', source: src('400001', 'Briefs prepare a conversation; they are never performance evidence') },
  { id: 'em.oneonone.shared-evidence', title: 'Reports see the same evidence', statement: 'Share brief sources with the report and invite their context before the 1:1.', enforcement: 'advisory', severity: 'warning', source: src('400001', 'the report sees the same evidence') },
  { id: 'em.review.design-approval', title: 'Design approvals need a staff engineer', statement: 'Managers do not approve high-tier designs on behalf of a staff engineer.', enforcement: 'advisory', severity: 'warning', source: src('100002', 'High-risk designs are approved by a staff engineer') },
];

for (const [persona, rules] of [['engineer', engineer], ['project-manager', pm], ['engineering-manager', em]]) {
  const m = writeBundle(join(root, 'compiled', persona, '1.0.0'), {
    persona,
    version: '1.0.0',
    rules: rules.map((r) => ({ rationale: '', layer: 'base', ...r, appliesTo: { personas: [], tiers: all, artifacts: [], paths: [], ...(r.appliesTo ?? {}) } })),
    sources: [...new Set(rules.map((r) => r.source.pageId))].map((pageId) => ({ pageId, version: 1, title: `Page ${pageId}`, hash: 'sha256:example' })),
    compiler: { version: 'example', model: 'seed' },
  }, '2026-10-19T00:00:00.000Z');
  const file = join(root, 'personas', `${persona}.yaml`);
  const doc = parseDocument(readFileSync(file, 'utf8'));
  doc.setIn(['spec', 'constitution', 'sha256'], m.sha256);
  writeFileSync(file, doc.toString());
  console.log(`${persona}: ${m.sha256}`);
}
