import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/** Where OrgSpec keeps local state on this machine. `ORGSPEC_HOME` overrides it (tests, sandboxes). */
export function appDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ORGSPEC_HOME) return env.ORGSPEC_HOME;
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'OrgSpec');
  return join(env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'orgspec');
}

export const expandHome = (p: string): string => (p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

export interface LocalPaths {
  home: string;
  settings: string;
  coreDb: string;
  privateDb: string;
  jobs: string;
  snapshots: string;
  packets: string;
  logs: string;
  socket: string;
  daemonInfo: string;
  keyFile: string;
}

/** Unix socket paths are limited to about 104 bytes on macOS; long homes get a short hashed path in tmp. */
export function socketPath(home: string): string {
  const direct = join(home, 'orgspec.sock');
  if (Buffer.byteLength(direct) <= 100) return direct;
  return join(tmpdir(), `orgspec-${createHash('sha256').update(home).digest('hex').slice(0, 12)}.sock`);
}

export function localPaths(env: NodeJS.ProcessEnv = process.env): LocalPaths {
  const home = appDataDir(env);
  return {
    home,
    settings: join(home, 'settings.json'),
    coreDb: join(home, 'cache.sqlite'),
    privateDb: join(home, 'private.sqlite'),
    jobs: join(home, 'jobs'),
    snapshots: join(home, 'snapshots'),
    packets: join(home, 'packets'),
    logs: join(home, 'logs'),
    socket: socketPath(home),
    daemonInfo: join(home, 'daemon.json'),
    keyFile: join(home, 'keys.json'),
  };
}
