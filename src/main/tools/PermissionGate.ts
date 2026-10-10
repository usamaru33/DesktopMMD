// The only path from a model tool_use to an executed tool (spec 5.5 判定の順序, 7.2).
import type { ApprovalAnswer, ApprovalRequest, PermissionLevel, ToolDecision } from '@shared/types';
import { PATH_REASON_JA, type PathGuard } from './pathGuard';
import { type ToolDef, type ToolResult, levelRank, maxLevel } from './types';

export interface TurnState {
  turnId: number;
  messageId: number | null;
  /** set once any readsExternal tool ran in this turn: disables "always today" (spec 7.1) */
  externalRead: boolean;
  signal: AbortSignal;
}

export type ApprovalAsk = Omit<ApprovalRequest, 'id' | 'expiresAt'>;

export interface GateDeps {
  guard: PathGuard;
  levelOverride(tool: string): PermissionLevel | undefined;
  requestApproval(req: ApprovalAsk, signal: AbortSignal): Promise<ApprovalAnswer | 'timeout'>;
  recordRun(rec: { tool: string; level: PermissionLevel; args: unknown; decision: ToolDecision; messageId: number | null }): number;
  finishRun(id: number, result: ToolResult): void;
  now(): Date;
  backupDir: string;
}

export interface GateOutcome {
  decision: ToolDecision;
  level: PermissionLevel;
  result: ToolResult;
  runId: number | null;
}

export class PermissionGate {
  /** tool name -> local date (YYYY-MM-DD) it was "always allowed" for */
  private readonly alwaysToday = new Map<string, string>();

  constructor(private readonly deps: GateDeps) {}

  effectiveLevel(def: ToolDef): PermissionLevel {
    return maxLevel(def.level, this.deps.levelOverride(def.name));
  }

  async execute(def: ToolDef | undefined, rawInput: unknown, turn: TurnState, toolName = def?.name ?? '?'): Promise<GateOutcome> {
    // ① tool exists and is enabled
    if (!def || (def.enabled && !def.enabled())) {
      return this.blocked(toolName, 'L0', rawInput, turn, `ツール「${toolName}」は使えません。`);
    }
    const level = this.effectiveLevel(def);

    // ② argument schema
    const parsed = def.inputSchema.safeParse(rawInput);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
      return this.blocked(def.name, level, rawInput, turn, `引数が正しくありません: ${issues}`);
    }
    const input = parsed.data as Record<string, unknown>;

    // ③ paths, normalized and resolved; rewrite input with the real path
    for (const key of def.pathArgs ?? []) {
      const v = input[key];
      if (v === undefined || v === null || v === '') continue;
      const list = Array.isArray(v) ? v : [v];
      const resolved: string[] = [];
      for (const item of list) {
        if (typeof item !== 'string') return this.blocked(def.name, level, rawInput, turn, `${key} が文字列ではありません。`);
        // dropped files may be read (only by L0 read-only tools), never written
        const chk = this.deps.guard.check(item, { forRead: def.level === 'L0' && !!def.readsExternal && level === 'L0' });
        if (!chk.ok) {
          const allowed = this.deps.guard.allowedDirs.join('、');
          return this.blocked(
            def.name, level, rawInput, turn,
            `実行しませんでした: ${PATH_REASON_JA[chk.reason] ?? chk.reason}（${item}）。許可フォルダ: ${allowed || 'なし'}`,
          );
        }
        resolved.push(chk.real);
      }
      input[key] = Array.isArray(v) ? resolved : resolved[0];
    }

    // ④ "always allow today" (L1 only, not after external content was read this turn)
    let decision: ToolDecision = 'auto';
    if (level !== 'L0') {
      const today = localDate(this.deps.now());
      const always = level === 'L1' && !turn.externalRead && this.alwaysToday.get(def.name) === today;
      if (!always) {
        // ⑤ approval
        const summary = def.summarize(input as never);
        const answer = await this.deps.requestApproval(
          {
            tool: def.name,
            title: def.title,
            targets: summary.targets,
            summary: summary.summary,
            level,
            voiceAllowed: level === 'L1' && !turn.externalRead,
            alwaysTodayAllowed: level === 'L1' && !turn.externalRead,
          },
          turn.signal,
        );
        if (answer === 'timeout' || answer === 'deny') {
          const d: ToolDecision = answer === 'timeout' ? 'timeout' : 'denied';
          const id = this.deps.recordRun({ tool: def.name, level, args: input, decision: d, messageId: turn.messageId });
          const result: ToolResult = {
            ok: false,
            content: answer === 'timeout' ? 'ユーザーが60秒以内に応答しなかったため、実行しませんでした。' : 'ユーザーが許可しなかったため、実行しませんでした。',
          };
          this.deps.finishRun(id, result);
          return { decision: d, level, result, runId: id };
        }
        if (answer === 'always_today' && level === 'L1' && !turn.externalRead) this.alwaysToday.set(def.name, today);
        decision = 'approved';
      } else {
        decision = 'approved';
      }
    }

    const runId = this.deps.recordRun({ tool: def.name, level, args: input, decision, messageId: turn.messageId });
    let result: ToolResult;
    try {
      result = await def.run(input as never, {
        turnId: turn.turnId,
        toolRunId: runId,
        signal: turn.signal,
        guard: this.deps.guard,
        backupDir: this.deps.backupDir,
        now: this.deps.now,
      });
    } catch (e) {
      result = { ok: false, content: `実行中にエラーが起きました: ${(e as Error).message}` };
    }
    if (def.readsExternal) turn.externalRead = true;
    this.deps.finishRun(runId, result);
    return { decision, level, result, runId };
  }

  clearAlwaysToday(): void {
    this.alwaysToday.clear();
  }

  private blocked(tool: string, level: PermissionLevel, args: unknown, turn: TurnState, message: string): GateOutcome {
    const id = this.deps.recordRun({ tool, level, args, decision: 'blocked', messageId: turn.messageId });
    const result: ToolResult = { ok: false, content: message };
    this.deps.finishRun(id, result);
    return { decision: 'blocked', level, result, runId: id };
  }
}

export function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---------- voice approval (spec 3.4, skill §5) ----------

const YES = /^(はい|うん|いいよ|いいです|いいですよ|お願い|おねがい|お願いします|ok|オーケー|おけ|許可|どうぞ|やって|よろしく|大丈夫|オッケー)/i;
const NO = /^(だめ|ダメ|駄目|いいえ|いや|やめて|やめ|キャンセル|ストップ|しないで|拒否|ノー|no\b|待って)/i;

export function classifyVoiceAnswer(text: string): 'approve' | 'deny' | null {
  const t = text.normalize('NFKC').replace(/[、。！？!?\s]/g, '').toLowerCase();
  if (!t) return null;
  if (NO.test(t)) return 'deny';
  if (YES.test(t)) return 'approve';
  return null;
}

export function isStricter(a: PermissionLevel, b: PermissionLevel): boolean {
  return levelRank(a) > levelRank(b);
}
