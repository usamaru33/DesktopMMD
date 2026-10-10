import type Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';
import type { PermissionLevel } from '@shared/types';
import type { PathGuard } from './pathGuard';

export interface ApprovalSummary {
  /** paths, URLs, recipients — shown in full for L2 */
  targets: string[];
  /** one-line description of the change */
  summary: string;
}

export type UndoInfo =
  | { kind: 'restore'; backup: string; to: string }
  | { kind: 'deleteCreated'; path: string }
  | { kind: 'moveBack'; from: string; to: string }
  | { kind: 'trash'; path: string };

export type ToolContent = string | (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[];

export interface ToolResult {
  ok: boolean;
  content: ToolContent;
  undo?: UndoInfo;
  /** short Japanese note for the speech bubble, e.g. "Documents を見ました" */
  note?: string;
}

export interface ToolContext {
  turnId: number;
  toolRunId: number;
  signal: AbortSignal;
  guard: PathGuard;
  backupDir: string;
  now(): Date;
}

export interface ToolDef<I = any> {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodType<I>;
  /** JSON schema sent to Claude. Generated from inputSchema if omitted. */
  jsonSchema?: Anthropic.Tool.InputSchema;
  level: PermissionLevel;
  pathArgs?: string[];
  readsExternal?: boolean;
  undoable?: boolean;
  /** hidden from Claude unless this returns true */
  enabled?(): boolean;
  summarize(input: I): ApprovalSummary;
  run(input: I, ctx: ToolContext): Promise<ToolResult>;
}

export function levelRank(l: PermissionLevel): number {
  return l === 'L0' ? 0 : l === 'L1' ? 1 : 2;
}

export function maxLevel(a: PermissionLevel, b: PermissionLevel | undefined): PermissionLevel {
  if (!b) return a;
  return levelRank(b) > levelRank(a) ? b : a;
}

/** Wrap content from outside the user's own words so the model treats it as data (spec 7.1). */
export function external(source: string, body: string): string {
  const safe = body.replace(/<\/?external_data[^>]*>/gi, '');
  return `<external_data source="${source.replace(/"/g, "'")}">\n${safe}\n</external_data>`;
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n(以下省略、全${s.length}文字)`;
}
