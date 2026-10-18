import { spawn } from 'node:child_process';

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a program with arguments (never through a shell). Injectable so tests can fake `claude`, `gh` and `git`. */
export type CommandRunner = (command: string, args: readonly string[], options?: ExecOptions) => Promise<ExecResult>;

export const runCommand: CommandRunner = (command, args, options = {}) =>
  new Promise((resolve) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timer: NodeJS.Timeout | undefined;
    if (options.timeoutMs) {
      timer = setTimeout(() => child.kill('SIGTERM'), options.timeoutMs);
    }
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: `${stderr}${err.message}` });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });

/** Starts a long-lived program detached from this process (terminal windows, background sessions). */
export function spawnDetached(command: string, args: readonly string[], cwd?: string): void {
  const child = spawn(command, [...args], { cwd, detached: true, stdio: 'ignore' });
  child.unref();
}

/** A fake runner for tests: answers by matching `command args...` against handlers in order. */
export function fakeRunner(
  handlers: {
    match: (command: string, args: readonly string[]) => boolean;
    result: ExecResult | ((args: readonly string[], options?: ExecOptions) => ExecResult);
  }[],
): CommandRunner & { calls: { command: string; args: readonly string[]; options?: ExecOptions }[] } {
  const calls: { command: string; args: readonly string[]; options?: ExecOptions }[] = [];
  const fn = (async (command: string, args: readonly string[], options?: ExecOptions) => {
    calls.push({ command, args, ...(options ? { options } : {}) });
    const h = handlers.find((x) => x.match(command, args));
    if (!h) return { code: 127, stdout: '', stderr: `no fake for ${command} ${args.join(' ')}` };
    return typeof h.result === 'function' ? h.result(args, options) : h.result;
  }) as CommandRunner & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}
