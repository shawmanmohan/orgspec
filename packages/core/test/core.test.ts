import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendAudit,
  CORE_MIGRATIONS,
  dataKey,
  decrypt,
  encrypt,
  extractJson,
  fileKeyStore,
  inWindow,
  loadOrgConfig,
  loadSettings,
  matchesGlob,
  openDb,
  parseDuration,
  updateSettings,
  verifyAudit,
} from '../src/index.js';

const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'orgspec-core-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('durations and windows', () => {
  it('parses durations', () => {
    expect(parseDuration('2m')).toBe(120_000);
    expect(parseDuration('24h')).toBe(86_400_000);
    expect(() => parseDuration('soon')).toThrow();
  });
  it('handles windows that cross midnight', () => {
    expect(inWindow(new Date('2026-10-19T20:00:00'), '19:00', '09:00')).toBe(true);
    expect(inWindow(new Date('2026-10-19T12:00:00'), '19:00', '09:00')).toBe(false);
    expect(inWindow(new Date('2026-10-19T10:00:00'), '09:00', '18:00')).toBe(true);
  });
});

describe('glob', () => {
  it('matches ** across segments and * within one', () => {
    expect(matchesGlob('src/auth/login.ts', 'src/auth/**')).toBe(true);
    expect(matchesGlob('src/auth/a/b.ts', 'src/auth/**')).toBe(true);
    expect(matchesGlob('src/authz/x.ts', 'src/auth/**')).toBe(false);
    expect(matchesGlob('.github/workflows/ci.yml', '.github/**')).toBe(true);
    expect(matchesGlob('a/b.ts', '*.ts')).toBe(false);
    expect(matchesGlob('b.ts', '*.ts')).toBe(true);
    expect(matchesGlob('db/migrations/001.sql', '**/migrations/**')).toBe(true);
  });
});

describe('store and audit', () => {
  it('migrates and keeps a verifiable hash chain', () => {
    const db = openDb(':memory:', CORE_MIGRATIONS);
    appendAudit(db, { tool: 'jira__get_issue', decision: 'allow' });
    appendAudit(db, { tool: 'jira__create_issue', decision: 'confirm' });
    expect(verifyAudit(db)).toBeUndefined();
    db.prepare('update audit set record = \'{"tool":"x"}\' where seq = 1').run();
    expect(verifyAudit(db)).toBe(1);
  });
});

describe('secrets', () => {
  it('creates one data key and round-trips ciphertext', async () => {
    const store = fileKeyStore(join(temp(), 'keys.json'));
    const key = await dataKey(store);
    expect((await dataKey(store)).equals(key)).toBe(true);
    const sealed = encrypt(key, 'private note');
    expect(sealed).not.toContain('private');
    expect(decrypt(key, sealed)).toBe('private note');
    expect(() => decrypt(Buffer.alloc(32), sealed)).toThrow();
  });
});

describe('json extraction', () => {
  it('reads fenced or bare JSON from model output', () => {
    expect(extractJson('Here:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('result {"a":{"b":"}"}} trailing')).toEqual({ a: { b: '}' } });
    expect(() => extractJson('no json')).toThrow();
  });
});

describe('org config', () => {
  it('loads personas, overlays, sync defaults and reports invalid files', () => {
    const dir = temp();
    mkdirSync(join(dir, 'personas'));
    mkdirSync(join(dir, 'constitution', 'overlays'), { recursive: true });
    writeFileSync(
      join(dir, 'personas', 'ic.yaml'),
      `apiVersion: orgspec/v1
kind: Persona
metadata: { id: individual-contributor, name: Individual contributor, version: 1.0.0 }
spec:
  constitution: { bundle: compiled/individual-contributor/1.0.0, sha256: "sha256:${'a'.repeat(64)}" }
  agents: [{ id: ic-implementer, model: sonnet }]
  mcp: [{ server: jira, tools: [get_issue, create_issue], confirm: [create_issue] }]
`,
    );
    writeFileSync(join(dir, 'personas', 'bad.yaml'), 'apiVersion: orgspec/v1\nkind: Persona\n');
    writeFileSync(
      join(dir, 'constitution', 'base.yaml'),
      'apiVersion: orgspec/v1\nkind: ConstitutionOverlay\nmetadata: { id: base, version: 1.0.0 }\nspec: { layer: base }\n',
    );
    writeFileSync(join(dir, 'sync.yaml'), 'sources:\n  jira.active: { every: 5m, min: 1m, max: 15m }\n');
    const cfg = loadOrgConfig(dir);
    expect(cfg.personas.map((p) => p.metadata.id)).toEqual(['individual-contributor']);
    expect(cfg.diagnostics.some((d) => d.path?.endsWith('bad.yaml'))).toBe(true);
    expect(cfg.overlays[0]?.spec.layer).toBe('base');
    expect(cfg.sync.sources['jira.active']?.every).toBe('5m');
    expect(cfg.sync.sources['slack.dms']?.offHours).toBe('pause');
  });
});

describe('settings', () => {
  it('fills defaults and persists updates', () => {
    const file = join(temp(), 'settings.json');
    expect(loadSettings(file).workRoot).toBe('~/orgspec-tickets');
    updateSettings(file, (s) => ({ ...s, github: { ...s.github, orgAccounts: { 'github.com/acme': 'asha-work' } } }));
    expect(loadSettings(file).github.orgAccounts).toEqual({ 'github.com/acme': 'asha-work' });
  });
});
