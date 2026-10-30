import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { type Diagnostic, error } from '@orgspec/spec-engine';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { isDuration } from './duration.js';
import { exists, readText } from './fs.js';

const SEMVER = /^\d+\.\d+\.\d+$/;
const SLUG = /^[a-z][a-z0-9-]*$/;
const duration = z.string().refine(isDuration, 'use a duration such as 2m, 15m or 24h');
const hhmm = z.string().regex(/^\d{2}:\d{2}$/, 'use HH:MM');

export const AgentDefSchema = z.object({
  id: z.string().regex(SLUG),
  description: z.string().default(''),
  model: z.string().default('sonnet'),
  skills: z.array(z.string()).default([]),
  /** Claude Code tool allowlist; omit to inherit. */
  tools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).default([]),
  permissionMode: z.enum(['default', 'acceptEdits', 'auto', 'dontAsk', 'plan']).optional(),
  /** System prompt body; defaults to the built-in prompt for the agent id. */
  prompt: z.string().optional(),
});
export type AgentDef = z.infer<typeof AgentDefSchema>;

export const McpGrantSchema = z.object({
  server: z.string().regex(SLUG),
  tools: z.array(z.string()).min(1),
  confirm: z.array(z.string()).default([]),
});
export type McpGrant = z.infer<typeof McpGrantSchema>;

export const PersonaSchema = z.object({
  apiVersion: z.literal('orgspec/v1'),
  kind: z.literal('Persona'),
  metadata: z.object({
    id: z.string().regex(SLUG),
    name: z.string(),
    version: z.string().regex(SEMVER),
    owners: z.array(z.string()).default([]),
  }),
  spec: z.object({
    /** GitHub teams (`org/team`) whose members may select the persona; empty means everyone. */
    eligibility: z.object({ teams: z.array(z.string()).default([]) }).default({}),
    constitution: z.object({ bundle: z.string(), sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/) }),
    agents: z.array(AgentDefSchema).default([]),
    mcp: z.array(McpGrantSchema).default([]),
    github: z.object({ gh: z.array(z.string()).default([]) }).default({}),
    views: z.array(z.string()).default([]),
    reminders: z.array(z.string()).default([]),
    include: z.array(z.string()).default([]),
  }),
});
export type Persona = z.infer<typeof PersonaSchema>;

export const SourceSchema = z.object({
  confluence: z.object({ space: z.string(), title: z.string(), pageId: z.string() }),
});

export const LAYERS = ['base', 'department', 'team', 'repo', 'persona'] as const;
export type Layer = (typeof LAYERS)[number];

export const OverlaySchema = z.object({
  apiVersion: z.literal('orgspec/v1'),
  kind: z.literal('ConstitutionOverlay'),
  metadata: z.object({
    id: z.string().regex(SLUG),
    version: z.string().regex(SEMVER),
    owners: z.array(z.string()).default([]),
  }),
  spec: z.object({
    layer: z.enum(LAYERS).default('persona'),
    extends: z.string().optional(),
    /** Department, team or repo the layer applies to (for non-base, non-persona layers). */
    scope: z.string().optional(),
    sources: z.array(SourceSchema).default([]),
    produces: z.array(z.string()).default(['rules', 'checks']),
    budget: z
      .object({
        maxRules: z.number().int().positive().default(60),
        maxTokens: z.number().int().positive().default(6000),
      })
      .default({}),
  }),
});
export type Overlay = z.infer<typeof OverlaySchema>;

export const SyncSourceSchema = z.object({
  every: duration,
  min: duration,
  max: duration,
  offHours: z.enum(['slow', 'pause', 'same']).default('slow'),
  offHoursEvery: duration.default('15m'),
  /** People may set a faster interval for their own views, within min..max. */
  personal: z.boolean().default(false),
});
export type SyncSource = z.infer<typeof SyncSourceSchema>;

export const DEFAULT_SYNC: Record<string, SyncSource> = {
  'jira.active': { every: '2m', min: '1m', max: '15m', offHours: 'slow', offHoursEvery: '15m', personal: true },
  'jira.programs': { every: '15m', min: '5m', max: '60m', offHours: 'slow', offHoursEvery: '60m', personal: false },
  'confluence.sources': {
    every: '15m',
    min: '5m',
    max: '24h',
    offHours: 'slow',
    offHoursEvery: '60m',
    personal: false,
  },
  'confluence.reviews': { every: '5m', min: '2m', max: '60m', offHours: 'slow', offHoursEvery: '30m', personal: false },
  'slack.dms': { every: '5m', min: '2m', max: '30m', offHours: 'pause', offHoursEvery: '30m', personal: true },
  'github.prs': { every: '2m', min: '1m', max: '15m', offHours: 'slow', offHoursEvery: '15m', personal: true },
  'ci.runs': { every: '2m', min: '1m', max: '15m', offHours: 'slow', offHoursEvery: '15m', personal: true },
  'hr.directory': { every: '24h', min: '1h', max: '24h', offHours: 'same', offHoursEvery: '24h', personal: false },
  'config.pull': { every: '15m', min: '5m', max: '60m', offHours: 'same', offHoursEvery: '60m', personal: false },
};

export const SyncConfigSchema = z.object({
  workingHours: z
    .object({
      start: hhmm.default('09:00'),
      end: hhmm.default('18:00'),
      days: z.array(z.number().int().min(0).max(6)).default([1, 2, 3, 4, 5]),
    })
    .default({}),
  sources: z.record(z.string(), SyncSourceSchema).default({}),
});
export type SyncConfig = z.infer<typeof SyncConfigSchema>;

