import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { interactiveCommand, openTerminal, writeClaudeFolder } from '@orgspec/claude';
import { exists, writeFileAtomic } from '@orgspec/core';
import { ensureAccount, type JiraIssue, remoteOwner } from '@orgspec/integrations';
import { findWorkspace, listChangeIds, loadChange } from '@orgspec/spec-engine';
import type { AppContext } from './context.js';
import { readSession, type SessionRepo, type TicketSession, writeHookRules, writeSession } from './session.js';

export interface PacketOptions {
  ticket: string;
  /** Repo slugs (`owner/name`) from settings; defaults to all configured repos. */
  repos?: string[];
  persona?: string;
  launch?: 'interactive' | 'background' | 'none';
  /** Skip Jira (offline or tests). */
  issue?: Pick<JiraIssue, 'key' | 'summary' | 'status'> & { description?: string };
  base?: string;
}

export interface Packet {
  session: TicketSession;
  folder: string;
  warnings: string[];
  claudeSession?: string;
  terminalScript?: string;
}

const DEFAULT_PROTECTED = ['main', 'master', 'release/*'];

async function defaultBase(ctx: AppContext, repoPath: string): Promise<string> {
  const head = await ctx.git.call(repoPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).catch(() => '');
  return head || 'origin/main';
}

/** Makes sure a base clone exists for a repo and returns its path. */
async function baseClone(ctx: AppContext, slug: string, path?: string): Promise<string> {
  if (path && exists(join(path, '.git'))) return path;
  const dir = join(ctx.workRoot, '.repos', slug);
  if (!exists(join(dir, '.git'))) await ctx.gh.clone(slug, dir);
  return dir;
}

function renderPacketMd(s: TicketSession, issue: PacketOptions['issue'], warnings: string[]): string {
  return `# ${s.ticket}${issue?.summary ? `: ${issue.summary}` : ''}

Persona: ${s.persona} · Tier: ${s.tier} · Constitution: ${s.bundle.persona} ${s.bundle.version}
${issue?.status ? `Jira status: ${issue.status}\n` : ''}
## Repositories

${s.repos.map((r) => `- ${r.slug} → \`repos/${r.name}\` on branch \`${r.branch}\` (base ${r.base})${r.ghAccount ? `, gh account ${r.ghAccount}` : ''}`).join('\n')}

## How to work here

1. ${s.change ? `The change folder is \`repos/${s.repos[0]?.name}/orgspec/changes/${s.change}/\`. Run \`orgspec status ${s.change}\`.` : `There is no change folder yet. In the primary repo run \`orgspec new ${s.ticket}\`.`}
2. Fill the artifacts in the order \`orgspec status\` gives; validate with \`orgspec validate --strict\`.
3. Cite scenarios in tests with \`// @scenario <id>\`; check with \`orgspec trace\`.
4. Open pull requests as drafts. Writes outside this folder and pushes to protected branches are blocked.
${issue?.description ? `\n## Ticket description\n\n<untrusted source="jira">\n${issue.description.slice(0, 4000)}\n</untrusted>\n` : ''}${warnings.length ? `\n## Warnings\n\n${warnings.map((w) => `- ${w}`).join('\n')}\n` : ''}`;
}

/**
 * `orgspec packet <JIRA>`: a ticket folder with a worktree per repo, session files, agents, rules
 * and the gateway entry, then (optionally) a Claude Code session started in it.
 */
