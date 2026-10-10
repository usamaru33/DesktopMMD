// API spend tracking and budget control (FR-EX-09, NFR-11, spec 5.4 利用量).
import type { Settings, UsageBreakdownRow, UsageSummary } from '@shared/types';
import type { Store } from '../store/repos';
import { localDate } from '../tools/PermissionGate';
import { costUsd, type UsageLike } from './models';

export class UsageService {
  private warned = '';

  constructor(
    private readonly store: Store,
    private readonly settings: () => Settings,
    private readonly notify: (text: string, kind: 'warn' | 'error') => void,
    private readonly now: () => Date = () => new Date(),
  ) {}

  record(model: string, usage: UsageLike, purpose = 'other'): void {
    const usd = costUsd(model, usage);
    this.store.usage.add(localDate(this.now()), model, purpose, {
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheWrite: usage.cache_creation_input_tokens ?? 0,
      webSearches: usage.server_tool_use?.web_search_requests ?? 0,
      usd,
    });
    this.checkThresholds();
  }

  private monthStart(): string {
    const d = this.now();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  }

  summary(): UsageSummary {
    const budget = this.settings().llm.monthlyBudgetUsd;
    const month = this.store.usage.sumSince(this.monthStart());
    return { monthUsd: month, budgetUsd: budget, todayUsd: this.store.usage.sumOn(localDate(this.now())), degraded: budget > 0 && month >= budget };
  }

  /** This month's spend per purpose × model. */
  breakdown(): UsageBreakdownRow[] {
    return this.store.usage.breakdownSince(this.monthStart());
  }

  /** Model for proactive speech (short lines): falls back to the utility model when over budget, too. */
  proactiveModel(): string {
    const s = this.settings();
    return this.summary().degraded ? s.llm.utilityModel : s.llm.proactiveModel;
  }

  /** At 100% of the monthly budget the chat model falls back to the utility model (spec 5.4). */
  chatModel(): string {
    const s = this.settings();
    return this.summary().degraded ? s.llm.utilityModel : s.llm.chatModel;
  }

  private checkThresholds(): void {
    const { monthUsd, budgetUsd } = this.summary();
    if (budgetUsd <= 0) return;
    const key = `${this.monthStart()}:${monthUsd >= budgetUsd ? 100 : monthUsd >= budgetUsd * 0.8 ? 80 : 0}`;
    if (key.endsWith(':0') || key === this.warned) return;
    this.warned = key;
    if (key.endsWith(':100')) this.notify(`今月のAPI利用額が上限（$${budgetUsd}）に達したので、軽量モデルに切り替えました`, 'error');
    else this.notify(`今月のAPI利用額が上限の80%（$${monthUsd.toFixed(2)} / $${budgetUsd}）を超えました`, 'warn');
  }
}
