// Pending approval cards: shows them, resolves them from clicks, voice, Esc or timeout (spec 3.4).
import { randomUUID } from 'node:crypto';
import type { ApprovalAnswer, ApprovalRequest } from '@shared/types';
import { LIMITS } from '@shared/defaults';
import { classifyVoiceAnswer, type ApprovalAsk } from './PermissionGate';

interface Pending {
  req: ApprovalRequest;
  resolve: (a: ApprovalAnswer | 'timeout') => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface BrokerDeps {
  show(req: ApprovalRequest): void;
  resolved(id: string, decision: string): void;
  onPendingChange(count: number): void;
  timeoutMs?: number;
  now?: () => number;
}

export type VoiceApprovalResult = 'approved' | 'denied' | 'needs_click' | 'not_an_answer' | 'none_pending';

export class ApprovalBroker {
  private readonly pending = new Map<string, Pending>();
  constructor(private readonly deps: BrokerDeps) {}

  get count(): number {
    return this.pending.size;
  }

  get current(): ApprovalRequest | null {
    const first = this.pending.values().next();
    return first.done ? null : first.value.req;
  }

  request(ask: ApprovalAsk, signal: AbortSignal): Promise<ApprovalAnswer | 'timeout'> {
    const timeoutMs = this.deps.timeoutMs ?? LIMITS.approvalTimeoutMs;
    const now = this.deps.now?.() ?? Date.now();
    const req: ApprovalRequest = { ...ask, id: randomUUID(), expiresAt: now + timeoutMs };
    return new Promise((resolve) => {
      const finish = (a: ApprovalAnswer | 'timeout') => {
        const p = this.pending.get(req.id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(req.id);
        signal.removeEventListener('abort', onAbort);
        this.deps.resolved(req.id, a);
        this.deps.onPendingChange(this.pending.size);
        resolve(a);
      };
      const onAbort = () => finish('deny');
      const timer = setTimeout(() => finish('timeout'), timeoutMs);
      this.pending.set(req.id, { req, resolve: finish, timer });
      if (signal.aborted) return finish('deny');
      signal.addEventListener('abort', onAbort, { once: true });
      this.deps.show(req);
      this.deps.onPendingChange(this.pending.size);
    });
  }

  /** Click on the card. "always_today" is only accepted where allowed. */
  answer(id: string, answer: ApprovalAnswer): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    if (answer === 'always_today' && !p.req.alwaysTodayAllowed) answer = 'approve';
    p.resolve(answer);
    return true;
  }

  /** A transcript arrived while a card is shown. L2 never accepts voice approval (TC-07). */
  voice(text: string): VoiceApprovalResult {
    const p = this.pending.values().next().value as Pending | undefined;
    if (!p) return 'none_pending';
    const c = classifyVoiceAnswer(text);
    if (!c) return 'not_an_answer';
    if (c === 'deny') {
      p.resolve('deny');
      return 'denied';
    }
    if (!p.req.voiceAllowed) return 'needs_click';
    p.resolve('approve');
    return 'approved';
  }

  denyAll(): void {
    for (const p of [...this.pending.values()]) p.resolve('deny');
  }
}
