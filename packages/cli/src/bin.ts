#!/usr/bin/env node
// `orgspec hook pre-tool-use` runs on every Claude Code tool call, so it skips loading the full CLI.
const [cmd, event, ...rest] = process.argv.slice(2);
if (cmd === 'hook' && event) {
  const io = { out: (t: string) => process.stdout.write(t), err: (t: string) => process.stderr.write(t) };
  if (event === 'pre-tool-use' && process.env.ORGSPEC_HOOK_MODE === 'socket') {
    const { hookViaSocket } = await import('./socket-client.js');
    process.exitCode = await hookViaSocket(io);
  } else {
    const { runHook } = await import('@orgspec/app/hook');
    process.exitCode = await runHook(event, rest, io);
  }
} else {
  const { run } = await import('./run.js');
  const { AppContext } = await import('@orgspec/app');
  process.exitCode = await run(
    process.argv.slice(2),
    { out: (text) => process.stdout.write(text), err: (text) => process.stderr.write(text), cwd: process.cwd() },
    { context: () => new AppContext() },
  );
}
