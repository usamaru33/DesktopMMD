// The conductor (spec 2.5, 5.1): input queue → memory search → Claude (streaming) → tools → speech.
import type { Emotion } from '@shared/emotions';
import { LIMITS } from '@shared/defaults';
import type { CharacterPreset, CharacterState, Effort, Settings } from '@shared/types';
import type { MemoryPortForTurns, TtsPort, TurnInput, UiPort } from '../adapters';
import { type BetaMessage, type BetaTool, type LlmAdapter, LlmUnavailableError, type Msg } from '../llm/LlmClient';
import { buildSessionSystem, buildTurnContext, proactiveUserMessage, SUMMARY_SYSTEM } from '../llm/PromptBuilder';
import { dominantEmotion, ReplyParser, type ReplyEvent } from '../llm/ReplyParser';
import type { Store } from '../store/repos';
import type { SkillFile } from '../character/skillFile';
import { modeNotice } from '../character/skillPrompt';
import type { ApprovalBroker } from '../tools/ApprovalBroker';
import type { PermissionGate, TurnState } from '../tools/PermissionGate';
import type { ToolRegistry } from '../tools/ToolRegistry';
import type { ToolResult } from '../tools/types';
import type { Logger } from '../util/logger';
import { ConversationSession } from './ConversationSession';

export interface OrchestratorDeps {
  llm(): LlmAdapter;
  chatModel(): string;
  /** short proactive lines don't need the chat model */
  proactiveModel(): string;
  /** prompt cache lifetime for chat requests */
  cacheTtl?(): '5m' | '1h';
  utilityModel(): string;
  effort(): Effort;
  store: Store;
  settings(): Settings;
  character(): CharacterPreset;
  /** characters/<id>/skill.md（検証エラーなし）。新しいセッションの開始時に読む */
  skill?(): SkillFile | null;
  /** いま有効なキャラクターのモード（skill.md の overlays のどれか）。null = なし */
  mode?(): string | null;
  tools: ToolRegistry;
  gate: PermissionGate;
  broker: ApprovalBroker;
  tts: TtsPort;
  ui: UiPort;
  memory: MemoryPortForTurns;
  activeApp(): string | null;
  webSearchEnabled(): boolean;
  /** true: 会話だけのセッションにする（ローカルAI）。ツールもWeb検索も渡さない */
  chatOnly?(): boolean;
  /** false: ツールの説明やプロンプトに「承認が必要」と書かない（ローカルの小型モデル向け。承認はアプリが必ず取る） */
  approvalHint?(): boolean;
  now(): Date;
  log: Logger;
  onLatency?(r: { turnId: number; source: string; speechEnd?: number; transcript?: number; firstToken?: number; firstSentence?: number; firstAudio?: number }): void;
  onTurnDone?(info: { turnId: number; proactive: boolean; replied: boolean }): void;
}

interface ActiveTurn {
  id: number;
  input: TurnInput;
  abort: AbortController;
  spoken: string[]; // raw text (with tags) of sentences shown so far in the current round
  startedAt: number;
}

const SORRY_NETWORK = '[troubled:0.7] ごめんなさい、うまくつながらないみたいです。少し時間をおいてもう一度お願いします。';
const SORRY_NO_KEY = '[troubled:0.6] まだAPIキーが設定されていないので、お返事ができません。設定画面から登録してくださいね。';
const SORRY_REFUSAL = '[troubled:0.6] ごめんなさい、そのお話にはお答えできないんです。';
const SORRY_LOCAL = '[troubled:0.7] ローカルのAIから返事がありません。Ollamaが起動していて、モデルが入っているか、設定画面で確認してもらえますか？';
const SORRY_AUTH = '[troubled:0.7] APIキーが正しくないみたいです。設定画面で確認してもらえますか？';

export class Orchestrator {
  private queue: TurnInput[] = [];
  private running: ActiveTurn | null = null;
  private session: ConversationSession | null = null;
  private turnSeq = 0;
  private sentenceSeq = 0;
  private listening = false;
  private acting = false;
  private speaking = false;
  private lastEmotion: Emotion = 'neutral';
  private lastToolSummary: string | null = null;
  private lastConversationAt: Date | null = null;
  private currentState: CharacterState = 'idle';
  private parserStats = { replies: 0, malformed: 0 };
  private turnOrigins = new Map<number, { origin: number; source: string }>();
  /** スキルはセッション単位で固定（途中で skill.md を書き換えても次のセッションから） */
  private sessionSkill: SkillFile | null = null;

