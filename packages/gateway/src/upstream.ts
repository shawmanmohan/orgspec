import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { KeyStore, Upstream } from '@orgspec/core';
import type { ToolCaller, ToolResult } from '@orgspec/integrations';
import { KeychainOAuthProvider } from './oauth.js';

export const SEP = '__';

export interface UpstreamTool {
  name: string;
  description?: string;
  inputSchema: { type: 'object'; [k: string]: unknown };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; [k: string]: unknown };
}

/** A connected upstream MCP server. */
export interface UpstreamConnection {
  listTools(): Promise<UpstreamTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  close(): Promise<void>;
}

export type Connector = (name: string, config: Upstream) => Promise<UpstreamConnection>;

export const splitName = (namespaced: string): { server: string; tool: string } => {
  const i = namespaced.indexOf(SEP);
  if (i <= 0) throw new Error(`Tool name ${namespaced} is not namespaced as server${SEP}tool`);
  return { server: namespaced.slice(0, i), tool: namespaced.slice(i + SEP.length) };
};

/** Connects with the MCP SDK over Streamable HTTP (OAuth tokens from the keychain) or stdio. */
export function sdkConnector(
  store: KeyStore,
  onAuthorize?: (server: string, url: URL) => void | Promise<void>,
): Connector {
  return async (name, config) => {
    let transport: Transport;
    if (config.transport === 'http') {
      if (!config.url) throw new Error(`${name}: http transport needs a url`);
      const authProvider = new KeychainOAuthProvider(store, name, {
        ...(config.oauth?.clientId ? { clientId: config.oauth.clientId } : {}),
        scopes: config.oauth?.scopes ?? [],
        ...(onAuthorize ? { onAuthorize: (u: URL) => onAuthorize(name, u) } : {}),
      });
      transport = new StreamableHTTPClientTransport(new URL(config.url), { authProvider });
    } else {
      if (!config.command) throw new Error(`${name}: stdio transport needs a command`);
      transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: { ...(process.env as Record<string, string>), ...config.env },
        stderr: 'ignore',
      });
    }
    const client = new Client({ name: 'orgspec-gateway', version: '0.1.0' });
    await client.connect(transport);
    return {
      async listTools() {
        const out: UpstreamTool[] = [];
        let cursor: string | undefined;
        do {
          const r = await client.listTools(cursor ? { cursor } : {});
          out.push(...(r.tools as UpstreamTool[]));
          cursor = r.nextCursor;
        } while (cursor);
        return out;
      },
      async callTool(tool, args) {
        return (await client.callTool({ name: tool, arguments: args })) as ToolResult;
      },
      close: () => client.close(),
    };
  };
}

/** All configured upstream servers, connected lazily. Implements ToolCaller for the integrations package. */
export class UpstreamPool implements ToolCaller {
  private readonly conns = new Map<string, Promise<UpstreamConnection>>();
  private toolCache = new Map<string, UpstreamTool[]>();

  constructor(
    private readonly servers: Record<string, Upstream>,
    private readonly connect: Connector,
  ) {}

  names(): string[] {
    return Object.keys(this.servers);
  }

  config(server: string): Upstream | undefined {
    return this.servers[server];
  }

  private conn(server: string): Promise<UpstreamConnection> {
    const cfg = this.servers[server];
    if (!cfg) return Promise.reject(new Error(`Unknown MCP server ${server}`));
    let p = this.conns.get(server);
    if (!p) {
      p = this.connect(server, cfg);
      p.catch(() => this.conns.delete(server));
      this.conns.set(server, p);
    }
    return p;
  }

  async tools(server: string): Promise<UpstreamTool[]> {
    const cached = this.toolCache.get(server);
    if (cached) return cached;
    const list = await (await this.conn(server)).listTools();
    this.toolCache.set(server, list);
    return list;
  }

  /** Every upstream tool, namespaced. Servers that fail to connect are skipped and reported. */
  async allTools(): Promise<{
    tools: (UpstreamTool & { server: string; upstreamName: string })[];
    errors: Record<string, string>;
  }> {
    const tools: (UpstreamTool & { server: string; upstreamName: string })[] = [];
    const errors: Record<string, string> = {};
    await Promise.all(
      this.names().map(async (s) => {
        try {
          for (const t of await this.tools(s))
            tools.push({ ...t, name: `${s}${SEP}${t.name}`, server: s, upstreamName: t.name });
        } catch (e) {
          errors[s] = (e as Error).message;
        }
      }),
    );
    tools.sort((a, b) => a.name.localeCompare(b.name));
    return { tools, errors };
  }

  async callTool(namespaced: string, args: Record<string, unknown>): Promise<ToolResult> {
    const { server, tool } = splitName(namespaced);
    return (await this.conn(server)).callTool(tool, args);
  }

  async close(): Promise<void> {
    const all = [...this.conns.values()];
    this.conns.clear();
    await Promise.all(all.map(async (p) => (await p.catch(() => undefined))?.close()));
  }
}

/** An in-process upstream for tests and demos. */
export function memoryConnector(
  servers: Record<string, { tools: UpstreamTool[]; handle: (tool: string, args: Record<string, unknown>) => unknown }>,
): Connector {
  return async (name) => {
    const s = servers[name];
    if (!s) throw new Error(`no memory server ${name}`);
    return {
      listTools: async () => s.tools,
      callTool: async (tool, args) => {
        try {
          const v = s.handle(tool, args);
          return { content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }] };
        } catch (e) {
          return { isError: true, content: [{ type: 'text', text: (e as Error).message }] };
        }
      },
      close: async () => {},
    };
  };
}

/**
 * Interactive sign-in for an HTTP upstream (`orgspec connect <server>`): opens the browser, waits for
 * the redirect on 127.0.0.1, stores tokens in the keychain and returns the server's tool count.
 */
export async function authorizeServer(
  store: KeyStore,
  name: string,
  config: Upstream,
  open: (url: URL) => void | Promise<void>,
  waitForCode: () => Promise<string>,
): Promise<number> {
  if (config.transport !== 'http' || !config.url)
    throw new Error(`${name} does not use OAuth (stdio servers use their own credentials)`);
  const { UnauthorizedError } = await import('@modelcontextprotocol/sdk/client/auth.js');
  const provider = new KeychainOAuthProvider(store, name, {
    ...(config.oauth?.clientId ? { clientId: config.oauth.clientId } : {}),
    scopes: config.oauth?.scopes ?? [],
    onAuthorize: open,
  });
  const attempt = async () => {
    const transport = new StreamableHTTPClientTransport(new URL(config.url as string), { authProvider: provider });
    const client = new Client({ name: 'orgspec-connect', version: '0.1.0' });
    return { transport, client, connect: () => client.connect(transport) };
  };
  let a = await attempt();
  try {
    await a.connect();
  } catch (e) {
    if (!(e instanceof UnauthorizedError)) throw e;
    const code = await waitForCode();
    await a.transport.finishAuth(code);
    a = await attempt();
    await a.connect();
  }
  const { tools } = await a.client.listTools();
  await a.client.close();
  return tools.length;
}
