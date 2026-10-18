import { z } from 'zod';
import { readJsonFile, writeFileAtomic } from './files.js';

const hhmm = z.string().regex(/^\d{2}:\d{2}$/);

/** Per-person settings on this machine (never shared). */
export const UserSettingsSchema = z.object({
  /** Local clone of `orgspec-config`. */
  configRepo: z.string().optional(),
  /** `owner/repo` of orgspec-config, used to clone and pull with gh. */
  configRemote: z.string().optional(),
  workRoot: z.string().default('~/OrgSpec/tickets'),
  persona: z.string().optional(),
  identity: z
    .object({
      email: z.string().optional(),
      githubLogin: z.string().optional(),
      jiraAccountId: z.string().optional(),
      slackUserId: z.string().optional(),
      timezone: z.string().optional(),
    })
    .default({}),
  github: z
    .object({
      autoSwitch: z.boolean().default(true),
      /** `github.com/acme-payments` → gh account login. */
      orgAccounts: z.record(z.string(), z.string()).default({}),
    })
    .default({}),
  /** Personal intervals for sources the admin allows (within min..max). */
  intervals: z.record(z.string(), z.string()).default({}),
  quietHours: z.object({ start: hhmm.default('19:00'), end: hhmm.default('09:00') }).default({}),
  terminal: z.enum(['Terminal', 'iTerm2', 'Ghostty']).default('Terminal'),
  sendMode: z.enum(['background', 'interactive']).default('background'),
  dmInbox: z.object({ enabled: z.boolean().default(true), excluded: z.array(z.string()).default([]) }).default({}),
  reminders: z
    .object({ mode: z.enum(['digest', 'dm']).default('digest'), digestAt: hhmm.default('09:30') })
    .default({}),
  /** Jira projects whose tickets this person follows (PM programs, EM queues). */
  jira: z
    .object({
      projects: z.array(z.string()).default([]),
      programJql: z.string().optional(),
      prdLabel: z.string().default('prd-review'),
    })
    .default({}),
  /** Repositories (`owner/name` or local paths) this person works in. */
  repos: z
    .array(z.object({ slug: z.string(), path: z.string().optional(), host: z.string().default('github.com') }))
    .default([]),
});
export type UserSettings = z.infer<typeof UserSettingsSchema>;

export function loadSettings(file: string): UserSettings {
  const parsed = UserSettingsSchema.safeParse(readJsonFile<unknown>(file, {}));
  return parsed.success ? parsed.data : UserSettingsSchema.parse({});
}

export function saveSettings(file: string, settings: UserSettings): void {
  writeFileAtomic(file, `${JSON.stringify(UserSettingsSchema.parse(settings), null, 2)}\n`);
}

export function updateSettings(file: string, patch: (s: UserSettings) => UserSettings): UserSettings {
  const next = UserSettingsSchema.parse(patch(loadSettings(file)));
  saveSettings(file, next);
  return next;
}
