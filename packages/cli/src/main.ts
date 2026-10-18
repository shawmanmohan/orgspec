/** Process entry shared by bin.ts (ESM) and the single executable. */
export async function main(argv: string[]): Promise<number> {
  const [cmd, event, ...rest] = argv;
  const io = { out: (t: string) => process.stdout.write(t), err: (t: string) => process.stderr.write(t) };
  // `orgspec hook pre-tool-use` runs on every Claude Code tool call, so it skips loading the full CLI.
  if (cmd === 'hook' && event) {
    if (event === 'pre-tool-use' && process.env.ORGSPEC_HOOK_MODE === 'socket') {
      const { hookViaSocket } = await import('./socket-client.js');
      return hookViaSocket(io);
    }
    const { runHook } = await import('@orgspec/app/hook');
    return runHook(event, rest, io);
  }
  const { run } = await import('./run.js');
  const { AppContext } = await import('@orgspec/app');
  return run(argv, { ...io, cwd: process.cwd() }, { context: () => new AppContext() });
}
