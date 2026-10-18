import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { claudeVersion, managedSettingsPath, renderManagedSettings } from '@orgspec/claude';
import { loadBundle } from '@orgspec/constitution';
import { exists, readText, writeFileAtomic } from '@orgspec/core';
import { Gateway } from '@orgspec/gateway';
import type { AppContext } from './context.js';
import { searchDecisions } from './decisions.js';
import { findSessionFolder, readSession } from './session.js';

const LABEL = 'com.orgspec.daemon';

/** Login-time service definition: launchd on macOS, a systemd user unit on Linux. */
export function serviceDefinition(
  bin: string[],
  platform: NodeJS.Platform = process.platform,
): { file: string; text: string; activate: string[][] } {
  if (platform === 'darwin') {
    const file = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
    const args = [...bin, 'daemon']
      .map((a) => `    <string>${a.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</string>`)
      .join('\n');
    return {
      file,
      text: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Background</string>
  <key>StandardErrorPath</key><string>${join(homedir(), 'Library', 'Logs', 'orgspec-daemon.log')}</string>
</dict>
</plist>
`,
      activate: [
        ['launchctl', 'bootout', `gui/${process.getuid?.() ?? 501}/${LABEL}`],
        ['launchctl', 'bootstrap', `gui/${process.getuid?.() ?? 501}`, file],
      ],
    };
  }
  const file = join(homedir(), '.config', 'systemd', 'user', 'orgspec.service');
  return {
    file,
    text: `[Unit]
Description=OrgSpec local service

[Service]
ExecStart=${[...bin, 'daemon'].join(' ')}
Restart=on-failure

[Install]
WantedBy=default.target
`,
    activate: [
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', '--now', 'orgspec.service'],
    ],
  };
}

export async function installService(ctx: AppContext, bin: string[]): Promise<string> {
  const def = serviceDefinition(bin);
  writeFileAtomic(def.file, def.text);
  for (const cmd of def.activate) await ctx.runner(cmd[0] as string, cmd.slice(1));
  return def.file;
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

/** `orgspec doctor`: everything a working setup needs, with the fix for each failure. */
export async function doctor(ctx: AppContext, o: { hookTiming?: () => Promise<number> } = {}): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = [];
  const add = (c: DoctorCheck) => out.push(c);
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  add({
    name: 'Node',
    ok: major > 22 || (major === 22 && minor >= 13),
    detail: process.versions.node,
    fix: 'Install Node 22.13 or newer',
  });
  const cv = await claudeVersion(ctx.runner);
  add({ name: 'Claude Code', ok: cv.ok, detail: cv.message, fix: 'Run: claude update' });
  const accounts = await ctx.gh.accounts().catch(() => []);
  add({
    name: 'gh',
    ok: accounts.length > 0,
    detail: accounts.length
      ? accounts.map((a) => `${a.login}@${a.host}${a.active ? ' (active)' : ''}`).join(', ')
      : 'not signed in',
    fix: 'Run: orgspec github login',
  });
  add({
    name: 'Keychain',
    ok: ctx.keyStore.kind !== 'file' || ctx.env.ORGSPEC_KEYSTORE === 'file',
    detail: ctx.keyStore.kind,
  });
  try {
    await ctx.key();
    add({ name: 'Data key', ok: true, detail: 'available' });
  } catch (e) {
    add({ name: 'Data key', ok: false, detail: (e as Error).message, fix: 'Unlock your keychain and retry' });
  }
  const cfg = ctx.config();
  add({
    name: 'orgspec-config',
    ok: Boolean(cfg) && !cfg?.diagnostics.some((d) => d.severity === 'error'),
    detail: ctx.configDir ?? 'not set',
    fix: 'Run: orgspec setup --config <owner/orgspec-config>',
  });
  const persona = ctx.persona();
  add({
    name: 'Persona',
    ok: Boolean(persona),
    detail: ctx.settings.persona ?? 'none selected',
    fix: 'Run: orgspec settings persona <id>',
  });
  if (persona) {
    const { bundle, diagnostics } = ctx.bundle(persona);
    add({
      name: 'Constitution bundle',
      ok: Boolean(bundle),
      detail: bundle
        ? `${bundle.manifest.persona} ${bundle.manifest.version}`
        : diagnostics.map((d) => d.message).join('; '),
      fix: 'Pull orgspec-config (orgspec sync config.pull)',
    });
  }
  const managed = managedSettingsPath();
  let managedOk = false;
  if (exists(managed)) {
    try {
      const m = JSON.parse(readText(managed)) as {
        allowManagedHooksOnly?: boolean;
        hooks?: { PreToolUse?: { hooks: { command: string }[] }[] };
      };
      managedOk = Boolean(m.allowManagedHooksOnly) && JSON.stringify(m.hooks ?? {}).includes('hook pre-tool-use');
    } catch {
      managedOk = false;
    }
  }
  add({
    name: 'Managed settings',
    ok: managedOk,
    detail: managed,
    fix: 'Ask IT to install the file from: orgspec managed-settings',
  });
  if (cfg) {
    for (const name of Object.keys(cfg.integrations.servers)) {
      try {
        const tools = await ctx.pool().tools(name);
        add({ name: `MCP ${name}`, ok: true, detail: `${tools.length} tools` });
      } catch (e) {
        add({ name: `MCP ${name}`, ok: false, detail: (e as Error).message, fix: `Run: orgspec connect ${name}` });
      }
    }
  }
  if (o.hookTiming) {
    const ms = await o.hookTiming();
    add({
      name: 'Hook latency',
      ok: ms <= 100,
      detail: `${ms.toFixed(0)} ms (budget 100 ms)`,
      fix: 'Start the daemon and set ORGSPEC_HOOK_MODE=socket',
    });
  }
  return out;
}

export { renderManagedSettings };

/** Admin policies (`orgspec-config/policies/*.cedar`). */
export function adminPolicies(configDir?: string): string {
  const dir = configDir ? join(configDir, 'policies') : '';
  if (!dir || !exists(dir)) return '';
  return readdirSync(dir)
    .filter((f) => f.endsWith('.cedar'))
    .sort()
    .map((f) => readText(join(dir, f)))
    .join('\n\n');
}

/**
 * `orgspec gateway --stdio --session <id>`: the MCP server Claude Code starts. The session comes from
 * the ticket folder; without one, the gateway runs for the person's selected persona.
 */
export async function runGateway(ctx: AppContext, o: { session?: string; cwd: string }): Promise<Gateway> {
  const folder = findSessionFolder(o.cwd);
  const s = folder ? readSession(folder) : undefined;
  const personaId = s?.persona ?? ctx.settings.persona;
  const persona = ctx.persona(personaId);
  if (!persona) throw new Error('No persona: run orgspec setup');
  const cfg = ctx.config();
  const gw = new Gateway({
    session: {
      id: o.session ?? s?.id ?? 'interactive',
      persona: persona.metadata.id,
      ...(s?.ticket ? { ticket: s.ticket } : {}),
      ...(s?.tier ? { tier: s.tier } : {}),
    },
    grants: persona.spec.mcp,
    adminPolicies: adminPolicies(ctx.configDir),
    pool: ctx.pool(),
    db: ctx.db(),
    egressAllow: cfg?.integrations.egressAllow ?? [],
    searchDecisions: (q, limit) => searchDecisions(ctx.db(), q, limit),
  });
  await gw.connectStdio();
  return gw;
}

/** Verifies the bundle a ticket folder was created with is still the one the persona pins. */
export function sessionBundleCurrent(ctx: AppContext, folder: string): boolean {
  const s = readSession(folder);
  const p = ctx.persona(s.persona);
  if (!p || !ctx.configDir) return false;
  const { bundle } = loadBundle(join(ctx.configDir, p.spec.constitution.bundle), p.spec.constitution.sha256);
  return bundle?.manifest.sha256 === s.bundle.sha256;
}
