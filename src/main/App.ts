// Composition root: builds every service, wires events and IPC (skill mmd-architecture §7).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  app,
  clipboard,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  powerMonitor,
  safeStorage,
  screen,
  shell,
} from 'electron';
import { C2M, type C2MPayloads, type DeepPartial, M2A, M2C, type VoiceFitProgressEvent, type VoiceFitRequest, type VoiceFitResult } from '@shared/ipc';
import { DEFAULT_SETTINGS, GAZE_LIMIT_DEFAULT, GAZE_LIMIT_RANGE } from '@shared/defaults';
import type { CharacterPreset, ServiceStatus, Settings } from '@shared/types';
import type { TtsPort, UiPort } from './adapters';
import { FakeLlm } from './llm/FakeLlm';
import { LlmClient, type LlmAdapter } from './llm/LlmClient';
import { listOllamaModels, OllamaClient, RoutingLlm } from './llm/LocalLlm';
import { detectHardware, recommendLocal } from './llm/localProbe';
import { UsageService } from './llm/UsageService';
import { JournalService } from './journal/JournalService';
import { McpHub } from './mcp/McpHub';
import { stageOf, STAGES } from './memory/affinity';
import { MemoryService } from './memory/MemoryService';
import { Orchestrator } from './orchestrator/Orchestrator';
import { ActivityMonitor } from './proactive/ActivityMonitor';
import { FocusService } from './proactive/FocusService';
import { ProactiveEngine } from './proactive/ProactiveEngine';
import { TimerService } from './proactive/TimerService';
import { SidecarClient } from './sidecar/SidecarClient';
import { FallbackTts } from './speech/FallbackTts';
import { SpeechService } from './speech/SpeechService';
import { VoiceDictService } from './speech/VoiceDictService';
import { analyzeVoice, ANALYSIS_SR, decodeWav, resample } from './speech/voiceAnalysis';
import { autoTune, type FitStyle } from './speech/voiceFit';
import { VoicevoxClient } from './speech/VoicevoxClient';
import { findEngineExe, VoicevoxLauncher } from './speech/VoicevoxLauncher';
import { shapePitch } from './speech/pitchShape';
import { engineKind, engineKindFromUrl, ENGINE_PRESETS } from '@shared/voiceEngine';
import { applyAutoLaunch, launchedAtLogin } from './system/autoLaunch';
import { Db } from './store/Db';
import { Store, localHourKey, stripEmbedding } from './store/repos';
import { CharacterStore, deepMerge, Secrets, SettingsStore } from './store/SettingsStore';
import { ApprovalBroker } from './tools/ApprovalBroker';
import { CharacterSkillService, draftSkillFromTemplate } from './character/CharacterSkillService';
import { overlaysOf, skillName } from './character/skillPrompt';
import { MOTION_EMOTIONS, writeDefaultMotions } from './character/defaultMotions';
import { CalendarService, formatEvent, validateCalendarUrl } from './calendar/CalendarService';
import { createAssistantTools } from './tools/builtin/assistantTools';
import { createFileTools } from './tools/builtin/fileTools';
import { createSystemTools } from './tools/builtin/systemTools';
import { PathGuard } from './tools/pathGuard';
import { PermissionGate } from './tools/PermissionGate';
import { ToolRegistry } from './tools/ToolRegistry';
import { applyUndo, cleanupBackups } from './tools/undo';
import type { UndoInfo } from './tools/types';
import { getLogger, initLogger } from './util/logger';
import { UpdateService } from './update/UpdateService';
import { type AppPaths, appPaths, sidecarCommand } from './util/paths';
import { AdminWindow } from './windows/adminWindow';
import { CharacterWindow, rendererPaths } from './windows/characterWindow';
import { defaultMotionUrl, handleMmdProtocol, modelUrl, motionUrl } from './windows/protocol';
import { PushToTalk } from './windows/pushToTalk';
import { createTray } from './windows/tray';

const log = getLogger('app');
/** 自動調声で使うサンプルの長さの上限（秒）。長いと合成に時間がかかるだけで精度はほとんど上がらない */
const VOICE_FIT_MAX_SEC = 20;

export class App {
  readonly paths: AppPaths;
  readonly settings: SettingsStore;
  private secrets!: Secrets;
  private characters!: CharacterStore;
  private store!: Store;
  private character!: CharacterPreset;
  private guard!: PathGuard;
  private registry = new ToolRegistry();
  private gate!: PermissionGate;
  private broker!: ApprovalBroker;
  private llmReal!: LlmClient;
  private llmFake!: FakeLlm;
  private llmLocal!: OllamaClient;
  private llmRouter!: RoutingLlm;
  private usage!: UsageService;
  private vv!: VoicevoxClient;
  private speech!: SpeechService;
  private dict!: VoiceDictService;
  private sidecar!: SidecarClient;
  private vvLauncher!: VoicevoxLauncher;
  private fitAbort: AbortController | null = null;
  private memory!: MemoryService;
  private timers!: TimerService;
  private activity!: ActivityMonitor;
  private proactive!: ProactiveEngine;
  private calendar!: CalendarService;
  private mcp!: McpHub;
  private orc!: Orchestrator;
  private journal!: JournalService;
  private focus!: FocusService;
  private charWin!: CharacterWindow;
  private adminWin!: AdminWindow;
  private ptt = new PushToTalk(getLogger('ptt'));
  private tray: ReturnType<typeof createTray> | null = null;
  private updater: UpdateService | null = null;
  private status: ServiceStatus = { llm: 'no_key', voicevox: 'down', sidecar: 'starting', mcp: [] };
  private morphReport: C2MPayloads[typeof C2M.morphReport] | null = null;
  private skills!: CharacterSkillService;
  /** いま有効なキャラクターのモード（skill.md の overlays）。一時的な切り替えなので保存しない */
  private mode: string | null = null;
  private skillWatcher: fs.FSWatcher | null = null;
  private skillWatchTimer: ReturnType<typeof setTimeout> | null = null;
  /** 最後に記録・通知した skill.md の状態（変化の判定用。load() は更新日時で自動的に読み直すので、その前後では比べられない） */
  private lastSkillStatus = '';
  private micMode: 'off' | 'push' | 'barge' | 'wake' = 'off';
  private speechEndAt = 0;
  private quitting = false;
  private readonly fake = process.env.MMD_FAKE_LLM === '1';

  constructor() {
    this.paths = appPaths();
    fs.mkdirSync(this.paths.root, { recursive: true });
    this.settings = new SettingsStore(this.paths.settings);
  }

  get s(): Settings {
    return this.settings.get();
  }