  constructor(private readonly d: OrchestratorDeps) {}

  get state(): CharacterState {
    return this.currentState;
  }

  get busy(): boolean {
    return !!this.running || this.queue.length > 0;
  }

  get lastConversation(): Date | null {
    return this.lastConversationAt;
  }

  /** Where a turn's latency clock started (for the first-audio measurement). */
  latencyOrigin(turnId: number): { origin: number; source: string } | null {
    return this.turnOrigins.get(turnId) ?? null;
  }

  get formatStats() {
    return { ...this.parserStats };
  }

  /** Enqueue an input (spec 5.1). Proactive turns are dropped unless completely idle. */
  submit(input: TurnInput): boolean {
    if (input.kind === 'proactive' && (this.busy || this.listening || this.d.broker.count > 0)) return false;
    if (input.kind === 'user' && input.text.trim() === '' && !input.files?.length) return false;
    this.queue.push(input);
    void this.pump();
    return true;
  }

  setListening(on: boolean): void {
    this.listening = on;
    this.refreshState();
  }

  /** Esc: stop speech and generation; deny pending approvals (spec 3.3). */
  cancel(reason = 'esc'): void {
    this.d.log.info(`cancel (${reason})`);
    this.queue = this.queue.filter((q) => q.kind === 'user' && reason === 'barge-in');
    this.running?.abort.abort();
    this.d.broker.denyAll();
    this.d.tts.cancel();
    this.speaking = false;
    this.refreshState();
  }

  /** User started talking while the assistant speaks (FR-IN-05). */
  bargeIn(): void {
    if (!this.running && !this.speaking) return;
    this.cancel('barge-in');
    this.setListening(true);
  }

  /** Forget short-term history ("この会話は記憶しないで" keeps working via store flag). */
  endSession(): void {
    this.session = null;
  }

  refreshState(): void {
    let s: CharacterState;
    if (this.d.settings().sleeping) s = 'sleeping';
    else if (this.d.broker.count > 0) s = 'awaiting';
    else if (this.listening) s = 'listening';
    else if (this.acting) s = 'acting';
    else if (this.speaking) s = 'speaking';
    else if (this.running) s = 'thinking';
    else s = 'idle';
    if (s !== this.currentState) {
      this.currentState = s;
      this.d.ui.state(s);
    }
  }

  // ------------------------------------------------------------------

  private async pump(): Promise<void> {
    if (this.running) return;
    const input = this.queue.shift();
    if (!input) return;
    const turn: ActiveTurn = { id: ++this.turnSeq, input, abort: new AbortController(), spoken: [], startedAt: Date.now() };
    // latency origin: end of speech for voice turns, submission time otherwise (NFR-01/02)
    this.turnOrigins.set(turn.id, {
      origin: input.kind === 'user' && input.speechEndAt ? input.speechEndAt : turn.startedAt,
      source: input.kind === 'user' ? input.source : 'proactive',
    });
    if (this.turnOrigins.size > 50) this.turnOrigins.delete(this.turnOrigins.keys().next().value!);
    this.running = turn;
    this.refreshState();
    let replied = false;
    try {
      replied = await this.runTurn(turn);
    } catch (e) {
      this.d.log.error('turn failed', e);
    } finally {
      this.running = null;
      this.acting = false;
      this.refreshState();
      this.d.onTurnDone?.({ turnId: turn.id, proactive: input.kind === 'proactive', replied });
      void this.pump();
    }
  }

