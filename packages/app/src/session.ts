import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// Light module: the hook reads session.json on every tool call, so only node builtins are imported here.

export const SESSION_FILE = 'session.json';
export const HOOK_RULES_FILE = 'hook-rules.json';

export interface SessionRepo {
  slug: string;
  host: string;
  owner: string;
  name: string;
  /** Worktree inside the ticket folder. */
  path: string;
  branch: string;
  base: string;
  /** gh account mapped to this repo's owner. */
  ghAccount?: string;
}

export interface TicketSession {
  id: string;
  ticket: string;
  persona: string;
  tier: 'low' | 'medium' | 'high';
  folder: string;
  repos: SessionRepo[];
  /** Change id inside the primary repo's orgspec/changes, when one exists. */
  change?: string;
  bundle: { persona: string; version: string; sha256: string };
  protectedBranches: string[];
  claudeSessionId?: string;
  state: 'active' | 'ended';
  createdAt: string;
  updatedAt: string;
}

/** The compact rule subset the hook evaluates, written at packet time. */
export interface HookRules {
  bundle: string;
  rules: unknown[];
}

export function findSessionFolder(start: string): string | undefined {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, SESSION_FILE))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function readSession(folder: string): TicketSession {
  return JSON.parse(readFileSync(join(folder, SESSION_FILE), 'utf8')) as TicketSession;
}

const atomic = (file: string, text: string) => {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
};

export function writeSession(s: TicketSession): void {
  atomic(join(s.folder, SESSION_FILE), `${JSON.stringify({ ...s, updatedAt: new Date().toISOString() }, null, 2)}\n`);
}

export function readHookRules(folder: string): HookRules | undefined {
  const f = join(folder, HOOK_RULES_FILE);
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as HookRules) : undefined;
}

export function writeHookRules(folder: string, rules: HookRules): void {
  atomic(join(folder, HOOK_RULES_FILE), `${JSON.stringify(rules)}\n`);
}

const stateDir = (folder: string) => join(folder, '.orgspec');

export interface ActionEntry {
  at: string;
  kind: 'tool' | 'decision' | 'checkpoint' | 'session' | 'note';
  tool?: string;
  decision?: string;
  ruleId?: string;
  summary: string;
}

/** Appends to the ticket's action log (`.orgspec/actions.jsonl`). */
export function logAction(folder: string, entry: Omit<ActionEntry, 'at'>): void {
  mkdirSync(stateDir(folder), { recursive: true });
  appendFileSync(
    join(stateDir(folder), 'actions.jsonl'),
    `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
  );
}

export function readActions(folder: string, limit = 200): ActionEntry[] {
  const f = join(stateDir(folder), 'actions.jsonl');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8')
    .split('\n')
    .filter(Boolean)
    .slice(-limit)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as ActionEntry];
      } catch {
        return [];
      }
    });
}

export const checkpointsDir = (folder: string) => join(stateDir(folder), 'checkpoints');

export function latestCheckpoint(folder: string): { file: string; text: string } | undefined {
  const dir = checkpointsDir(folder);
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort();
  const last = files.at(-1);
  return last ? { file: join(dir, last), text: readFileSync(join(dir, last), 'utf8') } : undefined;
}

const TIER_LINE = /^tier:\s*(low|medium|high)\s*$/m;

/**
 * The session with its change and tier read live from the primary repo, so a change created or
 * re-tiered after the packet is enforced at its current tier. Builtins only: the hook calls this.
 */
export function currentSession(folder: string): TicketSession {
  const s = readSession(folder);
  const primary = s.repos[0];
  if (!primary) return s;
  const changes = join(primary.path, 'orgspec', 'changes');
  if (!existsSync(changes)) return s;
  const change =
    s.change && existsSync(join(changes, s.change, 'change.yaml'))
      ? s.change
      : readdirSync(changes).find(
          (d) => (d === s.ticket || d.startsWith(`${s.ticket}-`)) && existsSync(join(changes, d, 'change.yaml')),
        );
  if (!change) return s;
  const tier = TIER_LINE.exec(readFileSync(join(changes, change, 'change.yaml'), 'utf8'))?.[1] as
    | TicketSession['tier']
    | undefined;
  return { ...s, change, ...(tier ? { tier } : {}) };
}
