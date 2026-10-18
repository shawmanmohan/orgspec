import { mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { type ClaudeJobs, type ClaudeSessions, claudeJobs, claudeSessions } from '@orgspec/claude';
import { type LoadedBundle, loadBundle } from '@orgspec/constitution';
import {
  CORE_MIGRATIONS,
  type CommandRunner,
  type Db,
  dataKey,
  defaultKeyStore,
  expandHome,
  type KeyStore,
  type LocalPaths,
  loadOrgConfig,
  loadSettings,
  localPaths,
  type OrgConfig,
  openDb,
  type Persona,
  PRIVATE_MIGRATIONS,
  runCommand,
  type UserSettings,
  updateSettings,
} from '@orgspec/core';
import { type Connector, sdkConnector, UpstreamPool } from '@orgspec/gateway';
import { type Gh, type Git, gh, git, type Workplace, workplace } from '@orgspec/integrations';
import type { Diagnostic } from '@orgspec/spec-engine';

export interface ContextOptions {
  env?: NodeJS.ProcessEnv;
  runner?: CommandRunner;
  connector?: Connector;
  jobs?: ClaudeJobs;
  keyStore?: KeyStore;
  /** Called when an upstream MCP server needs a browser sign-in. */
  onAuthorize?: (server: string, url: URL) => void | Promise<void>;
}

/** Everything a command, the daemon or a job needs, created lazily. */
export class AppContext {
  readonly paths: LocalPaths;
  readonly env: NodeJS.ProcessEnv;
  readonly runner: CommandRunner;
  readonly keyStore: KeyStore;
  readonly gh: Gh;
  readonly git: Git;
  readonly jobs: ClaudeJobs;
  readonly sessions: ClaudeSessions;
  private _settings?: UserSettings;
  private _config?: OrgConfig | null;
  private _bundle?: { bundle?: LoadedBundle; diagnostics: Diagnostic[] };
  private _db?: Db;
  private _private?: Db;
  private _key?: Buffer;
  private _pool?: UpstreamPool;
  private _workplace?: Workplace;

  constructor(private readonly o: ContextOptions = {}) {
    this.env = o.env ?? process.env;
    this.paths = localPaths(this.env);
    mkdirSync(this.paths.home, { recursive: true });
    this.runner = o.runner ?? runCommand;
    this.keyStore = o.keyStore ?? defaultKeyStore(this.paths.keyFile, this.env);
    this.gh = gh(this.runner);
    this.git = git(this.runner);
    this.jobs = o.jobs ?? claudeJobs(this.runner);
    this.sessions = claudeSessions(this.runner);
  }

  get settings(): UserSettings {
    this._settings ??= loadSettings(this.paths.settings);
    return this._settings;
  }

  updateSettings(patch: (s: UserSettings) => UserSettings): UserSettings {
    this._settings = updateSettings(this.paths.settings, patch);
    this._config = undefined;
    this._bundle = undefined;
    return this._settings;
  }

  get workRoot(): string {
    return expandHome(this.settings.workRoot);
  }

  get configDir(): string | undefined {
    return this.settings.configRepo ? expandHome(this.settings.configRepo) : undefined;
  }

  /** The local orgspec-config checkout, or undefined when not set up. */
  config(): OrgConfig | undefined {
    if (this._config === undefined) {
      const dir = this.configDir;
      this._config = dir ? loadOrgConfig(dir) : null;
    }
    return this._config ?? undefined;
  }

  persona(id = this.settings.persona): Persona | undefined {
    return id ? this.config()?.personas.find((p) => p.metadata.id === id) : undefined;
  }

  /** The persona's compiled bundle, verified against the hash the persona pins. */
  bundle(persona = this.persona()): { bundle?: LoadedBundle; diagnostics: Diagnostic[] } {
    if (!persona || !this.configDir) return { diagnostics: [] };
    if (!this._bundle || this._bundle.bundle?.manifest.persona !== persona.metadata.id) {
      const ref = persona.spec.constitution.bundle;
      this._bundle = loadBundle(isAbsolute(ref) ? ref : join(this.configDir, ref), persona.spec.constitution.sha256);
    }
    return this._bundle;
  }

  db(): Db {
    this._db ??= openDb(this.paths.coreDb, CORE_MIGRATIONS);
    return this._db;
  }

  privateDb(): Db {
    this._private ??= openDb(this.paths.privateDb, PRIVATE_MIGRATIONS);
    return this._private;
  }

  /** Data key for the private DB, held in the OS keychain. */
  async key(): Promise<Buffer> {
    this._key ??= await dataKey(this.keyStore);
    return this._key;
  }

  pool(): UpstreamPool {
    this._pool ??= new UpstreamPool(
      this.config()?.integrations.servers ?? {},
      this.o.connector ?? sdkConnector(this.keyStore, this.o.onAuthorize),
    );
    return this._pool;
  }

  workplace(): Workplace {
    const ints = this.config()?.integrations;
    this._workplace ??= workplace(this.pool(), {
      operations: ints?.operations ?? {},
      constants: ints?.constants ?? {},
    });
    return this._workplace;
  }

  async close(): Promise<void> {
    await this._pool?.close();
    this._db?.close();
    this._private?.close();
  }
}
