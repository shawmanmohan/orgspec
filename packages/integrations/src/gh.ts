import { type CommandRunner, runCommand } from '@orgspec/core';

export const GH_BIN = process.env.ORGSPEC_GH_BIN ?? 'gh';

export interface GhAccount {
  host: string;
  login: string;
  active: boolean;
  state: string;
  tokenSource?: string;
  scopes?: string;
  gitProtocol?: string;
}

export class GhError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly stderr: string,
    readonly code: number,
  ) {
    super(`gh ${args.join(' ')} failed: ${stderr.trim().split('\n')[0] ?? ''}`);
  }
}

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  author?: string;
  reviewDecision?: string;
  updatedAt?: string;
  repo: string;
}

/**
 * Everything OrgSpec does on GitHub goes through the gh CLI (and git). Tokens stay with gh; OrgSpec
 * never reads them.
 */
export function gh(runner: CommandRunner = runCommand, bin = GH_BIN) {
  const call = async (args: string[], opts: { cwd?: string; input?: string; allowFail?: boolean } = {}) => {
    const r = await runner(bin, args, {
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.input !== undefined ? { input: opts.input } : {}),
    });
    if (r.code !== 0 && !opts.allowFail) throw new GhError(args, r.stderr || r.stdout, r.code);
    return r;
  };
  const json = async <T>(args: string[], cwd?: string): Promise<T> =>
    JSON.parse((await call(args, cwd ? { cwd } : {})).stdout || 'null') as T;

  return {
    async accounts(): Promise<GhAccount[]> {
      const r = await call(['auth', 'status', '--json', 'hosts'], { allowFail: true });
      if (!r.stdout.trim()) return [];
      const data = JSON.parse(r.stdout) as { hosts?: Record<string, Omit<GhAccount, 'host'>[]> };
      return Object.entries(data.hosts ?? {}).flatMap(([host, list]) => list.map((a) => ({ ...a, host })));
    },
    async activeAccount(host = 'github.com'): Promise<GhAccount | undefined> {
      return (await this.accounts()).find((a) => a.host === host && a.active);
    },
    switch: (login: string, host = 'github.com') =>
      call(['auth', 'switch', '--hostname', host, '--user', login]).then(() => undefined),
    logout: (login: string, host = 'github.com') =>
      call(['auth', 'logout', '--hostname', host, '--user', login]).then(() => undefined),
    setupGit: (host = 'github.com') => call(['auth', 'setup-git', '--hostname', host]).then(() => undefined),
    /** The interactive login command; run it in a terminal so the person completes the browser flow. */
    loginCommand: (host = 'github.com', scopes: string[] = ['repo', 'read:org']) => [
      bin,
      'auth',
      'login',
      '--hostname',
      host,
      '--web',
      '--git-protocol',
      'https',
      '--scopes',
      scopes.join(','),
    ],

    async prList(
      repo: string,
      opts: { author?: string; search?: string; state?: 'open' | 'closed' | 'merged' | 'all'; limit?: number } = {},
    ): Promise<PullRequest[]> {
      const args = ['pr', 'list', '--repo', repo, '--state', opts.state ?? 'open', '--limit', String(opts.limit ?? 50)];
      if (opts.author) args.push('--author', opts.author);
      if (opts.search) args.push('--search', opts.search);
      args.push('--json', 'number,title,url,state,isDraft,headRefName,baseRefName,author,reviewDecision,updatedAt');
      const list = await json<(Omit<PullRequest, 'author' | 'repo'> & { author?: { login: string } })[]>(args);
      return (list ?? []).map((p) => ({ ...p, author: p.author?.login, repo }) as PullRequest);
    },
    async prView(
      repo: string,
      ref: string | number,
    ): Promise<PullRequest & { body: string; files: string[]; headRefOid: string }> {
      const p = await json<Record<string, unknown>>([
        'pr',
        'view',
        String(ref),
        '--repo',
        repo,
        '--json',
        'number,title,url,state,isDraft,headRefName,baseRefName,author,reviewDecision,updatedAt,body,files,headRefOid',
      ]);
      return {
        ...(p as unknown as PullRequest & { body: string; headRefOid: string }),
        author: (p.author as { login?: string } | undefined)?.login,
        files: ((p.files as { path: string }[] | undefined) ?? []).map((f) => f.path),
        repo,
      } as PullRequest & { body: string; files: string[]; headRefOid: string };
    },
    async prCreate(o: { cwd: string; title: string; body: string; base?: string; draft?: boolean }): Promise<string> {
      const args = ['pr', 'create', '--title', o.title, '--body-file', '-'];
      if (o.base) args.push('--base', o.base);
      if (o.draft ?? true) args.push('--draft');
      return (await call(args, { cwd: o.cwd, input: o.body })).stdout.trim();
    },
    async api<T = unknown>(
      path: string,
      opts: { method?: string; fields?: Record<string, string>; host?: string } = {},
    ): Promise<T> {
      const args = ['api', path];
      if (opts.method) args.push('--method', opts.method);
      if (opts.host) args.push('--hostname', opts.host);
      for (const [k, v] of Object.entries(opts.fields ?? {})) args.push('-f', `${k}=${v}`);
      return json<T>(args);
    },
    /** Login of the account that authored a commit, from the GitHub API (used to verify approvals). */
    async commitAuthor(repo: string, sha: string): Promise<string | undefined> {
      const c = await json<{ author?: { login?: string } | null }>(['api', `repos/${repo}/commits/${sha}`]).catch(
        () => undefined,
      );
      return c?.author?.login ?? undefined;
    },
    async teamMembers(org: string, team: string): Promise<string[]> {
      const list = await json<{ login: string }[]>(['api', `orgs/${org}/teams/${team}/members`, '--paginate']);
      return (list ?? []).map((m) => m.login);
    },
    clone: (repo: string, dir: string) => call(['repo', 'clone', repo, dir]).then(() => undefined),
  };
}
export type Gh = ReturnType<typeof gh>;

