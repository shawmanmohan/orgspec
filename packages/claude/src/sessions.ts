import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { type CommandRunner, runCommand, spawnDetached, writeFileAtomic } from '@orgspec/core';
import { z } from 'zod';
import { CLAUDE_BIN } from './jobs.js';

export const MIN_CLAUDE_VERSION = '2.1.282';

const cmp = (a: string, b: string): number => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
};

export async function claudeVersion(
  runner: CommandRunner = runCommand,
  bin = CLAUDE_BIN,
): Promise<{ version?: string; ok: boolean; message: string }> {
  const r = await runner(bin, ['--version']);
  if (r.code !== 0) return { ok: false, message: 'Claude Code is not installed or not on PATH' };
  const version = /(\d+\.\d+\.\d+)/.exec(r.stdout)?.[1];
  if (!version) return { ok: false, message: `Cannot read the Claude Code version from "${r.stdout.trim()}"` };
  const ok = cmp(version, MIN_CLAUDE_VERSION) >= 0;
  return {
    version,
    ok,
    message: ok
      ? `Claude Code ${version}`
      : `Claude Code ${version} is older than ${MIN_CLAUDE_VERSION}; run claude update`,
  };
}

/** One row of `claude agents --json`; the CLI reports `sessionId`, epoch-ms `startedAt` and `kind`. */
const RawSessionSchema = z
  .object({
    id: z.string().optional(),
    shortId: z.string().optional(),
    sessionId: z.string().optional(),
    name: z.string().optional(),
    status: z.string().optional(),
    kind: z.string().optional(),
    cwd: z.string().optional(),
    pid: z.number().optional(),
    startedAt: z.union([z.number(), z.string()]).optional(),
  })
  .passthrough();

export interface ClaudeSession {
  /** The id `claude attach|logs|stop|rm` accept: the short id when the CLI gives one, else the session id. */
  id: string;
  sessionId?: string;
  name?: string;
  status: string;
  kind?: string;
  cwd?: string;
  startedAt?: string;
}

export function normalizeSession(raw: unknown): ClaudeSession | undefined {
  const p = RawSessionSchema.safeParse(raw);
  if (!p.success) return undefined;
  const r = p.data;
  const id = r.shortId ?? r.id ?? r.sessionId;
  if (!id) return undefined;
  const started = typeof r.startedAt === 'number' ? new Date(r.startedAt).toISOString() : r.startedAt;
  return {
    id,
    status: r.status ?? 'unknown',
    ...(r.sessionId ? { sessionId: r.sessionId } : {}),
    ...(r.name ? { name: r.name } : {}),
    ...(r.kind ? { kind: r.kind } : {}),
    ...(r.cwd ? { cwd: r.cwd } : {}),
    ...(started ? { startedAt: started } : {}),
  };
}

/** The session id `claude --bg` prints: a UUID, or the short id on an "id"/"started" line, or the last word. */
export function parseBackgroundId(out: string): string | undefined {
  const uuid = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i.exec(out)?.[1];
  if (uuid) return uuid;
  // `backgrounded · 72f13a80 · NAME` and `claude attach 72f13a80`
  const shown =
    /backgrounded\s*·\s*([A-Za-z0-9_-]{4,})/.exec(out)?.[1] ?? /claude attach ([A-Za-z0-9_-]{4,})/.exec(out)?.[1];
  if (shown) return shown;
  return out.trim().split(/\s+/).pop() || undefined;
}

/**
 * Background session control on top of the Claude CLI (`claude --bg`, `claude agents --json`,
 * `claude attach|logs|stop|respawn|rm`). Every command line lives here so a CLI change touches one file.
 */
export function claudeSessions(runner: CommandRunner = runCommand, bin = CLAUDE_BIN) {
  const call = async (args: string[], cwd?: string) => {
    const r = await runner(bin, args, cwd ? { cwd } : {});
    if (r.code !== 0) throw new Error(`claude ${args.join(' ')} failed: ${r.stderr.trim() || r.stdout.trim()}`);
    return r.stdout;
  };
  return {
    /** Sessions started under `cwd` (OrgSpec passes its ticket root, so other projects stay private). */
    async list(cwd?: string): Promise<ClaudeSession[]> {
      const out = await call(['agents', '--json', '--all', ...(cwd ? ['--cwd', cwd] : [])]);
      const raw = JSON.parse(out || '[]') as unknown;
      const list = Array.isArray(raw) ? raw : ((raw as { agents?: unknown[] }).agents ?? []);
      return list.flatMap((s) => normalizeSession(s) ?? []);
    },
    /** Starts a background session and returns its id. */
    async start(o: { cwd: string; agent: string; prompt: string; name: string; mcpConfig?: string }): Promise<string> {
      const out = await call(['--bg', '--agent', o.agent, '-n', o.name, ...gatewayArgs(o.mcpConfig), o.prompt], o.cwd);
      const id = parseBackgroundId(out);
      if (!id) throw new Error('claude --bg did not print a session id');
      return id;
    },
    logs: (id: string) => call(['logs', id]),
    stop: (id: string) => call(['stop', id]),
    respawn: (id: string) => call(['respawn', id]),
    remove: (id: string) => call(['rm', id]),
    /** The command a terminal runs to attach to a background session. */
    attachCommand: (id: string) => [bin, 'attach', id],
  };
}
export type ClaudeSessions = ReturnType<typeof claudeSessions>;

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Opens a terminal window running a command in a folder. On macOS a `.command` script is opened
 * with the chosen terminal app; elsewhere `x-terminal-emulator` is used.
 */
export function openTerminal(o: {
  app: 'Terminal' | 'iTerm2' | 'Ghostty';
  cwd: string;
  command: string[];
  scriptDir: string;
  name: string;
}): string {
  const script = join(o.scriptDir, `${o.name.replace(/[^a-zA-Z0-9_-]/g, '_')}.command`);
  writeFileAtomic(
    script,
    `#!/bin/sh\ncd ${shellQuote(o.cwd)} || exit 1\nexec ${o.command.map(shellQuote).join(' ')}\n`,
  );
  chmodSync(script, 0o700);
  if (process.platform === 'darwin') {
    const app = o.app === 'iTerm2' ? 'iTerm' : o.app;
    spawnDetached('open', ['-a', app, script]);
  } else {
    spawnDetached('x-terminal-emulator', ['-e', script]);
  }
  return script;
}

/** The command line for an interactive Claude Code session with an agent and opening prompt. */
export const interactiveCommand = (
  agent: string,
  prompt?: string,
  o: { mcpConfig?: string; bin?: string } = {},
): string[] => [o.bin ?? CLAUDE_BIN, '--agent', agent, ...gatewayArgs(o.mcpConfig), ...(prompt ? [prompt] : [])];

/**
 * Loads only the OrgSpec gateway, from a config passed on the command line: no project `.mcp.json`
 * approval dialog, and no other MCP server. `--strict-mcp-config` also ends the variadic list, so a
 * prompt after it stays a prompt.
 */
export const gatewayArgs = (mcpConfig?: string): string[] =>
  mcpConfig ? ['--mcp-config', mcpConfig, '--strict-mcp-config'] : [];
