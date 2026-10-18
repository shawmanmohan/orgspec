import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { type CommandRunner, runCommand } from './exec.js';
import { writeFileAtomic } from './files.js';

/** Secrets live in the OS keychain; nothing secret is written in plain files except the test-only file store. */
export interface KeyStore {
  readonly kind: 'macos-keychain' | 'secret-service' | 'file';
  get(service: string, account: string): Promise<string | undefined>;
  set(service: string, account: string, value: string): Promise<void>;
  delete(service: string, account: string): Promise<void>;
}

export function macKeychain(run: CommandRunner = runCommand): KeyStore {
  return {
    kind: 'macos-keychain',
    async get(service, account) {
      const r = await run('security', ['find-generic-password', '-s', service, '-a', account, '-w']);
      return r.code === 0 ? r.stdout.replace(/\n$/, '') : undefined;
    },
    async set(service, account, value) {
      const r = await run('security', ['add-generic-password', '-U', '-s', service, '-a', account, '-w', value]);
      if (r.code !== 0) throw new Error(`Keychain write failed: ${r.stderr.trim()}`);
    },
    async delete(service, account) {
      await run('security', ['delete-generic-password', '-s', service, '-a', account]);
    },
  };
}

export function secretService(run: CommandRunner = runCommand): KeyStore {
  return {
    kind: 'secret-service',
    async get(service, account) {
      const r = await run('secret-tool', ['lookup', 'service', service, 'account', account]);
      return r.code === 0 && r.stdout ? r.stdout.replace(/\n$/, '') : undefined;
    },
    async set(service, account, value) {
      const r = await run(
        'secret-tool',
        ['store', '--label', `${service} ${account}`, 'service', service, 'account', account],
        {
          input: value,
        },
      );
      if (r.code !== 0) throw new Error(`Secret Service write failed: ${r.stderr.trim()}`);
    },
    async delete(service, account) {
      await run('secret-tool', ['clear', 'service', service, 'account', account]);
    },
  };
}

/** For tests and CI only: a 0600 JSON file. */
export function fileKeyStore(file: string): KeyStore {
  const load = (): Record<string, string> => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {});
  const save = (data: Record<string, string>) => {
    writeFileAtomic(file, JSON.stringify(data, null, 2));
    chmodSync(file, 0o600);
  };
  return {
    kind: 'file',
    async get(service, account) {
      return load()[`${service}/${account}`];
    },
    async set(service, account, value) {
      save({ ...load(), [`${service}/${account}`]: value });
    },
    async delete(service, account) {
      const data = load();
      delete data[`${service}/${account}`];
      save(data);
    },
  };
}

export function defaultKeyStore(keyFile: string, env: NodeJS.ProcessEnv = process.env): KeyStore {
  if (env.ORGSPEC_KEYSTORE === 'file') return fileKeyStore(keyFile);
  if (process.platform === 'darwin') return macKeychain();
  if (process.platform === 'linux') return secretService();
  return fileKeyStore(keyFile);
}

export const KEYCHAIN_SERVICE = 'orgspec';

/** The 256-bit key that encrypts the private database; created on first use. */
export async function dataKey(store: KeyStore): Promise<Buffer> {
  const existing = await store.get(KEYCHAIN_SERVICE, 'private-db-key');
  if (existing) return Buffer.from(existing, 'base64');
  const key = randomBytes(32);
  await store.set(KEYCHAIN_SERVICE, 'private-db-key', key.toString('base64'));
  return key;
}

/** AES-256-GCM; output is `v1.<iv>.<tag>.<ciphertext>` in base64url. */
export function encrypt(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), ct]
    .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
    .join('.');
}

export function decrypt(key: Buffer, sealed: string): string {
  const [v, iv, tag, ct] = sealed.split('.');
  if (v !== 'v1' || !iv || !tag || ct === undefined) throw new Error('Unrecognised ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}

export const sealJson = (key: Buffer, value: unknown): string => encrypt(key, JSON.stringify(value));
export const openJson = <T>(key: Buffer, sealed: string): T => JSON.parse(decrypt(key, sealed)) as T;
