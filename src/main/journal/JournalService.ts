// 夜のふりかえり日記: once a day (at the configured time) summarize the day's conversation and work into a
// Markdown file in the user's journal folder. The app writes the file; the model only produces text, and never
// chooses a path. The folder must be inside the allowed folders (same rule as every other file write).
import nodePath from 'node:path';
import type { JournalRunResult, Settings } from '@shared/types';
import type { LlmAdapter } from '../llm/LlmClient';
import type { PathGuard } from '../tools/pathGuard';
import type { Logger } from '../util/logger';
import type { Store } from '../store/repos';
import {
  buildJournalPrompt, cleanJournalBody, dateKey, hasMaterial, isGeneratedJournal, JOURNAL_SYSTEM, journalFileName,
  localDayRange, parseClock, renderJournal, stripReplyMarkup, type JournalMaterial,
} from './journal';

export interface JournalFs {
  mkdir(dir: string): void;
  exists(file: string): boolean;
  read(file: string): string;
  write(file: string, data: string): void;
}

export interface JournalDeps {
  store: Pick<Store, 'conv' | 'memories' | 'toolRuns'>;
  llm(): LlmAdapter;
  model(): string;
  settings(): Settings;
  guard: Pick<PathGuard, 'check'>;
  toolTitle(name: string): string;
  now(): Date;
  fs: JournalFs;
  toast(text: string, kind?: 'info' | 'warn' | 'error'): void;
  log: Logger;
  /** the character, for a closing word in its own voice (none = no closing word) */
  character?(): { name: string; persona: string } | null;
}

const RETRY_AFTER_FAILURE_MS = 30 * 60_000;
const MAX_TOMORROW_MS = 24 * 3600_000;

export class JournalService {
  private busy = false;
  /** days already handled by the automatic run (this process) */
  private readonly done = new Set<string>();
  private readonly retryAt = new Map<string, number>();
  private checkedYesterday = false;

  constructor(private readonly d: JournalDeps) {}

  /** Called every minute. Cheap unless it is time to write. */
  async tick(): Promise<void> {
    const cfg = this.d.settings().journal;
    if (!cfg.enabled || this.busy) return;
    const now = this.d.now();
    const at = parseClock(cfg.time);
    if (at === null) return;
    const days: Date[] = [];
    // right after the app starts: yesterday may have been missed (PC was off at the usual time)
    if (!this.checkedYesterday) {
      this.checkedYesterday = true;
      days.push(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
    }
    if (now.getHours() * 60 + now.getMinutes() >= at) days.push(now);
    for (const day of days) {
      const key = dateKey(day);
      if (this.done.has(key) || (this.retryAt.get(key) ?? 0) > now.getTime()) continue;
      const r = await this.run(day, false);
      // no_material: the user may still talk before midnight, so look again next minute (no LLM call is made)
      if (r.ok) this.done.add(key);
      else if (r.reason === 'failed') this.retryAt.set(key, now.getTime() + RETRY_AFTER_FAILURE_MS);
      else if (r.reason !== 'no_material') {
        this.done.add(key);
        this.d.log.info(`journal skipped for ${key}: ${r.reason}`); // e.g. the folder is outside the allowed folders
      }
    }
  }

  /** Write the diary for `day`. manual=true regenerates a file this feature wrote earlier. */
  async run(day: Date, manual: boolean): Promise<JournalRunResult> {
    if (this.busy) return { ok: false, reason: 'busy', message: 'いま作っています。少し待ってください' };
    this.busy = true;
    try {
      return await this.write(day, manual);
    } catch (e) {
      this.d.log.warn('journal failed', e);
      return { ok: false, reason: 'failed', message: '日記を保存できませんでした' };
    } finally {
      this.busy = false;
    }
  }

  private async write(day: Date, manual: boolean): Promise<JournalRunResult> {
    const s = this.d.settings();
    const cfg = s.journal;
    if (!manual && !cfg.enabled) return { ok: false, reason: 'disabled', message: '日記はOFFです' };

    const folder = this.d.guard.check(cfg.folder);
    if (!folder.ok) {
      return { ok: false, reason: 'folder', message: '保存先が許可フォルダの外です。許可フォルダの中を選ぶか、許可フォルダに追加してください' };
    }
    const material = this.collect(day);
    if (!hasMaterial(material)) {
      return {
        ok: false,
        reason: 'no_material',
        message: s.privacy.saveTranscripts ? 'この日はまだ会話がありません' : '会話の保存がOFFなので、日記の材料がありません',
      };
    }

    // pick the file: reuse our own file for this day, never overwrite someone else's
    this.d.fs.mkdir(folder.real);
    let target: string | null = null;
    for (let n = 1; n <= 9 && !target; n++) {
      const checked = this.d.guard.check(nodePath.win32.join(folder.real, journalFileName(day, n)));
      if (!checked.ok) return { ok: false, reason: 'folder', message: '保存先が許可フォルダの外です' };
      if (!this.d.fs.exists(checked.real)) target = checked.real;
      else if (isGeneratedJournal(this.d.fs.read(checked.real))) {
        if (!manual) return { ok: true, path: checked.real, message: 'この日の日記はもうあります' };
        target = checked.real;
      }
    }
    if (!target) return { ok: false, reason: 'failed', message: '同じ日付のファイルが多すぎて保存できませんでした' };

    let body: string;
    try {
      body = cleanJournalBody(
        await this.d.llm().text({ model: this.d.model(), system: JOURNAL_SYSTEM, user: buildJournalPrompt(material, day), maxTokens: 1500, purpose: 'journal' }),
      );
    } catch (e) {
      this.d.log.warn('journal llm failed', e);
      return { ok: false, reason: 'failed', message: 'AIにつながらず、日記を作れませんでした' };
    }
    if (!body) return { ok: false, reason: 'failed', message: '日記の文章が空でした' };

    this.d.fs.write(target, renderJournal(day, body));
    this.d.log.info(`journal saved for ${dateKey(day)}`); // no content in logs
    if (!manual) this.d.toast(`${day.getMonth() + 1}月${day.getDate()}日のふりかえりを保存しました`, 'info');
    return { ok: true, path: target, message: '日記を保存しました' };
  }

  /** Gather the day's material from the store. */
  collect(day: Date): JournalMaterial {
    const { from, to } = localDayRange(day);
    const a = from.toISOString();
    const b = to.toISOString();
    const tomorrowTo = new Date(to.getTime() + MAX_TOMORROW_MS);
    return {
      messages: this.d.store.conv
        .messagesBetween(a, b)
        .flatMap((m) => (m.role === 'user' || m.role === 'assistant' ? [{ role: m.role, content: m.content, at: new Date(m.createdAt) }] : [])),
      works: this.d.store.toolRuns.executedBetween(a, b).map((r) => this.d.toolTitle(r.tool)),
      memories: this.d.store.memories.createdBetween(a, b).map((m) => stripReplyMarkup(m.content)),
      tomorrow: this.d.store.memories.schedulesDueBetween(to.toISOString(), tomorrowTo.toISOString()).map((m) => stripReplyMarkup(m.content)),
      character: this.d.character?.() ?? undefined,
    };
  }
}
