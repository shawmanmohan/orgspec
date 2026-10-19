import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '@orgspec/core';
import { changeStatus, findWorkspace, loadChange, taskProgress } from '@orgspec/spec-engine';
import type { HookInput, HookOutput } from './hook.js';
import {
  checkpointsDir,
  currentSession,
  findSessionFolder,
  latestCheckpoint,
  logAction,
  readActions,
  readSession,
  type TicketSession,
  writeSession,
} from './session.js';

const git = (cwd: string, args: string[]) =>
  spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 5000 }).stdout?.trim() ?? '';

/** A Markdown checkpoint of where the work stands, used to resume after compaction or a restart. */
export function renderCheckpoint(s: TicketSession, reason: string): string {
  const lines = [
    `# Checkpoint: ${s.ticket}`,
    '',
    `Reason: ${reason} · ${new Date().toISOString()} · persona ${s.persona} · tier ${s.tier}`,
    '',
  ];
  const primary = s.repos[0];
  if (s.change && primary) {
    try {
      const ws = findWorkspace(primary.path);
      const change = loadChange(ws, s.change);
      const st = changeStatus(change);
      lines.push(`## Change ${s.change}`, '');
      for (const a of st?.artifacts ?? []) lines.push(`- ${a.id}: ${a.state}`);
      if (st?.next) lines.push('', `Next artifact: ${st.next}`);
      const tasksFile = join(change.dir, 'tasks.md');
      if (existsSync(tasksFile)) {
        const tp = taskProgress(readFileSync(tasksFile, 'utf8'));
        lines.push('', `Tasks: ${tp.done}/${tp.total} done`);
        const open = readFileSync(tasksFile, 'utf8')
          .split('\n')
          .filter((l) => /^\s*- \[ \]/.test(l))
          .slice(0, 8);
        if (open.length) lines.push('', 'Open tasks:', ...open);
      }
      lines.push('');
    } catch (e) {
      lines.push(`Change ${s.change} could not be read: ${(e as Error).message}`, '');
    }
  }
  lines.push('## Repositories', '');
  for (const r of s.repos) {
    const status = git(r.path, ['status', '--short']).split('\n').filter(Boolean);
    const log = git(r.path, ['log', '--oneline', '-5', `${r.base}..HEAD`]);
    lines.push(
      `### ${r.slug} (${r.branch})`,
      '',
      status.length
        ? `Uncommitted: ${status.length} file(s)\n${status.slice(0, 15).join('\n')}`
        : 'Working tree clean.',
      '',
    );
    if (log) lines.push('Commits on this branch:', log, '');
  }
  const recent = readActions(s.folder, 15).filter((a) => a.kind !== 'checkpoint');
  if (recent.length) {
    lines.push('## Recent actions', '');
    for (const a of recent) lines.push(`- ${a.at.slice(11, 19)} ${a.decision ? `[${a.decision}] ` : ''}${a.summary}`);
    lines.push('');
  }
  return `${lines.join('\n').trim()}\n`;
}

export function writeCheckpoint(folder: string, reason: string): string {
  const s = currentSession(folder);
  const text = renderCheckpoint(s, reason);
  const file = join(checkpointsDir(folder), `${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
  writeFileAtomic(file, text);
  logAction(folder, { kind: 'checkpoint', summary: `${reason}: ${file}` });
  return file;
}

/** PreCompact, Stop and SessionEnd write a checkpoint; SessionStart (compact or resume) restores it. */
export async function checkpointHook(event: string, reason: string, input: HookInput): Promise<HookOutput | undefined> {
  const folder = findSessionFolder(input.cwd ?? process.cwd());
  if (!folder) return undefined;
  if (event === 'restore') {
    const cp = latestCheckpoint(folder);
    if (!cp) return undefined;
    return {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: `OrgSpec restored the last checkpoint for this ticket. Continue from here.\n\n${cp.text}`,
      },
    };
  }
  writeCheckpoint(folder, reason);
  if (event === 'session-end') {
    const s = readSession(folder);
    writeSession({ ...s, state: 'ended', ...(input.session_id ? { claudeSessionId: input.session_id } : {}) });
  } else if (input.session_id) {
    const s = readSession(folder);
    if (s.claudeSessionId !== input.session_id) writeSession({ ...s, claudeSessionId: input.session_id });
  }
  return undefined;
}
