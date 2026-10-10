// MCP servers as extra tools (FR-TL-08, spec 5.5; skill mmd-tools-permissions §8).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import type { McpServerConfig, PermissionLevel } from '@shared/types';
import type { ToolRegistry } from '../tools/ToolRegistry';
import { type ToolDef, external, maxLevel, truncate } from '../tools/types';
import type { Logger } from '../util/logger';

const DANGEROUS = /(delete|remove|destroy|drop|send|post|publish|create_event|update_event|write|move|rename|purge|archive|reply|forward|share|invite|pay|transfer)/i;

interface Conn {
  cfg: McpServerConfig;
  client: Client;
  status: 'ok' | 'error' | 'starting';
  tools: number;
}

export class McpHub {
  private conns = new Map<string, Conn>();

  constructor(
    private readonly registry: ToolRegistry,
    private readonly log: Logger,
  ) {}

  status(): { name: string; status: 'ok' | 'error' | 'starting'; tools: number }[] {
    return [...this.conns.values()].map((c) => ({ name: c.cfg.name, status: c.status, tools: c.tools }));
  }

  async sync(servers: McpServerConfig[]): Promise<void> {
    const wanted = new Map(servers.filter((s) => s.enabled !== false).map((s) => [s.name, s]));
    for (const [name, c] of this.conns) {
      const w = wanted.get(name);
      if (!w || JSON.stringify(w) !== JSON.stringify(c.cfg)) await this.disconnect(name);
    }
    await Promise.all([...wanted.values()].filter((s) => !this.conns.has(s.name)).map((s) => this.connect(s)));
  }

  private async connect(cfg: McpServerConfig): Promise<void> {
    const safeName = cfg.name.replace(/[^\w-]/g, '_').slice(0, 30);
    const client = new Client({ name: 'desktop-mmd', version: '0.1.0' });
    const conn: Conn = { cfg, client, status: 'starting', tools: 0 };
    this.conns.set(cfg.name, conn);
    try {
      const transport = new StdioClientTransport({ command: cfg.command, args: cfg.args, stderr: 'ignore' });
      await client.connect(transport);
      const { tools } = await client.listTools();
      for (const t of tools) {
        const fullName = `mcp__${safeName}__${t.name}`.slice(0, 64);
        // raise send/delete-like tools to L2 regardless of the configured level
        const level: PermissionLevel = DANGEROUS.test(t.name) ? 'L2' : maxLevel('L1', cfg.level);
        const def: ToolDef<Record<string, unknown>> = {
          name: fullName,
          title: `${cfg.name}: ${t.title ?? t.name}`,
          description: `[MCP ${cfg.name}] ${t.description ?? t.name}`.slice(0, 1000),
          inputSchema: z.record(z.string(), z.unknown()),
          jsonSchema: { ...(t.inputSchema as object), type: 'object' } as ToolDef['jsonSchema'],
          level,
          readsExternal: true,
          summarize: (input) => ({ targets: [`${cfg.name} / ${t.name}`], summary: truncate(JSON.stringify(input), 300) }),
          run: async (input, ctx) => {
            const r = await client.callTool({ name: t.name, arguments: input }, undefined, { signal: ctx.signal, timeout: 60_000 });
            const parts = (r.content as { type: string; text?: string }[] | undefined) ?? [];
            const text = parts.map((p) => (p.type === 'text' ? p.text : `[${p.type}]`)).join('\n');
            return { ok: !r.isError, content: external(`mcp:${cfg.name}`, truncate(text || '(結果なし)', 20_000)) };
          },
        };
        this.registry.register(def);
        conn.tools++;
      }
      conn.status = 'ok';
      this.log.info(`MCP ${cfg.name}: ${conn.tools} tools`);
    } catch (e) {
      conn.status = 'error';
      this.log.warn(`MCP ${cfg.name} failed`, e);
    }
  }

  private async disconnect(name: string): Promise<void> {
    const c = this.conns.get(name);
    if (!c) return;
    this.conns.delete(name);
    const safeName = name.replace(/[^\w-]/g, '_').slice(0, 30);
    this.registry.unregisterWhere((d) => d.name.startsWith(`mcp__${safeName}__`));
    try {
      await c.client.close();
    } catch {
      /* ignore */
    }
  }

  async close(): Promise<void> {
    for (const name of [...this.conns.keys()]) await this.disconnect(name);
  }
}