  // =====================================================================
  async start(): Promise<void> {
    initLogger(this.paths.logs);
    log.info(`DesktopMMD ${app.getVersion()} starting (electron ${process.versions.electron})`);
    Menu.setApplicationMenu(null);

    // ---- store ----
    const db = new Db(this.paths.db);
    const applied = db.migrate();
    this.store = new Store(db);
    log.info(`store ready (schema v${db.version}, applied ${applied})`);
    this.secrets = new Secrets(this.paths.secrets, {
      isAvailable: () => safeStorage.isEncryptionAvailable(),
      encrypt: (t) => safeStorage.encryptString(t),
      decrypt: (b) => safeStorage.decryptString(b),
    });
    this.characters = new CharacterStore(this.paths.characters);
    this.characters.ensureDefault();
    this.character = this.loadCharacter(this.s.activeCharacter);
    this.skills = new CharacterSkillService((id) => this.characters.folder(id));
    this.logSkillStatus();
    fs.mkdirSync(this.paths.backups, { recursive: true });
    void cleanupBackups(this.paths.backups, new Date());

    // ---- protocol ----
    try {
      writeDefaultMotions(this.paths.defaultMotions);
    } catch (e) {
      log.warn(`default motions: ${(e as Error).message}`);
    }
    handleMmdProtocol(() => {
      const mp = this.characters.modelPath(this.character);
      return { model: mp ? path.dirname(mp) : null, motions: path.join(this.characters.folder(this.character.id), 'motions'), defaults: this.paths.defaultMotions };
    });

    // ---- tools & permissions ----
    this.guard = new PathGuard({ allowedDirs: this.s.tools.allowedDirs, denyDirs: [this.paths.root] });
    this.broker = new ApprovalBroker({
      show: (req) => this.charWin.send(M2C.approvalRequest, req),
      resolved: (id, decision) => this.charWin.send(M2C.approvalResolved, { id, decision }),
      onPendingChange: () => this.orc?.refreshState(),
    });
    this.gate = new PermissionGate({
      guard: this.guard,
      levelOverride: (t) => this.s.tools.levelOverrides[t],
      requestApproval: async (req, signal) => {
        this.charWin.setForcedVisible(true);
        try {
          return await this.broker.request(req, signal);
        } finally {
          if (this.broker.count === 0) this.charWin.setForcedVisible(false);
        }
      },
      recordRun: (r) => this.store.toolRuns.insert(r),
      finishRun: (id, result) => {
        this.store.toolRuns.finish(id, { ok: result.ok, content: typeof result.content === 'string' ? result.content : '[画像]' }, result.undo ?? null);
        this.adminWin?.send(M2A.toolRun, id);
      },
      now: () => new Date(),
      backupDir: this.paths.backups,
    });

    // ---- LLM ----
    this.usage = new UsageService(this.store, () => this.s, (text, kind) => this.toast(text, kind));
    this.llmReal = new LlmClient(() => this.secrets.getApiKey(), (model, u, purpose) => this.usage.record(model, u, purpose));
    this.llmFake = new FakeLlm(() => this.guard.allowedDirs[0] ?? app.getPath('documents'));
    this.llmLocal = new OllamaClient({ url: () => this.s.llm.localUrl });
    this.llmRouter = new RoutingLlm(this.llmReal, this.llmLocal, {
      provider: () => this.s.llm.provider,
      localModel: () => this.s.llm.localModel,
      hasKey: () => !!this.secrets.getApiKey(),
      proactiveLocal: () => this.s.llm.localForProactive,
    });
    this.status.llm = this.llmStatus();

    // ---- speech ----
    this.vv = new VoicevoxClient(this.character.voice.engineUrl);
    this.vvLauncher = new VoicevoxLauncher({
      ping: () => this.vv.version(1500).then(
        () => true,
        () => false,
      ),
      log: getLogger('voicevox'),
    });
    this.dict = new VoiceDictService(this.store, () => this.vv, getLogger('dict'));
    this.speech = new SpeechService({
      vv: this.vv,
      fallback: new FallbackTts(),
      character: () => this.character,
      settings: () => this.s,
      dict: () => this.dict.entries(),
      send: (p) => this.charWin.send(M2C.speechAudio, p),
      stop: () => this.charWin.send(M2C.speechStop, undefined),
      onSpeaking: (on) => this.onSpeaking(on),
      onEngineStatus: (st) => this.setStatus({ voicevox: st === 'ok' ? 'ok' : 'fallback' }),
      onFirstAudio: (turnId) => {
        const o = this.orc.latencyOrigin(turnId);
        if (!o) return;
        const ms = Date.now() - o.origin;
        this.store.latency.add({ turnId, source: `audio:${o.source}`, firstAudio: ms });
        log.info(`latency turn ${turnId}: first audio ${ms}ms (${o.source})`);
      },
      log: getLogger('speech'),
    });

    // ---- sidecar ----
    const sc = sidecarCommand();
    this.sidecar = new SidecarClient({
      command: sc.command,
      args: sc.args,
      modelsDir: this.paths.models,
      sttModel: () => this.s.voice.sttModel,
      device: () => this.s.voice.sttDevice,
      vocab: () => [this.displayName(), ...this.dict.vocab()],
      sttEnabled: () => this.s.voice.input !== 'off',
      log: getLogger('sidecar'),
    });
    this.wireSidecar();

    // ---- memory ----
    this.memory = new MemoryService({
      store: this.store,
      embedder: this.sidecar,
      llm: () => this.llm(),
      utilityModel: () => this.s.llm.utilityModel,
      now: () => new Date(),
      log: getLogger('memory'),
      enabled: () => this.s.privacy.saveTranscripts,
      onChanged: () => this.adminWin?.send(M2A.memoryChanged, null),
      onMood: (m) => this.charWin?.send(M2C.mood, m),
    });

    // ---- timers, activity, proactive ----
    this.timers = new TimerService(this.store, (label, kind) => {
      void this.proactive.fireReminder(`${kind === 'timer' ? 'タイマー' : 'リマインダー'}「${label}」`).then((ok) => {
        if (!ok) this.toast(`⏰ ${label}`, 'info');
      });
    });
    this.focus = new FocusService({
      onEnd: (m) => {
        void this.proactive.fireFocusEnd(m).then((ok) => {
          if (!ok) this.toast(`集中モード（${m}分）が終わりました。お疲れさまでした`, 'info');
        });
      },
      onChange: () => this.tray?.refresh(),
    });
    this.registerTools();
    this.activity = new ActivityMonitor({
      idleSeconds: () => powerMonitor.getSystemIdleTime(),
      activeWindow: async () => {
        const gw = await import('get-windows');
        const w = await gw.activeWindow();
        if (!w || w.owner.processId === process.pid) return null;
        // get-windows reports physical pixels; Electron's display bounds are DIPs (matters at 125%/150% scaling)
        const bounds = w.bounds ? screen.screenToDipRect(null, w.bounds) : null;
        return { app: w.owner.name ?? null, path: w.owner.path ?? null, bounds };
      },
      displayBoundsFor: (r) => screen.getDisplayMatching(r).bounds,
      ownPid: process.pid,
      watchApps: () => this.s.privacy.watchActiveWindow,
      now: () => new Date(),
      log: getLogger('activity'),
    });
    this.activity.on('fullscreen', (fs: boolean) => {
      if (process.env.MMD_SHOT === '1' || process.env.MMD_NO_AUTOHIDE === '1') return; // dev: never auto-hide
      log.info(`full-screen app ${fs ? 'detected' : 'gone'}`);
      if (!this.s.window.hideOnFullscreen) return; // user chose to always stay visible
      this.charWin.setFullscreenHidden(fs);
      if (fs) this.orc.cancel('fullscreen');
    });
    // spec 4.3 放置反応: drowsy after 10 min without input, asleep at 30 min; any input wakes her up
    setInterval(() => {
      const idleMin = powerMonitor.getSystemIdleTime() / 60;
      const sleepy = idleMin < 10 ? 0 : idleMin >= 30 ? 1 : 0.3 + ((idleMin - 10) / 20) * 0.6;
      this.charWin?.send(M2C.sleepy, sleepy);
    }, 15_000).unref();
    this.activity.on('activeMinute', (now: Date, appName: string | null) => {
      // sampled every 10s; count a minute every 6th sample
      if (now.getSeconds() < 10) this.store.patterns.addMinute(localHourKey(now), appName);
    });

    // ---- orchestrator ----
    const ui: UiPort = {
      state: (st) => {
        this.charWin.send(M2C.state, st);
        this.updateMicMode();
        this.updateEscHotkey(st);
      },
      sentence: (p) => this.charWin.send(M2C.sentence, p),
      detail: (turnId, markdown) => this.charWin.send(M2C.detail, { turnId, markdown }),
      userEcho: (text, source) => this.charWin.send(M2C.userEcho, { text, source }),
      toast: (text, kind = 'info') => this.toast(text, kind),
      openInput: () => this.charWin.send(M2C.openInput, undefined),
    };
    const tts: TtsPort = this.speech;
    this.orc = new Orchestrator({
      llm: () => this.llm(),
      chatModel: () => this.usage.chatModel(),
      proactiveModel: () => this.usage.proactiveModel(),
      cacheTtl: () => this.s.llm.cacheTtl,
      utilityModel: () => this.s.llm.utilityModel,
      effort: () => this.s.llm.effort,
      store: this.store,
      settings: () => this.s,
      character: () => this.character,
      skill: () => this.skills.load(this.character.id).skill,
      mode: () => this.mode,
      tools: this.registry,
      gate: this.gate,
      broker: this.broker,
      tts,
      ui,
      memory: this.memory,
      activeApp: () => this.activity.activeApp,
      // web_search is a Claude server tool: the local model can't run it
      webSearchEnabled: () => !this.fake && this.s.llm.provider === 'claude',
      chatOnly: () => this.s.llm.provider === 'local' && !this.s.llm.localTools,
      approvalHint: () => this.s.llm.provider !== 'local',
      now: () => new Date(),
      log: getLogger('orchestrator'),
      onLatency: (r) => {
        this.store.latency.add(r);
        log.info(`latency turn ${r.turnId}: firstToken=${r.firstToken ?? '-'}ms firstSentence=${r.firstSentence ?? '-'}ms transcript=${r.transcript ?? '-'}ms`);
      },
      onTurnDone: ({ proactive }) => {
        if (!proactive) this.proactive.onUserTurn();
      },
    });
    this.journal = new JournalService({
      store: this.store,
      llm: () => this.llm(),
      model: () => this.s.llm.utilityModel,
      settings: () => this.s,
      guard: this.guard,
      toolTitle: (name) => this.registry.get(name)?.title ?? name,
      now: () => new Date(),
      fs: {
        mkdir: (dir) => void fs.mkdirSync(dir, { recursive: true }),
        exists: (file) => fs.existsSync(file),
        read: (file) => fs.readFileSync(file, 'utf8'),
        write: (file, data) => fs.writeFileSync(file, data, 'utf8'),
      },
      toast: (text, kind) => this.toast(text, kind),
      log: getLogger('journal'),
    });
    this.calendar = new CalendarService({
      getUrl: () => this.secrets.getCalendarUrl(),
      enabled: () => this.s.calendar.enabled,
      now: () => new Date(),
      log: getLogger('calendar'),
    });
    this.proactive = new ProactiveEngine({
      store: this.store,
      activity: this.activity,
      settings: () => this.s,
      lastConversationAt: () => this.orc.lastConversation,
      focusing: () => this.focus.active,
      submit: (t) => this.orc.submit(t),
      isIdle: () => this.orc.state === 'idle',
      now: () => new Date(),
      log: getLogger('proactive'),
      calendarSoon: (now, withinMin) =>
        this.calendar.startingSoon(now, withinMin).map((e) => ({
          key: `${e.uid}|${e.start.getTime()}`,
          text: formatEvent(e),
          minutes: Math.round((e.start.getTime() - now.getTime()) / 60_000),
        })),
    });

    // ---- windows ----
    const out = path.join(__dirname, '..');
    const rp = rendererPaths(out);
    const devUrl = process.env.ELECTRON_RENDERER_URL ?? null;
    this.charWin = new CharacterWindow({
      settings: () => this.s,
      saveWindow: (patch) => this.settings.set({ window: patch }),
      preload: path.join(__dirname, '../preload/index.js'),
      rendererUrl: devUrl,
      rendererFile: rp.character,
    });
    this.adminWin = new AdminWindow({ preload: path.join(__dirname, '../preload/index.js'), rendererUrl: devUrl, rendererFile: rp.admin });
    this.registerCharacterIpc();
    this.registerAdminIpc();
    this.charWin.create();
    this.watchSkill();

    this.tray = createTray({
      version: () => app.getVersion(),
      isVisible: () => this.charWin.visible,
      isMuted: () => this.s.voice.muted,
      isMicOn: () => this.s.voice.micEnabled,
      isSleeping: () => this.s.sleeping,
      modes: () => {
        const sk = this.skills.load(this.character.id).skill;
        return { list: sk ? overlaysOf(sk) : [], current: this.mode };
      },
      setMode: (m) => this.setMode(m),
      focusUntil: () => {
        const f = this.focus.current;
        return f ? `${String(f.endsAt.getHours()).padStart(2, '0')}:${String(f.endsAt.getMinutes()).padStart(2, '0')}` : null;
      },
      startFocus: (m) => {
        const r = this.focus.start(m);
        if (r.ok) this.toast(`${m}分の集中モードを始めます。声かけはお休みします`, 'info');
      },
      stopFocus: () => void this.focus.stop(),
      toggleVisible: () => this.charWin.toggleVisible(),
      toggleMute: () => this.settings.set({ voice: { muted: !this.s.voice.muted } }),
      toggleMic: () => this.settings.set({ voice: { micEnabled: !this.s.voice.micEnabled } }),
      toggleSleep: () => this.settings.set({ sleeping: !this.s.sleeping }),
      openAdmin: (p) => this.adminWin.open(p),
      openGuide: () => this.openGuide(),
      quit: () => this.quit(),
    });
    this.registerHotkeys();
    this.settings.on('change', (next: Settings, prev: Settings) => this.onSettingsChanged(next, prev));

    // ---- background starts ----
    this.timers.start();
    setInterval(() => void this.journal.tick(), 60_000).unref();
    setTimeout(() => void this.journal.tick(), 30_000).unref(); // yesterday's diary, if the PC was off at the usual time
    this.activity.start();
    this.proactive.start();
    this.calendar.start();
    this.sidecar.start();
    void this.startVoicevox();
    this.warmUpLocal();
    void this.mcp.sync(this.s.mcp.servers).then(() => this.setStatus({ mcp: this.mcp.status() }));
    setInterval(() => this.memory.maintain(), 6 * 3600_000).unref();
    this.memory.maintain();
    applyAutoLaunch(this.s.autoLaunch, log);
    if (launchedAtLogin()) log.info('launched at login');
    this.startUpdateCheck();

    if (!this.s.setupCompleted || (!this.fake && this.s.llm.provider === 'claude' && !this.secrets.getApiKey())) this.adminWin.open('setup');
    if (process.env.MMD_SHOT === '1') this.scheduleScreenshots();
    log.info('window shown');
  }

