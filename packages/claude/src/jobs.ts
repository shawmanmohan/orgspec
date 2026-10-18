import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type CommandRunner, extractJson, runCommand, writeFileAtomic } from '@orgspec/core';
import type { z } from 'zod';

export const CLAUDE_BIN = process.env.ORGSPEC_CLAUDE_BIN ?? 'claude';

/** What `claude -p --output-format json` prints. */
interface ClaudeResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
  num_turns?: number;
}

export interface JobSpec<S extends z.ZodTypeAny> {
  /** Agent file name under `.claude/agents/` in `cwd`. */
  agent: string;
  prompt: string;
  schema: S;
  cwd: string;
  model?: string;
  maxTurns?: number;
  timeoutMs?: number;
  /** Where to keep the raw transcript of each attempt (for the job log and debugging). */
  logDir?: string;
}

export interface JobResult<T> {
  data: T;
  sessionId?: string;
  costUsd: number;
  attempts: number;
}

export class ClaudeJobError extends Error {
  constructor(
    message: string,
    readonly attempts: number,
    readonly lastOutput: string,
  ) {
    super(message);
  }
}

/**
 * Runs a non-interactive Claude job and returns validated JSON. Every OrgSpec model call goes
 * through here: `claude -p --agent <name>`. Invalid output gets one retry with the validation errors.
 */
export interface ClaudeJobs {
  run<S extends z.ZodTypeAny>(spec: JobSpec<S>): Promise<JobResult<z.output<S>>>;
}

export function claudeJobs(runner: CommandRunner = runCommand, bin = CLAUDE_BIN): ClaudeJobs {
  return {
    async run<S extends z.ZodTypeAny>(spec: JobSpec<S>): Promise<JobResult<z.output<S>>> {
      let prompt = spec.prompt;
      let cost = 0;
      let last = '';
      for (let attempt = 1; attempt <= 2; attempt++) {
        const args = ['-p', '--agent', spec.agent, '--output-format', 'json'];
        if (spec.model) args.push('--model', spec.model);
        if (spec.maxTurns) args.push('--max-turns', String(spec.maxTurns));
        const res = await runner(bin, args, {
          cwd: spec.cwd,
          input: prompt,
          timeoutMs: spec.timeoutMs ?? 10 * 60_000,
        });
        last = res.stdout || res.stderr;
        if (spec.logDir) {
          mkdirSync(spec.logDir, { recursive: true });
          writeFileAtomic(
            join(spec.logDir, `attempt-${attempt}.json`),
            JSON.stringify({ args, code: res.code, stdout: res.stdout, stderr: res.stderr }, null, 2),
          );
        }
        if (res.code !== 0) {
          throw new ClaudeJobError(`claude exited with ${res.code}: ${res.stderr.trim().slice(0, 500)}`, attempt, last);
        }
        let envelope: ClaudeResult;
        try {
          envelope = JSON.parse(res.stdout) as ClaudeResult;
        } catch {
          envelope = { result: res.stdout };
        }
        cost += envelope.total_cost_usd ?? 0;
        if (envelope.is_error)
          throw new ClaudeJobError(
            `claude reported an error: ${envelope.subtype ?? envelope.result ?? 'unknown'}`,
            attempt,
            last,
          );

        let problem: string;
        try {
          const parsed = spec.schema.safeParse(extractJson(envelope.result ?? ''));
          if (parsed.success) {
            return {
              data: parsed.data,
              ...(envelope.session_id ? { sessionId: envelope.session_id } : {}),
              costUsd: cost,
              attempts: attempt,
            };
          }
          problem = parsed.error.issues
            .slice(0, 10)
            .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
            .join('\n');
        } catch (e) {
          problem = (e as Error).message;
        }
        prompt = `${spec.prompt}\n\nYour previous answer could not be used:\n${problem}\n\nReply with only the corrected JSON, in a \`\`\`json block.`;
      }
      throw new ClaudeJobError('claude returned invalid output twice', 2, last);
    },
  };
}

/** A scripted stand-in for tests and offline demos: answers by agent name. */
export function fakeJobs(
  answers: Record<string, unknown | ((prompt: string) => unknown)>,
): ClaudeJobs & { calls: { agent: string; prompt: string }[] } {
  const calls: { agent: string; prompt: string }[] = [];
  return {
    calls,
    async run<S extends z.ZodTypeAny>(spec: JobSpec<S>): Promise<JobResult<z.output<S>>> {
      calls.push({ agent: spec.agent, prompt: spec.prompt });
      const a = answers[spec.agent];
      if (a === undefined) throw new ClaudeJobError(`no fake answer for ${spec.agent}`, 1, '');
      const value = typeof a === 'function' ? (a as (p: string) => unknown)(spec.prompt) : a;
      return { data: spec.schema.parse(value), costUsd: 0, attempts: 1 };
    },
  };
}
