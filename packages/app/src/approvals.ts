import { join, relative, sep } from 'node:path';
import type { ApprovalRecord } from '@orgspec/constitution';
import { exists, readText, writeFileAtomic } from '@orgspec/core';
import type { Git } from '@orgspec/integrations';
import { type Diagnostic, error, hashText, type LoadedChange, warning } from '@orgspec/spec-engine';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import { z } from 'zod';

export const APPROVALS_FILE = 'approvals.yaml';

export const ApprovalEntrySchema = z.object({
  artifact: z.string(),
  sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  approver: z.string(),
  role: z.string().optional(),
  at: z.string(),
  note: z.string().optional(),
});
export type ApprovalEntry = z.infer<typeof ApprovalEntrySchema>;

const FileSchema = z.object({ approvals: z.array(ApprovalEntrySchema).default([]) });

export function readApprovals(changeDirPath: string): { entries: ApprovalEntry[]; diagnostics: Diagnostic[] } {
  const file = join(changeDirPath, APPROVALS_FILE);
  if (!exists(file)) return { entries: [], diagnostics: [] };
  try {
    const parsed = FileSchema.safeParse(parseYaml(readText(file)) ?? {});
    if (!parsed.success)
      return {
        entries: [],
        diagnostics: [
          error('approvals_invalid', `${APPROVALS_FILE}: ${parsed.error.issues[0]?.message}`, { path: file }),
        ],
      };
    return { entries: parsed.data.approvals, diagnostics: [] };
  } catch (e) {
    return {
      entries: [],
      diagnostics: [error('approvals_invalid', `${APPROVALS_FILE}: ${(e as Error).message}`, { path: file })],
    };
  }
}

/** Current content hash of each artifact in a change folder (top level and delta specs). */
export function artifactHashes(change: LoadedChange): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of ['proposal.md', 'design.md', 'threat-model.md', 'tasks.md', 'findings.md', 'rollout.md']) {
    const p = join(change.dir, f);
    if (exists(p)) out[f] = hashText(readText(p));
  }
  for (const d of change.deltas) out[relative(change.dir, d.file).split(sep).join('/')] = hashText(readText(d.file));
  return out;
}

/** Adds an approval for the artifact's current content. The approver commits the file themselves. */
export function addApproval(
  change: LoadedChange,
  entry: Omit<ApprovalEntry, 'sha256' | 'at'> & { at?: string },
): ApprovalEntry {
  const hashes = artifactHashes(change);
  const sha256 = hashes[entry.artifact];
  if (!sha256) throw new Error(`${entry.artifact} does not exist in ${change.id}`);
  const { entries } = readApprovals(change.dir);
  const next: ApprovalEntry = { ...entry, sha256, at: entry.at ?? new Date().toISOString().slice(0, 10) };
  const kept = entries.filter((e) => !(e.artifact === next.artifact && e.approver === next.approver));
  writeFileAtomic(
    join(change.dir, APPROVALS_FILE),
    `# Approvals for ${change.id}. Each entry must be committed by the approver it names.\n${toYaml({ approvals: [...kept, next] })}`,
  );
  return next;
}

export interface ApproverDirectory {
  /** GitHub login of a commit's author, or undefined when it cannot be determined. */
  commitLogin(sha: string, email: string): Promise<string | undefined>;
  /** Roles a login holds (from orgspec-config roles.yaml). */
  roles(login: string): string[];
  teams(login: string): string[];
}

/** Login from a GitHub noreply address (`123+alice@users.noreply.github.com`). */
export const noreplyLogin = (email: string): string | undefined =>
  /^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/i.exec(email)?.[1];

/**
 * Verifies each approval was committed by the approver it names: the oldest commit whose version of
 * approvals.yaml contains the entry must be authored by that login.
 */
export async function verifyApprovals(
  change: LoadedChange,
  repoRoot: string,
  g: Git,
  dir: ApproverDirectory,
): Promise<{ records: ApprovalRecord[]; diagnostics: Diagnostic[] }> {
  const { entries, diagnostics } = readApprovals(change.dir);
  if (!entries.length) return { records: [], diagnostics };
  const relFile = relative(repoRoot, join(change.dir, APPROVALS_FILE)).split(sep).join('/');
  const commits = (await g.logForFile(repoRoot, relFile).catch(() => [])).reverse();
  const versions: { sha: string; email: string; entries: ApprovalEntry[] }[] = [];
  for (const c of commits) {
    const text = await g.call(repoRoot, ['show', `${c.sha}:${relFile}`]).catch(() => '');
    const parsed = FileSchema.safeParse(text ? parseYaml(text) : {});
    versions.push({ sha: c.sha, email: c.email, entries: parsed.success ? parsed.data.approvals : [] });
  }
  const same = (a: ApprovalEntry, b: ApprovalEntry) =>
    a.artifact === b.artifact && a.sha256 === b.sha256 && a.approver === b.approver;
  const records: ApprovalRecord[] = [];
  for (const e of entries) {
    const first = versions.find((v) => v.entries.some((x) => same(x, e)));
    let verified = false;
    if (!first)
      diagnostics.push(
        warning('approval_uncommitted', `Approval of ${e.artifact} by ${e.approver} is not committed yet`),
      );
    else {
      const login = (await dir.commitLogin(first.sha, first.email)) ?? noreplyLogin(first.email);
      verified = login?.toLowerCase() === e.approver.toLowerCase();
      if (!verified) {
        diagnostics.push(
          error(
            'approval_forged',
            `Approval of ${e.artifact} names ${e.approver} but was committed by ${login ?? first.email} (${first.sha.slice(0, 8)})`,
            {
              fix: 'The approver must run orgspec approve and commit approvals.yaml themselves',
            },
          ),
        );
      }
    }
    const roles = dir.roles(e.approver);
    if (e.role && !roles.includes(e.role)) {
      diagnostics.push(error('approval_role', `${e.approver} does not hold the ${e.role} role in orgspec-config`));
      verified = false;
    }
    records.push({
      artifact: e.artifact,
      sha256: e.sha256,
      approver: e.approver,
      ...(e.role ? { role: e.role } : {}),
      teams: dir.teams(e.approver),
      verified,
    });
  }
  return { records, diagnostics };
}

export const RolesSchema = z.object({
  roles: z.record(z.string(), z.array(z.string())).default({}),
  teams: z.record(z.string(), z.array(z.string())).default({}),
});
export type Roles = z.infer<typeof RolesSchema>;

export function loadRoles(configDir: string | undefined): Roles {
  const f = configDir ? join(configDir, 'roles.yaml') : '';
  if (!f || !exists(f)) return { roles: {}, teams: {} };
  return RolesSchema.parse(parseYaml(readText(f)) ?? {});
}

export const rolesDirectory = (roles: Roles, commitLogin: ApproverDirectory['commitLogin']): ApproverDirectory => ({
  commitLogin,
  roles: (login) =>
    Object.entries(roles.roles).flatMap(([role, members]) =>
      members.some((m) => m.toLowerCase() === login.toLowerCase()) ? [role] : [],
    ),
  teams: (login) =>
    Object.entries(roles.teams).flatMap(([team, members]) =>
      members.some((m) => m.toLowerCase() === login.toLowerCase()) ? [team] : [],
    ),
});