/** One logical operation mapped to an upstream MCP tool; `$name` in args is replaced with the call's input. */
export const ToolMappingSchema = z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()).default({}) });
export type ToolMapping = z.infer<typeof ToolMappingSchema>;

export const UpstreamSchema = z.object({
  transport: z.enum(['http', 'stdio']),
  url: z.string().url().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  /** Hosts this server's results may legitimately link to; used by egress checks. */
  hosts: z.array(z.string()).default([]),
  /** Results from this server are wrapped as untrusted data. */
  untrusted: z.boolean().default(true),
  oauth: z.object({ clientId: z.string().optional(), scopes: z.array(z.string()).default([]) }).optional(),
});
export type Upstream = z.infer<typeof UpstreamSchema>;

export const IntegrationsSchema = z.object({
  servers: z.record(z.string(), UpstreamSchema).default({}),
  /** `jira.searchIssues` → upstream tool and argument template. */
  operations: z.record(z.string(), ToolMappingSchema).default({}),
  /** Values substituted into every template, for example the Atlassian cloud ID. */
  constants: z.record(z.string(), z.string()).default({}),
  egressAllow: z.array(z.string()).default([]),
});
export type Integrations = z.infer<typeof IntegrationsSchema>;

export const WaiverSchema = z.object({
  id: z.string().regex(/^W-\d+$/),
  rule: z.string(),
  scope: z
    .object({
      team: z.string().optional(),
      repo: z.string().optional(),
      paths: z.array(z.string()).optional(),
      change: z.string().optional(),
    })
    .default({}),
  reason: z.string().min(1),
  approver: z.string().min(1),
  expires: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type Waiver = z.infer<typeof WaiverSchema>;

/** Org limits for zen mode (`orgspec-config/zen.yaml`). Incident break-through cannot be turned off. */
export const ZenConfigSchema = z.object({
  maxMinutes: z.number().int().min(15).max(480).default(120),
  /** Focus suggestion order: categories first, then each person's ranking. */
  priorityOrder: z
    .array(z.enum(['incident', 'security', 'blocking-others', 'due-today', 'current-work']))
    .default(['incident', 'security', 'blocking-others', 'due-today', 'current-work']),
  /** Hours someone has waited on you before a quiet "waiting on you" line appears. */
  blockerHours: z.number().min(0.5).max(48).default(2),
  /** Reminder kinds that always break through, besides incidents and on-call pages. */
  breakThrough: z.array(z.string()).default([]),
});
export type ZenConfig = z.infer<typeof ZenConfigSchema>;

export interface OrgConfig {
  dir: string;
  personas: Persona[];
  overlays: Overlay[];
  sync: SyncConfig & { sources: Record<string, SyncSource> };
  integrations: Integrations;
  waivers: Waiver[];
  zen: ZenConfig;
  diagnostics: Diagnostic[];
}

function yamlFiles(dir: string): string[] {
  if (!exists(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((f) => join(dir, f));
}

function parseFile<S extends z.ZodTypeAny>(
  file: string,
  schema: S,
  diagnostics: Diagnostic[],
): z.output<S> | undefined {
  let raw: unknown;
  try {
    raw = parseYaml(readText(file));
  } catch (e) {
    diagnostics.push(error('config_yaml_invalid', `${file}: ${(e as Error).message}`, { path: file }));
    return undefined;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      diagnostics.push(
        error('config_invalid', `${issue.path.join('.') || '(root)'}: ${issue.message}`, { path: file }),
      );
    }
    return undefined;
  }
  return parsed.data as z.output<S>;
}

/** Loads an `orgspec-config` checkout. Fails closed: invalid files are reported and left out. */
export function loadOrgConfig(dir: string): OrgConfig {
  const diagnostics: Diagnostic[] = [];
  const personas = yamlFiles(join(dir, 'personas')).flatMap((f) => parseFile(f, PersonaSchema, diagnostics) ?? []);
  const overlays = [join(dir, 'constitution', 'base.yaml'), ...yamlFiles(join(dir, 'constitution', 'overlays'))]
    .filter(exists)
    .flatMap((f) => parseFile(f, OverlaySchema, diagnostics) ?? []);
  const syncFile = join(dir, 'sync.yaml');
  const syncParsed = exists(syncFile) ? parseFile(syncFile, SyncConfigSchema, diagnostics) : undefined;
  const sync = SyncConfigSchema.parse(syncParsed ?? {});
  const intFile = join(dir, 'integrations.yaml');
  const integrations =
    (exists(intFile) ? parseFile(intFile, IntegrationsSchema, diagnostics) : undefined) ?? IntegrationsSchema.parse({});
  const waivers = yamlFiles(join(dir, 'waivers')).flatMap((f) => parseFile(f, WaiverSchema, diagnostics) ?? []);
  const zenFile = join(dir, 'zen.yaml');
  const zen =
    (exists(zenFile) ? parseFile(zenFile, ZenConfigSchema, diagnostics) : undefined) ?? ZenConfigSchema.parse({});

  const ids = new Set<string>();
  for (const p of personas) {
    if (ids.has(p.metadata.id))
      diagnostics.push(error('persona_duplicate', `Persona "${p.metadata.id}" is defined twice`));
    ids.add(p.metadata.id);
  }
  return {
    dir,
    personas,
    overlays,
    sync: { ...sync, sources: { ...DEFAULT_SYNC, ...sync.sources } },
    integrations,
    waivers,
    zen,
    diagnostics,
  };
}

export const activeWaivers = (waivers: readonly Waiver[], today = new Date().toISOString().slice(0, 10)): Waiver[] =>
  waivers.filter((w) => w.expires >= today);
