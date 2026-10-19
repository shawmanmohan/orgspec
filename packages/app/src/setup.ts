import { join } from 'node:path';
import { exists } from '@orgspec/core';
import type { AppContext } from './context.js';

/**
 * `orgspec setup`: clones orgspec-config with gh, records identity from gh, and selects a persona the
 * person is eligible for (GitHub team membership via gh).
 */
export async function setup(
  ctx: AppContext,
  o: { configRemote?: string; configDir?: string; persona?: string; email?: string },
): Promise<{ configDir: string; persona?: string; eligible: string[]; notes: string[] }> {
  const notes: string[] = [];
  const configDir = o.configDir ?? ctx.configDir ?? join(ctx.paths.home, 'orgspec-config');
  if (!exists(join(configDir, '.git'))) {
    const remote = o.configRemote ?? ctx.settings.configRemote;
    if (!remote) throw new Error('Pass --config <owner/orgspec-config> so OrgSpec can clone it with gh');
    await ctx.gh.clone(remote, configDir);
    notes.push(`Cloned ${remote} to ${configDir}`);
  }
  const active = await ctx.gh.activeAccount().catch(() => undefined);
  ctx.updateSettings((s) => ({
    ...s,
    configRepo: configDir,
    ...(o.configRemote ? { configRemote: o.configRemote } : {}),
    identity: {
      ...s.identity,
      ...(active ? { githubLogin: active.login } : {}),
      ...(o.email ? { email: o.email } : {}),
    },
  }));
  const cfg = ctx.config();
  if (!cfg) throw new Error(`Cannot read orgspec-config at ${configDir}`);
  for (const d of cfg.diagnostics) notes.push(`${d.severity}: ${d.message}`);

  const login = active?.login;
  const eligible: string[] = [];
  for (const p of cfg.personas) {
    const teams = p.spec.eligibility.teams;
    if (!teams.length) {
      eligible.push(p.metadata.id);
      continue;
    }
    if (!login) continue;
    for (const t of teams) {
      const [org, team] = t.split('/');
      if (!org || !team) continue;
      const members = await ctx.gh.teamMembers(org, team).catch(() => [] as string[]);
      if (members.includes(login)) {
        eligible.push(p.metadata.id);
        break;
      }
    }
  }
  ctx
    .db()
    .prepare("insert or replace into kv (key, value) values ('personas:eligible', ?)")
    .run(JSON.stringify(eligible));
  const persona = o.persona ?? (eligible.length === 1 ? eligible[0] : undefined);
  if (persona) {
    if (!eligible.includes(persona))
      throw new Error(`You are not eligible for the ${persona} persona (eligible: ${eligible.join(', ') || 'none'})`);
    ctx.updateSettings((s) => ({ ...s, persona }));
  } else if (eligible.length > 1) notes.push(`Choose a persona: orgspec settings persona <${eligible.join('|')}>`);
  return { configDir, ...(persona ? { persona } : {}), eligible, notes };
}