  private ensureSession(now: Date): ConversationSession {
    const s = this.session;
    if (s && now.getTime() - s.lastActivityAt.getTime() < LIMITS.sessionGapMs) return s;
    if (s) this.d.memory.onTurnFinished(s.dbId); // let the extractor pick the old one up
    const settings = this.d.settings();
    const dbSession = this.d.store.conv.createSession(now);
    const chatOnly = this.d.chatOnly?.() ?? false;
    const approvalHint = this.d.approvalHint?.() ?? true;
    const tools: BetaTool[] = chatOnly ? [] : [...this.d.tools.toClaudeTools({ approvalHint })];
    if (!chatOnly && this.d.webSearchEnabled()) tools.push({ type: 'web_search_20260209', name: 'web_search', max_uses: LIMITS.webSearchPerReply });
    const skill = this.d.skill?.() ?? null;
    this.sessionSkill = skill;
    const system = buildSessionSystem({
      skill,
      character: this.d.character(),
      callName: settings.user.callName,
      affinityStage: this.d.memory.stage(),
      profile: this.d.memory.profile(),
      allowedDirs: settings.tools.allowedDirs,
      apps: settings.tools.apps.map((a) => a.name),
      webSearch: !chatOnly && this.d.webSearchEnabled(),
      tools: !chatOnly,
      approvalNote: approvalHint,
    });
    this.session = new ConversationSession({ dbId: dbSession.id, system, tools, startedAt: now });
    this.lastToolSummary = null;
    this.d.log.info(`new session #${dbSession.id} (${tools.length} tools)`);
    return this.session;
  }

  private async runTurn(turn: ActiveTurn): Promise<boolean> {
    const now = this.d.now();
    const session = this.ensureSession(now);
    const settings = this.d.settings();
    const input = turn.input;
    const save = settings.privacy.saveTranscripts;

    // ---- user message ----
    let userText: string;
    let source: 'voice' | 'text' | 'drop' | 'proactive';
    if (input.kind === 'user') {
      source = input.source;
      userText = input.text.trim() || (input.files?.length ? 'このファイルをどうしたらいいか聞いて。' : '');
      if (/この会話は記憶しないで|この会話は覚えないで/.test(userText)) this.d.store.conv.setNoMemory(session.dbId);
    } else {
      source = 'proactive';
      userText = proactiveUserMessage(input.trigger, input.detail);
    }
    const userMsg = save
      ? this.d.store.conv.addMessage({ sessionId: session.dbId, role: 'user', source, content: userText, now })
      : null;

    // ---- memory search (with a short time budget to protect NFR-01) ----
    let memories: Awaited<ReturnType<MemoryPortForTurns['search']>> = [];
    if (input.kind === 'user' && userText) {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 400);
      try {
        memories = await this.d.memory.search(userText, ac.signal);
      } catch (e) {
        this.d.log.warn('memory search failed', e);
      } finally {
        clearTimeout(t);
      }
    }

    // mode switches are appended to the conversation, never by rewriting the system prompt
    const wantMode = this.sessionSkill ? (this.d.mode?.() ?? null) : null;
    const notice = modeNotice(this.sessionSkill, session.modeSent, wantMode);
    session.modeSent = wantMode;
    const context = buildTurnContext({
      modeNotice: notice,
      now,
      source,
      lastConversationAt: this.lastConversationAt,
      activeApp: settings.privacy.watchActiveWindow ? this.d.activeApp() : null,
      memories,
      lastToolSummary: this.lastToolSummary,
      droppedFiles: input.kind === 'user' ? input.files : undefined,
    });
    session.appendUser(userText, context, now);
    if (memories.length) this.d.memory.markUsed(memories.map((m) => m.id));

    // ---- generate, with tool round trips ----
    const turnState: TurnState = { turnId: turn.id, messageId: userMsg?.id ?? null, externalRead: false, signal: turn.abort.signal };
    const rawParts: string[] = [];
    const allEvents: ReplyEvent[] = [];
    const toolRunIds: number[] = [];
    let tokensIn = 0;
    let tokensOut = 0;
    let firstToken: number | undefined;
    let firstSentence: number | undefined;
    let replied = false;
    this.lastToolSummary = null;

