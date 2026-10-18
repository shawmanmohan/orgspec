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

export const SessionSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    status: z.string().default('unknown'),
    cwd: z.string().optional(),
    agent: z.string().optional(),
    startedAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .passthrough();
export type ClaudeSession = z.infer<typeof SessionSchema>;

/**
 * Background session control on top of the Claude CLI. Every command line lives here so a CLI
 * change touches one file.
 */
export function claudeSessions(runner: CommandRunner = runCommand, bin = CLAUDE_BIN) {
  const call = async (args: string[], cwd?: string) => {
    const r = await runner(bin, args, cwd ? { cwd } : {});
    if (r.code !== 0) throw new Error(`claude ${args.join(' ')} failed: ${r.stderr.trim() || r.stdout.trim()}`);
    return r.stdout;
  };
  return {
    async list(): Promise<ClaudeSession[]> {
      const out = await call(['agents', '--json', '--all']);
      const raw = JSON.parse(out || '[]') as unknown;
      const list = Array.isArray(raw) ? raw : ((raw as { agents?: unknown[] }).agents ?? []);
      return list.flatMap((s) => {
        const p = SessionSchema.safeParse(s);
        return p.success ? [p.data] : [];
      });
    },
    /** Starts a background session and returns its id. */
    async start(o: { cwd: string; agent: string; prompt: string; name: string }): Promise<string> {
      const out = await call(['--bg', '--agent', o.agent, '-n', o.name, o.prompt], o.cwd);
      const id = /([0-9a-f]{8}-[0-9a-f-]{27,})/i.exec(out)?.[1] ?? out.trim().split(/\s+/).pop();
      if (!id) throw new Error('claude --bg did not print a session id');
      return id;
    },
    logs: (id: string) => call(['agents', 'logs', id]),
    stop: (id: string) => call(['agents', 'stop', id]),
    respawn: (id: string) => call(['agents', 'respawn', id]),
    remove: (id: string) => call(['agents', 'rm', id]),
    /** The command a terminal runs to attach to a background session. */
    attachCommand: (id: string) => [bin, 'agents', 'attach', id],
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
export const interactiveCommand = (agent: string, prompt?: string, bin = CLAUDE_BIN): string[] => [
  bin,
  '--agent',
  agent,
  ...(prompt ? [prompt] : []),
];
