import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { agentsFor, renderAgent } from '@orgspec/claude';
import { nowIso, writeFileAtomic } from '@orgspec/core';
import type { z } from 'zod';
import type { AppContext } from './context.js';

export interface JobRow {
  id: string;
  kind: string;
  folder: string;
  state: 'queued' | 'running' | 'done' | 'failed';
  input?: string;
  result?: string;
  error?: string;
  attempts: number;
  created_at: string;
  started_at?: string;
  finished_at?: string;
}

/**
 * Runs one `claude -p --agent <agent>` job in its own folder under the local jobs directory, with
 * the agent file written there, and records it in the jobs table for the dashboard.
 */
export async function runAgentJob<S extends z.ZodTypeAny>(
  ctx: AppContext,
  o: { kind: string; agent: string; prompt: string; schema: S; input?: unknown; model?: string },
): Promise<{ id: string; data: z.output<S>; costUsd: number }> {
  const id = `job_${randomUUID().slice(0, 12)}`;
  const folder = join(ctx.paths.jobs, id);
  const def = agentsFor(ctx.persona()).find((a) => a.id === o.agent) ?? {
    id: o.agent,
    description: '',
    model: '',
    skills: [],
    disallowedTools: [],
  };
  writeFileAtomic(join(folder, '.claude', 'agents', `${o.agent}.md`), renderAgent(def));
  writeFileAtomic(join(folder, 'prompt.md'), o.prompt);
  const db = ctx.db();
  db.prepare(
    'insert into jobs (id, kind, folder, state, input, created_at, started_at) values (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    id,
    o.kind,
    folder,
    'running',
    o.input === undefined ? null : JSON.stringify(o.input).slice(0, 50_000),
    nowIso(),
    nowIso(),
  );
  try {
    const r = await ctx.jobs.run({
      agent: o.agent,
      prompt: o.prompt,
      schema: o.schema,
      cwd: folder,
      logDir: join(folder, 'log'),
      ...(o.model ? { model: o.model } : {}),
    });
    db.prepare('update jobs set state = ?, result = ?, attempts = ?, finished_at = ? where id = ?').run(
      'done',
      JSON.stringify(r.data).slice(0, 200_000),
      r.attempts,
      nowIso(),
      id,
    );
    return { id, data: r.data, costUsd: r.costUsd };
  } catch (e) {
    db.prepare('update jobs set state = ?, error = ?, finished_at = ? where id = ?').run(
      'failed',
      (e as Error).message,
      nowIso(),
      id,
    );
    throw e;
  }
}

export function listJobs(ctx: AppContext, limit = 50): JobRow[] {
  return ctx.db().prepare('select * from jobs order by created_at desc limit ?').all(limit) as unknown as JobRow[];
}

/** Builds a prompt with the untrusted material fenced off as data. */
export const promptWith = (instructions: string, sections: Record<string, string>): string =>
  [
    instructions.trim(),
    ...Object.entries(sections).map(
      ([name, body]) => `<untrusted source="${name}">\n${body.replace(/<\/?\s*untrusted[^>]*>/gi, '')}\n</untrusted>`,
    ),
  ].join('\n\n');