    try {
      for (let round = 0; round <= LIMITS.toolRoundTrips; round++) {
        const parser = new ReplyParser(this.lastEmotion);
        turn.spoken = [];
        const emit = (events: ReplyEvent[]) => {
          for (const ev of events) {
            allEvents.push(ev);
            if (ev.type === 'sentence') {
              firstSentence ??= Date.now();
              this.emitSentence(turn, ev.text, ev.emotion, ev.intensity);
              this.lastEmotion = ev.emotion;
              replied = true;
            } else this.d.ui.detail(turn.id, ev.markdown);
          }
        };
        let msg: BetaMessage;
        try {
          const proactive = input.kind === 'proactive';
          msg = await this.d.llm().stream({
            model: proactive ? this.d.proactiveModel() : this.d.chatModel(),
            system: session.system,
            messages: session.requestMessages(),
            tools: round < LIMITS.toolRoundTrips ? session.tools : [],
            maxTokens: LIMITS.chatMaxTokens,
            effort: this.d.effort(),
            signal: turn.abort.signal,
            // spend is recorded per purpose so the usage screen can show where money goes
            purpose: proactive ? 'proactive' : round === 0 ? 'chat' : 'tool_followup',
            // proactive lines come after ≥10 min of silence: the cache is cold and won't be reused by this model
            cache: !proactive,
            cacheTtl: this.d.cacheTtl?.() ?? '5m',
            onText: (delta) => {
              firstToken ??= Date.now();
              emit(parser.push(delta));
            },
          });
        } catch (e) {
          if (turn.abort.signal.aborted) throw e;
          emit(parser.end());
          const reason = e instanceof LlmUnavailableError ? e.reason : 'network';
          this.d.log.warn(`llm error: ${reason}`, e);
          const sorry = reason === 'no_key' ? SORRY_NO_KEY : reason === 'auth' ? SORRY_AUTH : reason === 'local_down' ? SORRY_LOCAL : SORRY_NETWORK;
          this.speakFixed(turn, sorry);
          rawParts.push(sorry);
          session.appendAssistant([{ type: 'text', text: turn.spoken.join('') || sorry }]);
          break;
        }
        emit(parser.end());
        this.parserStats.replies++;
        if (parser.malformed && parser.stats.sentences > 0) {
          this.parserStats.malformed++;
          this.d.log.warn('reply had no emotion tags');
        }
        tokensIn += (msg.usage.input_tokens ?? 0) + (msg.usage.cache_read_input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0);
        tokensOut += msg.usage.output_tokens ?? 0;

        if (msg.stop_reason === 'refusal') {
          this.speakFixed(turn, SORRY_REFUSAL);
          rawParts.push(SORRY_REFUSAL);
          session.appendAssistant(msg.content.length ? msg.content : [{ type: 'text', text: '…' }]);
          break;
        }

        const text = msg.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
        if (text) rawParts.push(text);
        session.appendAssistant(msg.content.length ? msg.content : [{ type: 'text', text: '…' }]);

        if (msg.stop_reason === 'pause_turn') continue;

        const toolUses = msg.content.filter((b): b is Extract<typeof b, { type: 'tool_use' }> => b.type === 'tool_use');
        if (msg.stop_reason !== 'tool_use' || toolUses.length === 0) break;
        if (msg.stop_reason === 'tool_use' && round === LIMITS.toolRoundTrips) break;

        // ---- run tools (sequentially: approvals are one card at a time) ----
        const results: Extract<Msg['content'], unknown[]> = [];
        for (const tu of toolUses) {
          if (turn.abort.signal.aborted) {
            results.push({ type: 'tool_result', tool_use_id: tu.id, is_error: true, content: 'ユーザーが中断しました' });
            continue;
          }
          this.acting = true;
          this.refreshState();
          const def = this.d.tools.get(tu.name) ?? this.d.tools.get(tu.name.toLowerCase());
          const outcome = await this.d.gate.execute(def, tu.input, turnState, tu.name);
          this.acting = false;
          this.refreshState();
          if (outcome.runId) toolRunIds.push(outcome.runId);
          const r: ToolResult = outcome.result;
          if (r.ok && r.note && outcome.level === 'L0') this.d.ui.toast(r.note, 'info');
          this.lastToolSummary = `${def?.title ?? tu.name}: ${r.ok ? '成功' : '失敗'}`;
          results.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            is_error: !r.ok || undefined,
            content: typeof r.content === 'string' ? r.content : r.content,
          } as (typeof results)[number]);
        }
        session.appendToolResults(results);
        if (turn.abort.signal.aborted) break;
      }
    } catch (e) {
      if (!turn.abort.signal.aborted) throw e;
      // interrupted: keep only what was actually shown/spoken (spec 5.1)
      const spoken = turn.spoken.join('');
      const last = session.messages[session.messages.length - 1];
      if (!last || last.role !== 'assistant') session.appendAssistant([{ type: 'text', text: spoken || '…' }]);
      if (spoken) rawParts.push(spoken);
    }

    // a tool_use left without results (abort right after the assistant turn) must still be answered
    this.closeDanglingToolUse(session);

    const raw = rawParts.join('\n');
    const emotion = dominantEmotion(allEvents);
    if (save && raw) {
      const m = this.d.store.conv.addMessage({ sessionId: session.dbId, role: 'assistant', source, content: raw, emotion, tokensIn, tokensOut });
      if (toolRunIds.length) this.d.store.toolRuns.setMessage(toolRunIds, m.id);
    }
    this.d.memory.recordEmotion(emotion, 0.6);
    this.lastConversationAt = this.d.now();
    session.lastActivityAt = this.lastConversationAt;

    this.d.onLatency?.({
      turnId: turn.id,
      source,
      speechEnd: input.kind === 'user' ? input.speechEndAt : undefined,
      transcript: input.kind === 'user' && input.transcriptAt && input.speechEndAt ? input.transcriptAt - input.speechEndAt : undefined,
      firstToken: firstToken ? firstToken - turn.startedAt : undefined,
      firstSentence: firstSentence ? firstSentence - turn.startedAt : undefined,
    });

    // wait for playback to finish before going idle (speaking state is driven by the TTS events)
    if (!turn.abort.signal.aborted) {
      await Promise.race([this.d.tts.whenDrained(turn.id), new Promise((r) => setTimeout(r, 120_000))]);
    }
    this.d.memory.onTurnFinished(session.dbId);
    void this.maybeCompact(session);
    return replied;
  }

  private emitSentence(turn: ActiveTurn, text: string, emotion: Emotion, intensity: number): void {
    const sentenceId = ++this.sentenceSeq;
    const muted = this.d.settings().voice.muted;
    turn.spoken.push(`[${emotion}:${intensity}]${text}`);
    this.d.ui.sentence({ turnId: turn.id, sentenceId, text, emotion, intensity, silent: muted });
    if (!muted) {
      this.d.tts.enqueue({ turnId: turn.id, sentenceId, text, emotion, intensity });
    }
  }

  private speakFixed(turn: ActiveTurn, raw: string): void {
    const p = new ReplyParser();
    for (const ev of [...p.push(raw), ...p.end()]) {
      if (ev.type === 'sentence') this.emitSentence(turn, ev.text, ev.emotion, ev.intensity);
    }
  }

  /** speaking flag follows the TTS queue (set by the bridge). */
  setSpeaking(on: boolean): void {
    this.speaking = on;
    this.refreshState();
  }

  private closeDanglingToolUse(session: ConversationSession): void {
    const last = session.messages[session.messages.length - 1];
    if (!last || last.role !== 'assistant' || typeof last.content === 'string') return;
    const pending = last.content.filter((b) => b.type === 'tool_use');
    if (!pending.length) return;
    session.appendToolResults(
      pending.map((b) => ({ type: 'tool_result', tool_use_id: (b as { id: string }).id, is_error: true, content: 'ユーザーが中断しました' })) as Extract<Msg['content'], unknown[]>,
    );
    session.appendAssistant([{ type: 'text', text: '…' }]);
  }

  private async maybeCompact(session: ConversationSession): Promise<void> {
    if (!session.needsCompaction(LIMITS.historyTurns, LIMITS.historyTokens)) return;
    if (this.running) return; // never compact mid-turn
    try {
      const summary = await this.d.llm().text({
        model: this.d.utilityModel(),
        system: SUMMARY_SYSTEM,
        user: session.transcript(),
        maxTokens: 800,
        purpose: 'summary',
      });
      if (this.session === session && !this.running) {
        session.compact(summary);
        this.d.store.conv.setSessionSummary(session.dbId, summary);
        this.d.log.info('session compacted');
      }
    } catch (e) {
      this.d.log.warn('compaction failed', e);
    }
  }
}
