// Registry of built-in and MCP tools; produces the Claude tool list in a stable (sorted) order
// so the prompt cache prefix stays byte-identical (skill mmd-reply-protocol §4).
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { ToolDef } from './types';

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDef>();

  register(def: ToolDef): void {
    this.tools.set(def.name, def);
  }

  unregisterWhere(pred: (def: ToolDef) => boolean): void {
    for (const [k, v] of this.tools) if (pred(v)) this.tools.delete(k);
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }

  list(): ToolDef[] {
    return [...this.tools.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  enabled(): ToolDef[] {
    return this.list().filter((d) => !d.enabled || d.enabled());
  }

  /**
   * Claude tool definitions (client tools only; web_search is added by LlmClient).
   * approvalHint=false drops the "needs approval" wording: small local models read it as "ask the user in
   * chat first" and never call the tool (the app asks via PermissionGate regardless).
   */
  toClaudeTools(opts: { approvalHint?: boolean } = {}): Anthropic.Tool[] {
    const hint = opts.approvalHint !== false;
    return this.enabled().map((d) => ({
      name: d.name,
      description: `${hint ? d.description : d.description.replace(/必ずユーザーの(クリック)?承認が必要です。?/g, '')}${hint && d.level !== 'L0' ? `（実行前にユーザーの${d.level === 'L2' ? 'クリック' : ''}承認が必要）` : ''}`,
      input_schema: d.jsonSchema ?? toInputSchema(d.inputSchema),
    }));
  }
}

export function toInputSchema(schema: z.ZodType): Anthropic.Tool.InputSchema {
  const js = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  delete js.$schema;
  if (js.type !== 'object') return { type: 'object', properties: {} };
  return js as Anthropic.Tool.InputSchema;
}