/** Owner of a GitHub remote URL (`https://github.com/acme/pay.git`, `git@github.com:acme/pay.git`). */
export function remoteOwner(url: string): { host: string; owner: string; repo: string } | undefined {
  const m = /^(?:https?:\/\/|ssh:\/\/git@|git@)([^/:]+)[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? { host: m[1] as string, owner: m[2] as string, repo: m[3] as string } : undefined;
}

/** The gh account mapped to a repo's owner in settings (`github.com/acme` → login). */
export function accountForRepo(orgAccounts: Record<string, string>, host: string, owner: string): string | undefined {
  return orgAccounts[`${host}/${owner}`] ?? orgAccounts[owner];
}

/** Switches gh to the mapped account for a repo when automatic switching is on. Returns the login now active. */
export async function ensureAccount(
  g: Gh,
  settings: { autoSwitch: boolean; orgAccounts: Record<string, string> },
  target: { host: string; owner: string },
): Promise<{ login?: string; switched: boolean; mismatch?: string }> {
  const want = accountForRepo(settings.orgAccounts, target.host, target.owner);
  const active = await g.activeAccount(target.host);
  if (!want || active?.login === want) return { ...(active?.login ? { login: active.login } : {}), switched: false };
  if (!settings.autoSwitch) {
    return {
      ...(active?.login ? { login: active.login } : {}),
      switched: false,
      mismatch: `gh is signed in as ${active?.login ?? 'nobody'}; ${target.owner} uses ${want}`,
    };
  }
  await g.switch(want, target.host);
  return { login: want, switched: true };
}

/** git through the same runner. */
export function git(runner: CommandRunner = runCommand) {
  const call = async (cwd: string, args: string[]) => {
    const r = await runner('git', args, { cwd });
    if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim()}`);
    return r.stdout.trim();
  };
  return {
    call,
    currentBranch: (cwd: string) => call(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
    head: (cwd: string) => call(cwd, ['rev-parse', 'HEAD']),
    remoteUrl: (cwd: string, remote = 'origin') => call(cwd, ['remote', 'get-url', remote]),
    changedFiles: async (cwd: string, base: string) =>
      (await call(cwd, ['diff', '--name-only', `${base}...HEAD`])).split('\n').filter(Boolean),
    worktreeAdd: (cwd: string, dir: string, branch: string, base: string) =>
      call(cwd, ['worktree', 'add', '-B', branch, dir, base]),
    worktreeRemove: (cwd: string, dir: string) => call(cwd, ['worktree', 'remove', '--force', dir]),
    fetch: (cwd: string) => call(cwd, ['fetch', '--quiet', 'origin']),
    pull: (cwd: string) => call(cwd, ['pull', '--ff-only', '--quiet']),
    /** Commits that last touched a file, with author login emails, for approval verification. */
    logForFile: async (cwd: string, file: string) =>
      (await call(cwd, ['log', '--format=%H%x09%ae%x09%an', '--', file]))
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          const [sha, email, name] = l.split('\t');
          return { sha: sha ?? '', email: email ?? '', name: name ?? '' };
        }),
    status: (cwd: string) => call(cwd, ['status', '--porcelain']),
  };
}
export type Git = ReturnType<typeof git>;
