import { relative } from 'node:path';
import type { AppContext } from './context.js';

/**
 * Opens a pull request for files already written in a local clone: a new branch from the current
 * one, a commit of exactly those files, a push, and `gh pr create`. Returns the PR URL. Everything runs
 * as the person, with their gh account.
 */
export async function proposeChange(
  ctx: AppContext,
  repoDir: string,
  o: { branch: string; files: string[]; message: string; title: string; body: string; draft?: boolean },
): Promise<string> {
  const g = ctx.git;
  const start = await g.currentBranch(repoDir).catch(() => 'main');
  const branch = o.branch.replace(/[^A-Za-z0-9/._-]/g, '-').slice(0, 80);
  await g.call(repoDir, ['checkout', '-B', branch]);
  try {
    await g.call(repoDir, ['add', '--', ...o.files.map((f) => relative(repoDir, f) || f)]);
    await g.call(repoDir, ['commit', '-m', o.message]);
    await g.call(repoDir, ['push', '-u', 'origin', branch]);
    return await ctx.gh.prCreate({ cwd: repoDir, title: o.title, body: o.body, base: start, draft: o.draft ?? false });
  } finally {
    await g.call(repoDir, ['checkout', start]).catch(() => undefined);
  }
}