  // =====================================================================

  /** 設定でONなら読み上げエンジン（VOICEVOX / AivisSpeech）を起動してから、話者の読み込みと辞書の同期をする */
  private async startVoicevox(): Promise<void> {
    if (this.s.voice.autoStartEngine) {
      const r = await this.vvLauncher.ensureRunning(this.character.voice.engineUrl, this.s.voice.enginePath);
      log.info(`voicevox launch: ${r}`);
    }
    const ok = await this.speech.warmUp();
    this.setStatus({ voicevox: ok ? 'ok' : 'fallback' });
    if (ok) await this.dict.sync();
    log.info(`voicevox ${ok ? 'ok' : 'unavailable → Windows voice'}`);
  }

  private llm(): LlmAdapter {
    return this.fake ? this.llmFake : this.llmRouter;
  }

  private llmStatus(): ServiceStatus['llm'] {
    if (this.fake) return 'fake';
    if (this.s.llm.provider === 'local') return 'ok';
    return this.secrets.getApiKey() ? 'ok' : 'no_key';
  }

  /** Load the local model into memory now (a cold load takes ~1 min), so the first message isn't slow. */
  private warmUpLocal(): void {
    if (this.fake || (this.s.llm.provider !== 'local' && !this.s.llm.localForProactive)) return;
    void this.llmLocal.warmUp(this.s.llm.localModel).then((ok) => log.info(`local llm warm-up ${this.s.llm.localModel}: ${ok ? 'ok' : 'failed'}`));
  }

  private loadCharacter(id: string): CharacterPreset {
    try {
      return this.characters.load(id);
    } catch (e) {
      log.warn(`character ${id} not found, using default`, e);
      return this.characters.load('default');
    }
  }

  /** The user guide installed next to the exe (README.html), or the repo's copy in development. */
  private openGuide(): void {
    const candidates = app.isPackaged
      ? [path.join(path.dirname(process.execPath), 'README.html'), path.join(path.dirname(process.execPath), 'README.md')]
      : [path.join(app.getAppPath(), 'build', 'README.html'), path.join(app.getAppPath(), 'README.md')];
    const file = candidates.find((f) => fs.existsSync(f));
    if (file) void shell.openPath(file);
    else this.toast('使い方のファイルが見つかりません', 'warn');
  }

  // ---------------- character skill (skill.md) ----------------

  /** 会話で名乗る名前: skill.md の name が使えればそれ、無ければ character.json の name */
  private displayName(): string {
    const sk = this.skills?.load(this.character.id).skill;
    return (sk && skillName(sk)) || this.character.name;
  }

  private logSkillStatus(): void {
    const st = this.skills.load(this.character.id).status;
    this.lastSkillStatus = JSON.stringify(st);
    const errs = st.issues.filter((i) => i.level === 'error').length;
    if (st.state === 'ok') log.info(`skill.md loaded: ${st.name} v${st.version} (${st.chars} chars, ${st.issues.length} warnings)`);
    else if (st.state === 'invalid') log.warn(`skill.md has ${errs} errors -> using character.json persona`);
    else log.info('no skill.md -> using character.json persona');
  }

  /** skill.md の保存を監視し、変わったら次の発話から新しい内容で会話を始め直す */
  private watchSkill(): void {
    this.skillWatcher?.close();
    this.skillWatcher = null;
    const id = this.character.id;
    const folder = this.characters.folder(id);
    try {
      this.skillWatcher = fs.watch(folder, (_ev, file) => {
        if (file && String(file).toLowerCase() !== 'skill.md') return;
        if (this.skillWatchTimer) clearTimeout(this.skillWatchTimer);
        this.skillWatchTimer = setTimeout(() => this.onSkillChanged(id), 500);
      });
    } catch (e) {
      log.warn('cannot watch the character folder', e);
    }
  }