export async function createPacket(ctx: AppContext, o: PacketOptions): Promise<Packet> {
  const warnings: string[] = [];
  const personaId = o.persona ?? ctx.settings.persona;
  if (!personaId) throw new Error('No persona selected; run orgspec setup or orgspec settings persona <id>');
  const persona = ctx.persona(personaId);
  if (!persona) throw new Error(`Persona ${personaId} is not in orgspec-config`);
  const { bundle, diagnostics } = ctx.bundle(persona);
  if (!bundle)
    throw new Error(
      `Constitution bundle for ${personaId} is unusable: ${diagnostics.map((d) => d.message).join('; ')}`,
    );

  let issue = o.issue;
  if (!issue) {
    try {
      const i = await ctx.workplace().jira.get(o.ticket, ['summary', 'status', 'description']);
      const description = typeof i.fields.description === 'string' ? i.fields.description : undefined;
      issue = { key: i.key, summary: i.summary, status: i.status, ...(description ? { description } : {}) };
    } catch (e) {
      warnings.push(`Jira was not reachable (${(e as Error).message}); the packet has no ticket details`);
    }
  }

  const folder = join(ctx.workRoot, o.ticket);
  const existing = exists(join(folder, 'session.json')) ? readSession(folder) : undefined;
  const wanted = o.repos ?? ctx.settings.repos.map((r) => r.slug);
  if (!wanted.length)
    throw new Error('No repositories configured; add one with orgspec settings repo add <owner/name>');

  const repos: SessionRepo[] = [];
  for (const slug of wanted) {
    const cfg = ctx.settings.repos.find((r) => r.slug === slug) ?? { slug, host: 'github.com' };
    const [owner = '', name = slug] = slug.split('/');
    const prior = existing?.repos.find((r) => r.slug === slug);
    if (prior && existsSync(prior.path)) {
      const healthy = await ctx.git.head(prior.path).then(
        () => true,
        () => false,
      );
      if (healthy) {
        repos.push(prior);
        continue;
      }
      warnings.push(`The worktree for ${slug} was broken; recreated it`);
      rmSync(prior.path, { recursive: true, force: true });
    }
    const account = await ensureAccount(ctx.gh, ctx.settings.github, { host: cfg.host, owner }).catch((e: Error) => {
      warnings.push(`gh account check failed for ${slug}: ${e.message}`);
      return undefined;
    });
    if (account?.mismatch) warnings.push(account.mismatch);
    if (account?.switched) warnings.push(`Switched gh to ${account.login} for ${owner}`);
    const clone = await baseClone(ctx, slug, cfg.path);
    await ctx.git.fetch(clone).catch(() => warnings.push(`git fetch failed in ${slug}; using the local state`));
    const remote = remoteOwner(await ctx.git.remoteUrl(clone).catch(() => ''));
    const base = o.base ?? (await defaultBase(ctx, clone));
    const branch = `${o.ticket.toLowerCase()}`;
    const path = join(folder, 'repos', name);
    await ctx.git.worktreeAdd(clone, path, branch, base);
    const ghAccount = ctx.settings.github.orgAccounts[`${cfg.host}/${owner}`] ?? ctx.settings.github.orgAccounts[owner];
    repos.push({
      slug,
      host: remote?.host ?? cfg.host,
      owner: remote?.owner ?? owner,
      name,
      path,
      branch,
      base,
      ...(ghAccount ? { ghAccount } : {}),
    });
  }

  let change: string | undefined;
  let tier: TicketSession['tier'] = existing?.tier ?? 'medium';
  const primary = repos[0];
  if (primary && exists(join(primary.path, 'orgspec'))) {
    const ws = findWorkspace(primary.path);
    change = listChangeIds(ws).find((id) => id === o.ticket || id.startsWith(`${o.ticket}-`));
    if (change) tier = loadChange(ws, change).meta?.tier ?? tier;
  }

  const session: TicketSession = {
    id: existing?.id ?? `sess_${randomUUID().slice(0, 12)}`,
    ticket: o.ticket,
    persona: personaId,
    tier,
    folder,
    repos,
    ...(change ? { change } : {}),
    bundle: { persona: bundle.manifest.persona, version: bundle.manifest.version, sha256: bundle.manifest.sha256 },
    protectedBranches: DEFAULT_PROTECTED,
    state: 'active',
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeSession(session);
  writeHookRules(folder, {
    bundle: bundle.manifest.sha256,
    rules: bundle.rules.filter(
      (r) => r.enforcement === 'hook' && (r.check?.kind === 'git-op' || r.check?.kind === 'file-scope'),
    ),
  });
  writeClaudeFolder({ dir: folder, persona, rules: bundle.rules, bundle: session.bundle, sessionId: session.id });
  writeFileAtomic(join(folder, 'packet.md'), renderPacketMd(session, issue, warnings));
  writeFileAtomic(join(folder, 'CLAUDE.md'), `@packet.md\n`);
  ctx
    .db()
    .prepare('insert or replace into kv (key, value) values (?, ?)')
    .run(`session:${session.id}`, JSON.stringify({ folder, ticket: o.ticket, persona: personaId }));

  const packet: Packet = { session, folder, warnings };
  const prompt = `Read packet.md and continue work on ${o.ticket}.`;
  if (o.launch === 'background') {
    packet.claudeSession = await ctx.sessions.start({ cwd: folder, agent: 'orgspec-engineer', prompt, name: o.ticket });
    writeSession({ ...session, claudeSessionId: packet.claudeSession });
  } else if (o.launch === 'interactive') {
    packet.terminalScript = openTerminal({
      app: ctx.settings.terminal,
      cwd: folder,
      command: interactiveCommand('orgspec-engineer', prompt),
      scriptDir: ctx.paths.packets,
      name: o.ticket,
    });
  }
  return packet;
}

/** Ticket folders under the work root. */
export function listPackets(ctx: AppContext): TicketSession[] {
  if (!exists(ctx.workRoot)) return [];
  return readdirSync(ctx.workRoot)
    .filter((d) => !d.startsWith('.') && exists(join(ctx.workRoot, d, 'session.json')))
    .flatMap((d) => {
      try {
        return [readSession(join(ctx.workRoot, d))];
      } catch {
        return [];
      }
    });
}

/**
 * Removes a ticket folder: worktrees first (refusing uncommitted work unless forced), keeping a
 * copy of the action log and checkpoints under the local packets directory.
 */
export async function cleanupPacket(
  ctx: AppContext,
  ticket: string,
  o: { force?: boolean } = {},
): Promise<{ removed: string[]; kept: string }> {
  const folder = join(ctx.workRoot, ticket);
  const s = readSession(folder);
  for (const r of s.repos) {
    const dirty = await ctx.git.status(r.path).catch(() => '');
    if (dirty && !o.force)
      throw new Error(`${r.slug} has uncommitted changes in ${r.path}; commit them or use --force`);
  }
  const kept = join(ctx.paths.packets, `${ticket}-${new Date().toISOString().slice(0, 10)}`);
  if (exists(join(folder, '.orgspec'))) cpSync(join(folder, '.orgspec'), kept, { recursive: true });
  const removed: string[] = [];
  for (const r of s.repos) {
    const clone = ctx.settings.repos.find((x) => x.slug === r.slug)?.path ?? join(ctx.workRoot, '.repos', r.slug);
    await ctx.git.worktreeRemove(clone, r.path).catch(() => undefined);
    removed.push(r.path);
  }
  if (s.claudeSessionId) await ctx.sessions.remove(s.claudeSessionId).catch(() => undefined);
  rmSync(folder, { recursive: true, force: true });
  removed.push(folder);
  return { removed, kept };
}
