import { createServer } from 'node:http';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { KEYCHAIN_SERVICE, type KeyStore } from '@orgspec/core';

export const OAUTH_REDIRECT_PORT = 47319;

/**
 * OAuth for upstream MCP servers. Client registration, tokens and the PKCE verifier live in the OS
 * keychain under `orgspec` / `mcp:<server>:*`.
 */
export class KeychainOAuthProvider implements OAuthClientProvider {
  private verifier = '';
  constructor(
    private readonly store: KeyStore,
    private readonly server: string,
    private readonly opts: {
      clientId?: string;
      scopes?: string[];
      port?: number;
      onAuthorize?: (url: URL) => void | Promise<void>;
    } = {},
  ) {}

  private account = (what: string) => `mcp:${this.server}:${what}`;

  get redirectUrl(): string {
    return `http://127.0.0.1:${this.opts.port ?? OAUTH_REDIRECT_PORT}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'OrgSpec',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(this.opts.scopes?.length ? { scope: this.opts.scopes.join(' ') } : {}),
    };
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const saved = await this.store.get(KEYCHAIN_SERVICE, this.account('client'));
    if (saved) return JSON.parse(saved) as OAuthClientInformationMixed;
    return this.opts.clientId ? { client_id: this.opts.clientId } : undefined;
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    await this.store.set(KEYCHAIN_SERVICE, this.account('client'), JSON.stringify(info));
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const saved = await this.store.get(KEYCHAIN_SERVICE, this.account('tokens'));
    return saved ? (JSON.parse(saved) as OAuthTokens) : undefined;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.store.set(KEYCHAIN_SERVICE, this.account('tokens'), JSON.stringify(tokens));
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    if (!this.opts.onAuthorize) throw new Error(`${this.server} needs sign-in; run: orgspec connect ${this.server}`);
    await this.opts.onAuthorize(url);
  }

  saveCodeVerifier(v: string): void {
    this.verifier = v;
  }

  codeVerifier(): string {
    return this.verifier;
  }

  async signOut(): Promise<void> {
    await this.store.delete(KEYCHAIN_SERVICE, this.account('tokens'));
    await this.store.delete(KEYCHAIN_SERVICE, this.account('client'));
  }
}

/** Waits for the OAuth redirect on 127.0.0.1 and returns the authorization code. */
export function waitForAuthCode(port = OAUTH_REDIRECT_PORT, timeoutMs = 5 * 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get('code');
      const err = url.searchParams.get('error');
      res
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          `<!doctype html><title>OrgSpec</title><p>${code ? 'Signed in. You can close this tab.' : 'Sign-in failed. You can close this tab.'}</p>`,
        );
      clearTimeout(timer);
      server.close();
      if (code) resolve(code);
      else reject(new Error(err ?? 'No authorization code'));
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('Timed out waiting for sign-in'));
    }, timeoutMs);
    server.listen(port, '127.0.0.1');
  });
}