  private onSkillChanged(id: string): void {
    if (id !== this.character.id) return;
    this.skills.invalidate(id);
    const after = this.skills.load(id);
    if (JSON.stringify(after.status) === this.lastSkillStatus) return;
    this.logSkillStatus();
    this.orc.endSession(); // 新しい skill.md は次の発話から（会話の途中で system を書き換えない）
    if (this.mode && !after.status.overlays.includes(this.mode)) this.mode = null;
    this.adminWin.send(M2A.settingsChanged, null);
    this.tray?.refresh();
    const st = after.status;
    const errs = st.issues.filter((i) => i.level === 'error').length;
    if (st.state === 'ok') this.toast(`skill.md を読み込みました（${st.name}）。次の発話から反映されます`, 'info');
    else if (st.state === 'invalid') this.toast(`skill.md にエラーが ${errs} 件あるため、使っていません（管理画面の設定で確認できます）`, 'warn');
    else this.toast('skill.md が無くなったので、設定画面の「性格と口調」を使います', 'info');
  }

  private setMode(m: string | null): { ok: boolean; current: string | null; error?: string } {
    const sk = this.skills.load(this.character.id).skill;
    if (m !== null && (!sk || !overlaysOf(sk).includes(m))) return { ok: false, current: this.mode, error: `モード「${m}」はありません` };
    this.mode = m;
    this.tray?.refresh();
    this.toast(m ? `モード「${m}」にしました` : 'モードを解除しました', 'info');
    return { ok: true, current: this.mode };
  }

  /** テンプレート（移行用の下書き）またはサンプルから skill.md を作る。既にあれば作らない */
  private createSkill(kind: 'draft' | 'sample'): { ok: boolean; path: string; error?: string } {
    const file = this.skills.pathOf(this.character.id);
    if (fs.existsSync(file)) return { ok: false, path: file, error: 'skill.md は既にあります' };
    const base = app.isPackaged ? path.join(process.resourcesPath, 'characters') : path.join(app.getAppPath(), 'characters');
    try {
      let text: string;
      if (kind === 'sample') {
        text = fs.readFileSync(path.join(base, 'sample', 'skill.md'), 'utf8').replace(/^id:.*$/m, `id: ${this.character.id}`);
      } else {
        const c = this.character;
        text = draftSkillFromTemplate(fs.readFileSync(path.join(base, '_template', 'skill.md'), 'utf8'), {
          id: c.id, name: c.name, firstPerson: c.firstPerson, persona: c.persona, speechExamples: c.speechExamples,
        });
      }
      fs.writeFileSync(file, text, 'utf8');
      void shell.openPath(file);
      return { ok: true, path: file };
    } catch (e) {
      return { ok: false, path: file, error: (e as Error).message };
    }
  }

  private toast(text: string, kind: 'info' | 'warn' | 'error' = 'info'): void {
    this.charWin?.send(M2C.toast, { text, kind });
  }

  private setStatus(patch: Partial<ServiceStatus>): void {
    this.status = { ...this.status, ...patch };
    this.charWin?.send(M2C.status, this.status);
    this.adminWin?.send(M2A.status, this.status);
  }

  private registerTools(): void {
    for (const t of createFileTools({ trashItem: (p) => shell.trashItem(p) })) this.registry.register(t);
    for (const t of createSystemTools({
      settings: () => this.s,
      openExternal: (u) => shell.openExternal(u),
      openPath: (p) => shell.openPath(p),
      readClipboard: () => clipboard.readText(),
      writeClipboard: (t) => clipboard.writeText(t),
      screenshot: () => this.screenshot(),
      defaultCwd: () => this.guard.allowedDirs[0] ?? app.getPath('documents'),
    })) this.registry.register(t);
    for (const t of createAssistantTools(this.timers, this.memory, {
      agenda: (hours) => this.calendar.agenda(new Date(), hours).map(formatEvent),
      enabled: () => this.s.calendar.enabled && !!this.secrets.getCalendarUrl(),
    }, this.focus)) this.registry.register(t);
    this.mcp = new McpHub(this.registry, getLogger('mcp'));
  }

  private async screenshot(): Promise<Buffer | null> {
    const disp = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const scale = Math.min(1, 1568 / Math.max(disp.size.width, disp.size.height));
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(disp.size.width * scale), height: Math.round(disp.size.height * scale) },
    });
    const src = sources.find((s) => s.display_id === String(disp.id)) ?? sources[0];
    return src ? src.thumbnail.toPNG() : null;
  }

  // ---------------- voice input ----------------

  private wireSidecar(): void {
    this.sidecar.on('status', (st: ServiceStatus['sidecar'], detail?: string) => {
      this.setStatus({ sidecar: st, sidecarDevice: detail });
    });
    this.sidecar.on('embedReady', () => {
      void this.memory.backfillEmbeddings().then((n) => n && log.info(`backfilled ${n} embeddings`));
    });
    this.sidecar.on('speechStart', () => {
      this.charWin.send(M2C.listening, { speech: true });
      if (this.micMode === 'barge') {
        log.info('barge-in');
        this.orc.bargeIn();
        this.sidecar.setSpeakingBoost(false);
        this.micMode = 'push'; // keep capturing until the utterance ends
        this.orc.setListening(true);
      }
    });
    this.sidecar.on('speechEnd', (discarded: boolean) => {
      this.speechEndAt = Date.now();
      this.charWin.send(M2C.listening, { speech: false });
      if (discarded && this.micMode !== 'wake') this.endListening();
    });
    this.sidecar.on('transcript', (t: { text: string }) => this.onTranscript(t.text));
  }

  private onTranscript(raw: string): void {
    const transcriptAt = Date.now();
    let text = raw.trim();
    if (this.micMode !== 'wake') this.endListening();
    if (!text) return;
    if (this.micMode === 'wake') {
      // FR-IN-04 (simplified): accept only utterances that start by calling the assistant's name
      const names = [this.s.voice.wakeWord, this.displayName()].filter(Boolean);
      const hit = names.find((n) => text.startsWith(n));
      if (!hit) return;
      text = text.slice(hit.length).replace(/^[、。,\s!！?？]+/, '') || 'なに？';
    }
    if (this.broker.count > 0) {
      const r = this.broker.voice(text);
      if (r === 'needs_click') this.toast('この作業は画面のボタンで許可してね', 'warn');
      else if (r === 'not_an_answer') this.toast('カードのボタンか「いいよ」「だめ」で答えてね', 'info');
      return;
    }
    this.charWin.send(M2C.userEcho, { text, source: 'voice' });
    this.orc.submit({ kind: 'user', source: 'voice', text, speechEndAt: this.speechEndAt || transcriptAt, transcriptAt });
  }

  private pttDown(): void {
    if (this.s.voice.input === 'off' || !this.s.voice.micEnabled) {
      this.openInputFocused();
      return;
    }
    if (!this.sidecar.ready) {
      this.toast('音声認識の準備ができていません（文字で話しかけてね）', 'warn');
      this.openInputFocused();
      return;
    }
    if (this.orc.state === 'speaking' || this.orc.busy) this.orc.bargeIn();
    this.micMode = 'push';
    this.orc.setListening(true);
    this.sidecar.listenStart('push');
    this.charWin.send(M2C.micCapture, true);
  }

  private pttUp(heldMs: number): void {
    if (this.micMode !== 'push') return;
    if (heldMs < 300) {
      this.sidecar.listenStop();
      this.endListening();
      this.openInputFocused();
      return;
    }
    this.charWin.send(M2C.micCapture, false);
    this.sidecar.listenStop(); // flush → transcript (or speech_end discarded)
  }

  /** The input bar needs keyboard focus, which an inactive always-on-top window doesn't have. */
  private openInputFocused(): void {
    this.charWin.focusForInput();
    this.charWin.send(M2C.openInput, undefined);
  }

  private endListening(): void {
    if (this.micMode === 'push' || this.micMode === 'barge') this.micMode = 'off';
    this.charWin.send(M2C.micCapture, false);
    this.orc.setListening(false);
    this.updateMicMode();
  }

  private onSpeaking(on: boolean): void {
    this.orc.setSpeaking(on);
    this.updateMicMode();
  }

  /** Decide whether the mic should be open without a key press: barge-in while speaking, or wake mode. */
  private updateMicMode(): void {
    if (!this.sidecar?.ready || !this.s.voice.micEnabled || this.s.voice.input === 'off' || this.s.sleeping) {
      if (this.micMode === 'barge' || this.micMode === 'wake') {
        this.micMode = 'off';
        this.sidecar?.listenStop();
        this.charWin.send(M2C.micCapture, false);
      }
      return;
    }
    if (this.micMode === 'push') return;
    const st = this.orc?.state;
    let want: 'off' | 'barge' | 'wake' = 'off';
    if (st === 'speaking') want = 'barge';
    else if (this.s.voice.input === 'wake' && (st === 'idle' || st === 'listening')) want = 'wake';
    if (want === this.micMode) return;
    this.micMode = want;
    if (want === 'off') {
      this.sidecar.listenStop();
      this.charWin.send(M2C.micCapture, false);
      return;
    }
    this.sidecar.setSpeakingBoost(want === 'barge');
    this.sidecar.listenStart('vad');
    this.charWin.send(M2C.micCapture, true);
  }

  // ---------------- hotkeys ----------------

  private escRegistered = false;

  /** Esc stops speech/generation (spec 3.3). It is global only while busy so other apps keep their Esc. */
  private updateEscHotkey(st: string): void {
    const busy = st === 'thinking' || st === 'speaking' || st === 'acting' || st === 'awaiting';
    if (busy && !this.escRegistered) {
      try {
        this.escRegistered = globalShortcut.register('Escape', () => {
          this.proactive.onDismiss();
          this.orc.cancel('esc');
        });
      } catch {
        this.escRegistered = false;
      }
    } else if (!busy && this.escRegistered) {
      globalShortcut.unregister('Escape');
      this.escRegistered = false;
    }
  }

  private registerHotkeys(): void {
    globalShortcut.unregisterAll();
    this.escRegistered = false;
    const hk = this.s.hotkeys;
    const failed: string[] = [];
    const reg = (acc: string, fn: () => void) => {
      try {
        if (!globalShortcut.register(acc, fn)) failed.push(acc);
      } catch {
        failed.push(acc);
      }
    };
    const pttOk = this.ptt.start(hk.pushToTalk, { down: () => this.pttDown(), up: (ms) => this.pttUp(ms) });
    if (pttOk) {
      this.ptt.update(hk.pushToTalk);
      // also claim the combo so other apps don't receive it (uiohook sees it first)
      reg(hk.pushToTalk, () => {});
    } else {
      // fallback: toggle (first press starts, second press or VAD end stops)
      reg(hk.pushToTalk, () => (this.micMode === 'push' ? this.pttUp(1000) : this.pttDown()));
    }
    reg(hk.mute, () => this.settings.set({ voice: { muted: !this.s.voice.muted } }));
    reg(hk.toggleVisible, () => {
      this.charWin.toggleVisible();
      this.tray?.refresh();
    });
    if (failed.length) this.toast(`ホットキーを登録できませんでした（他のアプリと衝突）: ${failed.join(', ')}`, 'warn');
    this.updateEscHotkey(this.orc.state);
  }

  // ---------------- settings ----------------

  private viewPayload() {
    return {
      muted: this.s.voice.muted,
      fps: this.s.render.fps,
      physics: this.s.render.physics,
      gazeLimit: this.s.render.gazeLimit,
      showBubble: this.s.render.showBubble,
      scale: this.s.window.scale,
      sleeping: this.s.sleeping,
      micEnabled: this.s.voice.micEnabled,
      voiceInput: this.s.voice.input,
      voiceFilter: this.s.voice.postFilter,
    };
  }

  private onSettingsChanged(next: Settings, prev: Settings): void {
    if (next.window.scale !== prev.window.scale) this.charWin.setScale(next.window.scale);
    if (next.window.hideOnFullscreen !== prev.window.hideOnFullscreen) {
      this.charWin.setFullscreenHidden(next.window.hideOnFullscreen && this.activity.fullscreen);
    }
    // window position/scale and admin-screen display changes alone don't need the heavier work below
    if (JSON.stringify({ ...next, window: null, ui: null }) === JSON.stringify({ ...prev, window: null, ui: null })) return;
    this.guard.setAllowedDirs(next.tools.allowedDirs, [this.paths.root]);
    this.charWin.send(M2C.view, this.viewPayload());
    this.adminWin.send(M2A.settingsChanged, null);
    this.tray?.refresh();
    if (JSON.stringify(next.hotkeys) !== JSON.stringify(prev.hotkeys)) this.registerHotkeys();
    if (next.voice.sttModel !== prev.voice.sttModel || next.voice.sttDevice !== prev.voice.sttDevice || (next.voice.input === 'off') !== (prev.voice.input === 'off')) {
      this.sidecar.restart();
    }
    if (JSON.stringify(next.mcp) !== JSON.stringify(prev.mcp)) {
      void this.mcp.sync(next.mcp.servers).then(() => this.setStatus({ mcp: this.mcp.status() }));
      this.orc.endSession(); // tool list changes apply from the next session
    }
    if (next.llm.provider !== prev.llm.provider || next.llm.localModel !== prev.llm.localModel || next.llm.localUrl !== prev.llm.localUrl || next.llm.localTools !== prev.llm.localTools) {
      this.orc.endSession(); // tools / system prompt differ between the two modes: start fresh from the next utterance
      this.setStatus({ llm: this.llmStatus() });
      this.warmUpLocal();
    }
    if (next.llm.localForProactive && !prev.llm.localForProactive) this.warmUpLocal();
    if (next.voice.muted && !prev.voice.muted) this.speech.cancel();
    if (next.sleeping !== prev.sleeping) this.orc.refreshState();
    if (next.autoLaunch !== prev.autoLaunch) applyAutoLaunch(next.autoLaunch, log);
    if (
      JSON.stringify(next.tools) !== JSON.stringify(prev.tools) ||
      next.user.callName !== prev.user.callName ||
      next.activeCharacter !== prev.activeCharacter
    ) {
      this.orc.endSession();
    }
    if (next.activeCharacter !== prev.activeCharacter) {
      this.character = this.loadCharacter(next.activeCharacter);
      this.mode = null;
      this.watchSkill();
      this.logSkillStatus();
      this.sendCharacter();
      void this.speech.warmUp();
    }
    if (next.render.defaultMotions !== prev.render.defaultMotions) this.sendCharacter();
    this.updateMicMode();
  }

  private sendCharacter(): void {
    const c = this.character;
    const mp = this.characters.modelPath(c);
    const modelOk = !!mp && fs.existsSync(mp);
    const motions = { emotions: {} as Record<string, string>, idle: [] as string[] };
    for (const [emo, file] of Object.entries(c.motions.emotions)) if (file) motions.emotions[emo] = motionUrl(file);
    // 個別の指定がない感情には、標準のモーションを使う（設定でOFFにできる）
    if (this.s.render.defaultMotions) for (const emo of MOTION_EMOTIONS) if (!motions.emotions[emo]) motions.emotions[emo] = defaultMotionUrl(emo);
    motions.idle = c.motions.idle.map(motionUrl);
    this.charWin.send(M2C.loadCharacter, {
      preset: c,
      modelUrl: modelOk ? modelUrl(mp!) : null,
      motionUrls: motions,
      affinityStage: stageOf(this.store.relationship.get().affinity),
    });
  }

  // ---------------- IPC: character window ----------------

  private registerCharacterIpc(): void {
    const on = <K extends keyof C2MPayloads>(ch: K, fn: (p: C2MPayloads[K]) => void) =>
      ipcMain.on(ch, (e, p) => {
        if (e.sender !== this.charWin.win?.webContents) return;
        fn(p as C2MPayloads[K]);
      });
    on(C2M.ready, () => {
      this.sendCharacter();
      this.charWin.send(M2C.view, this.viewPayload());
      this.charWin.send(M2C.status, this.status);
      this.charWin.send(M2C.state, this.orc.state);
      this.charWin.send(M2C.mood, this.store.relationship.get().mood);
    });
    on(C2M.inputText, (text) => {
      const t = String(text ?? '').slice(0, 8000);
      if (!t.trim()) return;
      if (this.broker.count > 0) {
        const r = this.broker.voice(t);
        if (r === 'approved' || r === 'denied') return;
      }
      this.orc.submit({ kind: 'user', source: 'text', text: t });
    });
    on(C2M.inputDrop, (paths) => {
      const files = (Array.isArray(paths) ? paths : []).filter((p) => typeof p === 'string').slice(0, 20);
      if (!files.length) return;
      this.guard.allowReadFiles(files);
      this.charWin.send(M2C.userEcho, { text: files.map((f) => path.basename(f)).join('、'), source: 'drop' });
      this.charWin.send(M2C.openInput, undefined);
      this.orc.submit({ kind: 'user', source: 'drop', text: '', files });
    });
    on(C2M.micFrame, (frame) => {
      if (this.micMode !== 'off' && frame instanceof ArrayBuffer) this.sidecar.pushAudio(frame);
      else if (this.micMode !== 'off' && ArrayBuffer.isView(frame)) this.sidecar.pushAudio((frame as unknown as Uint8Array).slice().buffer);
    });
    on(C2M.cancel, () => {
      this.proactive.onDismiss();
      this.orc.cancel('esc');
      if (this.micMode === 'push') {
        this.sidecar.listenStop();
        this.endListening();
      }
    });
    on(C2M.approvalAnswer, ({ id, answer }) => this.broker.answer(id, answer));
    on(C2M.touch, (part) => {
      if (this.orc.state !== 'idle') return;
      // FR-EX-05 (Could): a light reaction without calling the LLM; the renderer animates it
      log.debug(`touched ${part}`);
    });
    on(C2M.ignoreMouse, (ignore) => this.charWin.onIgnoreMouse(!!ignore));
    on(C2M.drag, (d) => this.charWin.onDrag(d));
    on(C2M.dragEnd, () => this.charWin.onDragEnd());
    on(C2M.scale, (f) => this.charWin.onScale(Number(f) || 1));
    on(C2M.speechPlayed, ({ sentenceId, phase }) => this.speech.played(sentenceId, phase));
    on(C2M.morphReport, (r) => {
      this.morphReport = r;
      if (r.error) log.warn(`model load error: ${r.error}`);
      log.info(`model ${r.modelLoaded ? 'loaded' : 'not loaded'}; missing morphs: ${r.missing.join(', ') || 'none'}`);
    });
    on(C2M.openAdmin, (page) => this.adminWin.open(page ?? 'settings'));
    on(C2M.contextMenu, () => this.showContextMenu());
    on(C2M.inputPanel, () => {});
    on(C2M.userActive, () => {});
  }

  private showContextMenu(): void {
    Menu.buildFromTemplate([
      { label: '話しかける（入力欄）', click: () => { this.charWin.focusForInput(); this.charWin.send(M2C.openInput, undefined); } },
      { label: '位置をリセット', click: () => this.charWin.resetPosition() },
      {
        label: 'サイズ',
        submenu: [0.5, 0.75, 1, 1.25, 1.5, 2].map((v) => ({
          label: `${Math.round(v * 100)}%`,
          type: 'radio' as const,
          checked: Math.abs(this.s.window.scale - v) < 0.01,
          click: () => this.charWin.onScale(v / this.s.window.scale),
        })),
      },
      { label: 'ミュート', type: 'checkbox', checked: this.s.voice.muted, click: () => this.settings.set({ voice: { muted: !this.s.voice.muted } }) },
      { type: 'separator' },
      { label: '管理画面…', click: () => this.adminWin.open('settings') },
      { label: '隠す', click: () => { this.charWin.toggleVisible(); this.tray?.refresh(); } },
    ]).popup({ window: this.charWin.win ?? undefined });
  }

  // ---------------- IPC: admin window ----------------

  private registerAdminIpc(): void {
    const handle = (ch: string, fn: (...args: any[]) => unknown) =>
      ipcMain.handle(ch, async (e, ...args) => {
        if (e.sender !== this.adminWin.win?.webContents && e.sender !== this.charWin.win?.webContents) throw new Error('forbidden');
        return fn(...args);
      });

    handle('app:version', () => app.getVersion());
    handle('update:check', async () => {
      const result = this.updater ? await this.updater.checkAndUpdate(true) : 'disabled';
      return { result, current: app.getVersion(), latest: this.updater?.latestVersion ?? null };
    });
    handle('settings:get', () => this.s);
    handle('settings:set', (patch: DeepPartial<Settings>) => this.settings.set(sanitizeSettingsPatch(patch)));
    handle('secrets:status', () => this.secrets.status());
    handle('journal:run', () => this.journal.run(new Date(), true));
    handle('journal:open-folder', () => {
      const c = this.guard.check(this.s.journal.folder);
      if (!c.ok) return;
      fs.mkdirSync(c.real, { recursive: true });
      void shell.openPath(c.real);
    });
    handle('llm:local-probe', async (url?: string) => {
      const target = url && /^https?:\/\//i.test(url) ? url : this.s.llm.localUrl;
      const [r, hardware] = await Promise.all([listOllamaModels(target), detectHardware()]);
      const models = r.ok ? r.models : [];
      const want = this.s.llm.localModel;
      return {
        ok: r.ok,
        error: r.ok ? undefined : r.error,
        version: r.ok ? r.version : null,
        models,
        hasModel: models.some((m) => m === want || m === `${want}:latest`),
        hardware,
        recommendation: recommendLocal(hardware),
      };
    });
    handle('secrets:set-api-key', async (key: string) => {
      try {
        this.secrets.setApiKey(String(key));
        this.setStatus({ llm: this.llmStatus() });
        return { ok: true, masked: this.secrets.status().masked };
      } catch (e) {
        return { ok: false, masked: '', error: (e as Error).message };
      }
    });

    handle('calendar:status', () => ({
      ...this.secrets.calendarStatus(),
      lastSyncAt: this.calendar.lastSyncAt?.toISOString() ?? null,
      error: this.calendar.lastError,
      upcoming: this.calendar.agenda(new Date(), 24).slice(0, 5).map(formatEvent),
    }));
    handle('calendar:set-url', async (url: string) => {
      const raw = String(url ?? '').trim();
      if (raw) {
        const v = validateCalendarUrl(raw);
        if (!v.ok) return { ok: false, error: v.error };
      }
      try {
        this.secrets.setCalendarUrl(raw);
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
      if (!raw) return { ok: true, count: 0 };
      const r = await this.calendar.refresh();
      return r.ok ? { ok: true, count: r.count } : { ok: false, error: r.error };
    });
    handle('calendar:sync', async () => {
      const r = await this.calendar.refresh();
      return r.ok ? { ok: true, count: r.count } : { ok: false, error: r.error };
    });

    handle('character:get', () => this.character);
    handle('character:list', () => this.characters.list());
    handle('character:save', (p: CharacterPreset) => {
      try {
        const merged = deepMerge(this.character, p);
        merged.id = this.character.id;
        this.characters.save(merged);
        this.character = merged;
        this.sendCharacter();
        this.orc.endSession();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    });
    handle('character:activate', (id: string) => {
      this.settings.set({ activeCharacter: id });
      return { ok: true };
    });
    handle('character:create', (name: string) => ({ id: this.characters.create(String(name).slice(0, 40) || 'キャラクター').id }));
    handle('character:pick-model', async () => {
      const r = await dialog.showOpenDialog(this.adminWin.win!, { title: 'MMDモデル（PMX）を選択', filters: [{ name: 'MMD model', extensions: ['pmx', 'pmd'] }], properties: ['openFile'] });
      return r.canceled ? null : r.filePaths[0];
    });
    handle('character:pick-folder', async () => {
      const r = await dialog.showOpenDialog(this.adminWin.win!, { title: 'フォルダを選択', properties: ['openDirectory'] });
      return r.canceled ? null : r.filePaths[0];
    });
    handle('character:morph-report', () => this.morphReport);
    handle('character:skill-status', () => this.skills.load(this.character.id).status);
    handle('character:skill-create', (kind: 'draft' | 'sample') => this.createSkill(kind === 'sample' ? 'sample' : 'draft'));
    handle('character:open-folder', () => {
      void shell.openPath(this.characters.folder(this.character.id));
    });
    handle('character:mode-get', () => {
      const sk = this.skills.load(this.character.id).skill;
      return { list: sk ? overlaysOf(sk) : [], current: this.mode };
    });
    handle('character:mode-set', (m: string | null) => this.setMode(m));

    handle('memory:list', (f) => this.store.memories.list(f ?? {}).map(stripEmbedding));
    handle('memory:add', (m) => this.memory.adminAdd(m));
    handle('memory:update', (id: number, patch) => this.memory.adminUpdate(Number(id), patch ?? {}));
    handle('memory:delete', (id: number) => {
      this.store.memories.update(Number(id), { status: 'trashed' });
      return true;
    });
    handle('memory:delete-all', () => {
      this.store.wipePersonalData();
      this.orc.endSession();
      return true;
    });
    handle('memory:export', async () => {
      const r = await dialog.showSaveDialog(this.adminWin.win!, { title: '記憶を書き出し', defaultPath: `mmd-memories-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (r.canceled || !r.filePath) return null;
      const data = {
        exportedAt: new Date().toISOString(),
        relationship: this.store.relationship.get(),
        memories: this.store.memories.list({}).concat(this.store.memories.list({ status: 'superseded' })).map(stripEmbedding),
      };
      fs.writeFileSync(r.filePath, JSON.stringify(data, null, 2), 'utf8');
      return r.filePath;
    });
    handle('memory:source', (messageId: number) => {
      const m = this.store.conv.message(Number(messageId));
      if (!m) return null;
      return { session: this.store.conv.session(m.sessionId)!, messages: this.store.conv.messages(m.sessionId) };
    });
    handle('relationship:get', () => {
      const r = this.store.relationship.get();
      const stage = stageOf(r.affinity);
      return { ...r, stage, stageName: STAGES[stage].name };
    });

    handle('history:sessions', (limit: number, offset: number) => this.store.conv.sessions(Number(limit) || 50, Number(offset) || 0));
    handle('history:messages', (id: number) => this.store.conv.messages(Number(id)));
    handle('history:search', (q: string) => this.store.conv.search(String(q)));

    handle('tool-log:list', (limit: number) => this.store.toolRuns.list(Number(limit) || 100));
    handle('tool-log:undo', async (id: number) => {
      const run = this.store.toolRuns.get(Number(id));
      if (!run || !run.undoJson) return { ok: false, message: '取り消せない作業です' };
      if (run.undoneAt) return { ok: false, message: '既に取り消し済みです' };
      const r = await applyUndo(JSON.parse(run.undoJson) as UndoInfo, { guard: this.guard, trashItem: (p) => shell.trashItem(p) });
      if (r.ok) this.store.toolRuns.markUndone(run.id);
      return r;
    });

    handle('voice:speakers', async (engineUrl?: string) => {
      const client = new VoicevoxClient(engineUrl || this.character.voice.engineUrl);
      try {
        const [version, speakers, name] = await Promise.all([client.version(), client.speakers(), client.engineName()]);
        return { ok: true, speakers, version, kind: engineKind(name, client.baseUrl) };
      } catch (e) {
        return { ok: false, speakers: [], error: (e as Error).message };
      }
    });
    handle('voice:preview', async (req) => {
      try {
        const r = await this.speech.preview(String(req.text).slice(0, 500), req.voice, req.emotion, req.intensity ?? 1);
        if (!r) return { ok: false, error: '読み上げる文字がありません' };
        if (req.onModel) {
          this.charWin.send(M2C.sentence, { turnId: -1, sentenceId: -1, text: req.text, emotion: req.emotion, intensity: req.intensity ?? 1, silent: false });
          this.charWin.send(M2C.speechAudio, { turnId: -1, sentenceId: -1, wav: r.wav, query: r.query, emotion: req.emotion, intensity: req.intensity ?? 1, preview: true });
          return { ok: true, engine: r.engine };
        }
        return { ok: true, wav: r.wav, engine: r.engine };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    });
    handle('voice:stop', () => {
      this.speech.stopPreview();
      this.charWin.send(M2C.speechStop, undefined);
    });
    handle('voice:save', (voice) => {
      this.character = { ...this.character, voice };
      this.characters.save(this.character);
      this.vv.baseUrl = voice.engineUrl;
      void this.speech.warmUp();
      return { ok: true };
    });
    handle('voice:dict-list', () => this.dict.list());
    handle('voice:dict-add', (w) => this.dict.add(w));
    handle('voice:dict-update', (id: number, w) => this.dict.update(Number(id), w));
    handle('voice:dict-delete', (id: number) => this.dict.delete(Number(id)));
    handle('voice:accent-phrases', async (text: string, styleId: number) => {
      try {
        return { ok: true, accentPhrases: await this.vv.accentPhrases(String(text), Number(styleId)) };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    });
    handle('voice:mora-data', async (ap, styleId: number) => {
      try {
        return { ok: true, accentPhrases: await this.vv.moraData(ap, Number(styleId)) };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    });

    handle('voice:engine-info', () => ({
      path: findEngineExe(this.s.voice.enginePath, process.env, undefined, engineKindFromUrl(this.character.voice.engineUrl)),
      running: this.status.voicevox === 'ok',
      ownsEngine: this.vvLauncher.ownsEngine,
    }));
    handle('voice:engine-start', async (engineUrl?: string) => {
      const url = engineUrl || this.character.voice.engineUrl;
      const r = await this.vvLauncher.ensureRunning(url, this.s.voice.enginePath);
      if ((r === 'started' || r === 'already') && url === this.character.voice.engineUrl) {
        const ok = await this.speech.warmUp();
        this.setStatus({ voicevox: ok ? 'ok' : 'fallback' });
        if (ok) await this.dict.sync();
      }
      const name = ENGINE_PRESETS[engineKindFromUrl(url)].label;
      const message: Record<string, string> = {
        already: `${name}は起動しています`,
        started: `${name}を起動しました`,
        remote: 'エンジンのURLがこのPCではないため起動できません',
        not_found: `${name}が見つかりません。インストールするか、設定画面の「読み上げ」で場所を指定してください`,
        timeout: `${name}を起動しましたが応答がありません（初回は時間がかかることがあります）`,
        failed: `${name}を起動できませんでした（ポートが他のアプリに使われている可能性があります）`,
      };
      return { ok: r === 'started' || r === 'already', result: r, message: message[r] ?? r };
    });
    handle('voice:pick-engine', async () => {
      const r = await dialog.showOpenDialog(this.adminWin.win!, {
        title: '読み上げエンジン（VOICEVOX.exe / AivisSpeech.exe、またはエンジンの run.exe）を選択',
        filters: [{ name: 'VOICEVOX / AivisSpeech', extensions: ['exe'] }],
        properties: ['openFile'],
      });
      if (r.canceled || !r.filePaths[0]) return { canceled: true, path: null };
      const picked = r.filePaths[0];
      const found = findEngineExe(picked, process.env, undefined, /aivis/i.test(picked) ? 'aivis' : 'voicevox');
      return { canceled: false, path: found ? picked : null };
    });
    handle('voice:fit', (req) => this.runVoiceFit(req));
    handle('voice:fit-cancel', () => this.fitAbort?.abort());

    handle('status:get', () => this.status);
    handle('usage:get', () => this.usage.summary());
    handle('usage:breakdown', () => this.usage.breakdown());
    handle('setup:complete', () => {
      this.settings.set({ setupCompleted: true });
    });
    handle('app:open-external', (url: string) => {
      if (/^https?:\/\//.test(String(url))) void shell.openExternal(String(url));
    });
  }

  // ---------------- auto tuning from a sample voice ----------------

  private async runVoiceFit(req: VoiceFitRequest): Promise<VoiceFitResult> {
    this.fitAbort?.abort();
    const ac = new AbortController();
    this.fitAbort = ac;
    const progress = (p: VoiceFitProgressEvent) => this.adminWin.send(M2A.voiceFitProgress, p);
    try {
      const sr = Number(req.sr) || ANALYSIS_SR;
      const raw = req.pcm instanceof Float32Array ? req.pcm : Float32Array.from(req.pcm as ArrayLike<number>);
      const samples = raw.subarray(0, Math.min(raw.length, Math.round(sr * VOICE_FIT_MAX_SEC)));
      if (samples.length < sr * 2) return { ok: false, error: '音声が短すぎます（2秒以上の話し声を使ってください）' };
      const target = analyzeVoice(samples, sr);
      let text = String(req.text ?? '').trim();
      let transcribed = false;
      if (!text && this.sidecar.ready) {
        progress({ phase: 'transcribe', done: 0, total: 1, label: '書き起こし中' });
        try {
          text = (await this.sidecar.transcribeClip(resample(samples, sr, ANALYSIS_SR))).trim();
          transcribed = !!text;
        } catch (e) {
          log.warn('sample transcription failed', e);
        }
      }
      const engineUrl = req.engineUrl || this.character.voice.engineUrl;
      const vv = new VoicevoxClient(engineUrl);
      const kind = await this.speech.engineKindOf(engineUrl);
      const speakers = await vv.speakers();
      const talk = speakers.flatMap((sp) =>
        sp.styles.filter((st) => !st.type || st.type === 'talk').map((st) => ({ id: st.id, label: `${sp.name}（${st.name}）`, speaker: sp.speaker_uuid })),
      );
      const current = talk.find((x) => x.id === req.speakerId);
      const styles: FitStyle[] = req.scope === 'speaker' && current ? talk.filter((x) => x.speaker === current.speaker) : talk;
      if (!styles.length) return { ok: false, error: '話者が見つかりません' };
      const initialized = new Set<number>();
      const candidates = await autoTune({
        target,
        text,
        styles,
        topN: 3,
        signal: ac.signal,
        onProgress: progress,
        fixPitch: kind === 'aivis',
        synth: async (id, t, p) => {
          if (!initialized.has(id)) {
            await vv.initializeSpeaker(id);
            initialized.add(id);
          }
          const q = { ...(await vv.audioQuery(t, id, ac.signal)), ...p, volumeScale: 1, outputSamplingRate: ANALYSIS_SR, outputStereo: false };
          // 会話と同じ形で合成する（VOICEVOX は音高・抑揚をアプリ側でかけ、高すぎる音を抑える）
          const wav = kind === 'aivis' ? await vv.synthesis(q, id, ac.signal, 60_000) : await vv.synthesis(shapePitch(q, undefined, p.pitchScale), id, ac.signal, 60_000, false);
          return decodeWav(wav);
        },
      });
      log.info(`voice fit: ${styles.length} styles, text=${text.length}chars, best=${candidates[0]?.label ?? '-'} (${candidates[0]?.score ?? 0})`);
      return {
        ok: true,
        text,
        transcribed,
        sample: { f0Hz: target.f0Hz, logF0Std: target.logF0Std, activeSec: target.activeSec, totalSec: target.totalSec },
        candidates,
      };
    } catch (e) {
      if ((e as Error).name === 'AbortError' || ac.signal.aborted) return { ok: false, error: '中止しました' };
      log.warn('voice fit failed', e);
      return { ok: false, error: (e as Error).message };
    } finally {
      if (this.fitAbort === ac) this.fitAbort = null;
    }
  }

  // ---------------- dev screenshots ----------------

  private scheduleScreenshots(): void {
    setTimeout(async () => {
      const dir = path.join(app.getAppPath(), 'out', 'shots');
      fs.mkdirSync(dir, { recursive: true });
      const img = await this.charWin.capture();
      if (img) fs.writeFileSync(path.join(dir, 'character.png'), img.toPNG());
      this.orc.submit({ kind: 'user', source: 'text', text: 'こんにちは' });
      setTimeout(async () => {
        const img2 = await this.charWin.capture();
        if (img2) fs.writeFileSync(path.join(dir, 'character-talking.png'), img2.toPNG());
        // approval card: the fake LLM asks for write_file; capture the card, then deny (nothing is written)
        this.orc.submit({ kind: 'user', source: 'text', text: 'メモを保存して' });
        for (let i = 0; i < 40 && this.broker.count === 0; i++) await new Promise((r) => setTimeout(r, 250));
        await new Promise((r) => setTimeout(r, 800));
        const img3 = await this.charWin.capture();
        if (img3) fs.writeFileSync(path.join(dir, 'character-approval.png'), img3.toPNG());
        this.broker.denyAll();
        await new Promise((r) => setTimeout(r, 2500));
        const img4 = await this.charWin.capture();
        if (img4) fs.writeFileSync(path.join(dir, 'character-after-deny.png'), img4.toPNG());
        for (const page of ['settings', 'voice', 'memory', 'history', 'tools', 'setup'] as const) {
          this.adminWin.open(page);
          await new Promise((r) => setTimeout(r, 1500));
          const a = await this.adminWin.win?.webContents.capturePage();
          if (a) fs.writeFileSync(path.join(dir, `admin-${page}.png`), a.toPNG());
          if (page === 'settings') {
            await this.adminWin.win?.webContents.executeJavaScript("document.querySelector('.content').scrollTop = 480");
            await new Promise((r) => setTimeout(r, 300));
            const b = await this.adminWin.win?.webContents.capturePage();
            if (b) fs.writeFileSync(path.join(dir, 'admin-settings-2.png'), b.toPNG());
          }
        }
        log.info(`screenshots saved to ${dir}`);
        if (process.env.MMD_SHOT_QUIT === '1') this.quit();
      }, 4000);
    }, Number(process.env.MMD_SHOT_DELAY ?? 6000));
  }

  // ---------------- auto update ----------------

  /** 起動の数秒後に GitHub の最新リリースを確認する。開発起動・疑似LLM・設定OFFのときは何もしない。 */
  private startUpdateCheck(): void {
    const updater = (this.updater = new UpdateService({
      currentVersion: app.getVersion(),
      repo: 'usamaru33/DesktopMMD',
      enabled: () => app.isPackaged && !this.fake && this.s.autoUpdate,
      canUpdate: () => app.isPackaged && !this.fake,
      downloadDir: path.join(app.getPath('temp'), 'DesktopMMD-update'),
      fetch,
      runInstaller: (file) => this.runInstaller(file),
      notify: (text, kind) => this.toast(text, kind),
      log: getLogger('update'),
    }));
    setTimeout(() => void updater.checkAndUpdate(), 8000).unref();
  }

  /** 終了を待ってから静かにインストールし、終わったら（失敗しても）アプリを起動し直す。 */
  private runInstaller(file: string): void {
    const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
    const script = `Start-Sleep -Seconds 3; Start-Process -FilePath ${q(file)} -ArgumentList '/S' -Wait; Start-Process -FilePath ${q(process.execPath)}`;
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', script], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    setTimeout(() => this.quit(), 1500);
  }

  // ---------------- lifecycle ----------------

  showCharacter(): void {
    this.charWin?.show();
  }

  quit(): void {
    if (this.quitting) return;
    this.quitting = true;
    log.info('quitting');
    globalShortcut.unregisterAll();
    this.ptt.stop();
    this.timers?.stop();
    this.activity?.stop();
    this.proactive?.stop();
    this.calendar?.stop();
    this.memory?.dispose();
    this.speech?.dispose();
    this.sidecar?.stop();
    this.fitAbort?.abort();
    this.vvLauncher?.stop();
    void this.mcp?.close();
    app.quit();
  }
}

/** Renderer input is untrusted: only allow known keys and sane values. */
function sanitizeSettingsPatch(patch: DeepPartial<Settings>): DeepPartial<Settings> {
  const p = structuredClone(patch ?? {}) as DeepPartial<Settings>;
  if (p.journal) {
    if (p.journal.enabled !== undefined) p.journal.enabled = p.journal.enabled === true;
    if (p.journal.time !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(p.journal.time))) p.journal.time = DEFAULT_SETTINGS.journal.time;
    if (p.journal.folder !== undefined) p.journal.folder = String(p.journal.folder).trim() || DEFAULT_SETTINGS.journal.folder;
  }
  if (p.llm?.provider !== undefined && p.llm.provider !== 'claude' && p.llm.provider !== 'local') p.llm.provider = 'claude';
  if (p.llm?.localUrl !== undefined) {
    const u = String(p.llm.localUrl).trim();
    p.llm.localUrl = /^https?:\/\/[^\s/]+/i.test(u) ? u.replace(/\/+$/, '') : DEFAULT_SETTINGS.llm.localUrl;
  }
  if (p.llm?.localModel !== undefined) p.llm.localModel = String(p.llm.localModel).trim() || DEFAULT_SETTINGS.llm.localModel;
  if (p.llm?.monthlyBudgetUsd !== undefined) p.llm.monthlyBudgetUsd = Math.max(0, Number(p.llm.monthlyBudgetUsd) || 0);
  if (p.voice?.volume !== undefined) p.voice.volume = Math.min(2, Math.max(0, Number(p.voice.volume)));
  if (p.voice?.speed !== undefined) p.voice.speed = Math.min(2, Math.max(0.5, Number(p.voice.speed)));
  if (p.render?.gazeLimit !== undefined) {
    const g = Number(p.render.gazeLimit);
    p.render.gazeLimit = Number.isFinite(g) ? Math.min(GAZE_LIMIT_RANGE.max, Math.max(GAZE_LIMIT_RANGE.min, Math.round(g))) : GAZE_LIMIT_DEFAULT;
  }
  if (p.render?.fps !== undefined) p.render.fps = Math.min(60, Math.max(10, Math.round(Number(p.render.fps))));
  if (p.ui?.advanced !== undefined) p.ui.advanced = p.ui.advanced === true;
  if (p.tools?.allowedDirs) p.tools.allowedDirs = p.tools.allowedDirs.filter((d): d is string => typeof d === 'string' && d.trim().length > 0);
  return p;
}
