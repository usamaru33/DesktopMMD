// The single definition of every IPC channel (spec 5.9). main, preload and renderer import from here.
import type { Emotion } from './emotions';
import type { EngineKind } from './voiceEngine';
import type {
  FitCandidate,
  ApprovalAnswer,
  ApprovalRequest,
  CharacterPreset,
  CharacterState,
  CharacterVoice,
  MemoryKind,
  MemoryRecord,
  MemoryStatus,
  MessageRecord,
  Relationship,
  ServiceStatus,
  SessionRecord,
  SkillStatus,
  Settings,
  ToolRunRecord,
  UsageBreakdownRow,
  JournalRunResult,
  LocalLlmProbe,
  UsageSummary,
  VoiceDictWord,
  VoicevoxAccentPhrase,
  VoicevoxAudioQuery,
  VoicevoxSpeaker,
  WordType,
} from './types';

// ---------------- character window: renderer -> main (send) ----------------

export const C2M = {
  inputText: 'input:text',
  inputDrop: 'input:drop',
  micFrame: 'mic:frame',
  cancel: 'control:cancel',
  approvalAnswer: 'approval:answer',
  touch: 'character:touch',
  ignoreMouse: 'window:ignore-mouse',
  drag: 'window:drag',
  dragEnd: 'window:drag-end',
  scale: 'window:scale',
  speechPlayed: 'speech:played',
  morphReport: 'character:morph-report',
  ready: 'character:ready',
  openAdmin: 'ui:open-admin',
  contextMenu: 'ui:context-menu',
  inputPanel: 'ui:input-panel',
  userActive: 'ui:user-active',
} as const;

export interface C2MPayloads {
  [C2M.inputText]: string;
  [C2M.inputDrop]: string[];
  [C2M.micFrame]: ArrayBuffer;
  [C2M.cancel]: void;
  [C2M.approvalAnswer]: { id: string; answer: ApprovalAnswer };
  [C2M.touch]: 'head' | 'body';
  [C2M.ignoreMouse]: boolean;
  [C2M.drag]: { dx: number; dy: number };
  [C2M.dragEnd]: void;
  [C2M.scale]: number; // multiplicative delta, e.g. 1.1
  [C2M.speechPlayed]: { sentenceId: number; phase: 'start' | 'end' };
  [C2M.morphReport]: { found: string[]; missing: string[]; modelLoaded: boolean; error?: string };
  [C2M.ready]: void;
  [C2M.openAdmin]: AdminPage | undefined;
  [C2M.contextMenu]: void;
  [C2M.inputPanel]: boolean; // input panel open/closed
  [C2M.userActive]: void;
}

// ---------------- main -> character window ----------------

export const M2C = {
  state: 'state:changed',
  sentence: 'reply:sentence',
  detail: 'reply:detail',
  userEcho: 'reply:user',
  speechAudio: 'speech:audio',
  speechStop: 'speech:stop',
  approvalRequest: 'approval:request',
  approvalResolved: 'approval:resolved',
  cursor: 'cursor:position',
  loadCharacter: 'character:load',
  openInput: 'ui:open-input',
  status: 'ui:status',
  view: 'ui:view',
  toast: 'ui:toast',
  emotion: 'character:emotion',
  mood: 'character:mood',
  windowBounds: 'window:bounds',
  micCapture: 'mic:capture',
  listening: 'mic:listening',
  sleepy: 'character:sleepy',
  /** the character window was shown / hidden (or minimized): the renderer stops drawing while hidden */
  visible: 'window:visible',
} as const;

export interface SentencePayload {
  turnId: number;
  sentenceId: number;
  text: string;
  emotion: Emotion;
  intensity: number;
  /** true if no audio will follow (muted / TTS failed) */
  silent: boolean;
}

export interface SpeechAudioPayload {
  turnId: number;
  sentenceId: number;
  wav: ArrayBuffer;
  /** null when synthesized without mora info (fallback TTS) */
  query: VoicevoxAudioQuery | null;
  emotion: Emotion;
  intensity: number;
  preview?: boolean;
}

export interface CharacterLoadPayload {
  preset: CharacterPreset;
  /** mmd:// URL of the PMX, or null if no model is configured */
  modelUrl: string | null;
  motionUrls: { emotions: Partial<Record<Emotion, string>>; idle: string[] };
  affinityStage: number;
}

export interface ViewSettingsPayload {
  muted: boolean;
  fps: number;
  physics: boolean;
  gazeLimit: number;
  showBubble: boolean;
  liveliness: Settings['render']['liveliness'];
  scale: number;
  sleeping: boolean;
  micEnabled: boolean;
  voiceInput: Settings['voice']['input'];
  voiceFilter: Settings['voice']['postFilter'];
}

export interface M2CPayloads {
  [M2C.state]: CharacterState;
  [M2C.sentence]: SentencePayload;
  [M2C.detail]: { turnId: number; markdown: string };
  [M2C.userEcho]: { text: string; source: 'voice' | 'text' | 'drop' };
  [M2C.speechAudio]: SpeechAudioPayload;
  [M2C.speechStop]: void;
  [M2C.approvalRequest]: ApprovalRequest;
  [M2C.approvalResolved]: { id: string; decision: string };
  [M2C.cursor]: { x: number; y: number; winX: number; winY: number };
  [M2C.loadCharacter]: CharacterLoadPayload;
  [M2C.openInput]: void;
  [M2C.status]: ServiceStatus;
  [M2C.view]: ViewSettingsPayload;
  [M2C.toast]: { text: string; kind: 'info' | 'warn' | 'error' };
  [M2C.emotion]: { emotion: Emotion; intensity: number };
  [M2C.mood]: number;
  [M2C.windowBounds]: { width: number; height: number; scale: number };
  /** start/stop sending mic frames */
  [M2C.micCapture]: boolean;
  /** live speech activity for the mic indicator */
  [M2C.listening]: { speech: boolean };
  /** 0..1 drowsiness from user inactivity (spec 4.3 放置反応) */
  [M2C.sleepy]: number;
  [M2C.visible]: boolean;
}

// ---------------- admin window: invoke (request/response) ----------------

export type AdminPage = 'settings' | 'voice' | 'memory' | 'history' | 'tools' | 'setup';

export interface MemoryFilter {
  kind?: MemoryKind;
  status?: MemoryStatus;
  query?: string;
}

export interface VoicePreviewRequest {
  text: string;
  voice: CharacterVoice;
  emotion: Emotion;
  intensity?: number;
  onModel: boolean;
}

export interface DictWordInput {
  surface: string;
  pronunciation: string;
  accentType: number;
  wordType: WordType;
  priority: number;
}

export interface VoiceFitRequest {
  /** サンプル音声（モノラル）。管理画面で mp3 等をデコードして渡す */
  pcm: Float32Array;
  sr: number;
  /** サンプルで話している内容。空なら音声認識で書き起こす */
  text: string;
  /** speaker: 今の話者のスタイルだけ / all: すべての話者 */
  scope: 'speaker' | 'all';
  speakerId: number;
  /** 調声画面で選んでいるエンジン（保存前に切り替えた場合）。空なら保存済みのもの */
  engineUrl?: string;
}

export interface VoiceFitResult {
  ok: boolean;
  error?: string;
  text?: string;
  transcribed?: boolean;
  sample?: { f0Hz: number; logF0Std: number; activeSec: number; totalSec: number };
  candidates?: FitCandidate[];
}

export interface VoiceFitProgressEvent {
  phase: 'transcribe' | 'screen' | 'fit';
  done: number;
  total: number;
  label: string;
}

export interface EngineInfo {
  /** 見つかった run.exe（無ければ null） */
  path: string | null;
  running: boolean;
  /** このアプリが起動したエンジンか（終了時に一緒に止める） */
  ownsEngine: boolean;
}

export interface SearchHit {
  message: MessageRecord;
  snippet: string;
}

export interface AdminInvokeMap {
  'settings:get': { args: []; ret: Settings };
  'settings:set': { args: [patch: DeepPartial<Settings>]; ret: Settings };
  'secrets:status': { args: []; ret: { hasKey: boolean; masked: string } };
  'secrets:set-api-key': { args: [key: string]; ret: { ok: boolean; masked: string; error?: string } };
  'calendar:status': { args: []; ret: { hasUrl: boolean; masked: string; lastSyncAt: string | null; error: string | null; upcoming: string[] } };
  'calendar:set-url': { args: [url: string]; ret: { ok: boolean; error?: string; count?: number } };
  'calendar:sync': { args: []; ret: { ok: boolean; error?: string; count?: number } };
  'character:get': { args: []; ret: CharacterPreset };
  'character:save': { args: [preset: CharacterPreset]; ret: { ok: boolean; error?: string } };
  'character:list': { args: []; ret: { id: string; name: string }[] };
  'character:activate': { args: [id: string]; ret: { ok: boolean } };
  'character:create': { args: [name: string]; ret: { id: string } };
  'character:pick-model': { args: []; ret: string | null };
  'character:pick-folder': { args: []; ret: string | null };
  'character:morph-report': { args: []; ret: { found: string[]; missing: string[]; modelLoaded: boolean } | null };
  'character:skill-status': { args: []; ret: SkillStatus };
  'character:skill-create': { args: [kind: 'draft' | 'sample']; ret: { ok: boolean; path: string; error?: string } };
  'character:open-folder': { args: []; ret: void };
  'character:mode-get': { args: []; ret: { list: string[]; current: string | null } };
  'character:mode-set': { args: [mode: string | null]; ret: { ok: boolean; current: string | null; error?: string } };
  'memory:list': { args: [filter: MemoryFilter]; ret: MemoryRecord[] };
  'memory:add': { args: [m: { kind: MemoryKind; content: string; importance: number; pinned: boolean }]; ret: MemoryRecord };
  'memory:update': { args: [id: number, patch: Partial<Pick<MemoryRecord, 'kind' | 'content' | 'importance' | 'pinned' | 'status' | 'dueAt'>>]; ret: MemoryRecord | null };
  'memory:delete': { args: [id: number]; ret: boolean };
  'memory:delete-all': { args: []; ret: boolean };
  'memory:export': { args: []; ret: string | null };
  'memory:source': { args: [messageId: number]; ret: { session: SessionRecord; messages: MessageRecord[] } | null };
  'relationship:get': { args: []; ret: Relationship & { stage: number; stageName: string } };
  'history:sessions': { args: [limit: number, offset: number]; ret: SessionRecord[] };
  'history:messages': { args: [sessionId: number]; ret: MessageRecord[] };
  'history:search': { args: [q: string]; ret: SearchHit[] };
  'tool-log:list': { args: [limit: number]; ret: ToolRunRecord[] };
  'tool-log:undo': { args: [id: number]; ret: { ok: boolean; message: string } };
  'voice:speakers': { args: [engineUrl?: string]; ret: { ok: boolean; speakers: VoicevoxSpeaker[]; version?: string; kind?: EngineKind; error?: string } };
  'voice:preview': { args: [req: VoicePreviewRequest]; ret: { ok: boolean; error?: string; wav?: ArrayBuffer; engine?: EngineKind | 'fallback' } };
  'voice:stop': { args: []; ret: void };
  'voice:save': { args: [voice: CharacterVoice]; ret: { ok: boolean } };
  'voice:dict-list': { args: []; ret: VoiceDictWord[] };
  'voice:dict-add': { args: [w: DictWordInput]; ret: { ok: boolean; error?: string; word?: VoiceDictWord } };
  'voice:dict-update': { args: [id: number, w: DictWordInput]; ret: { ok: boolean; error?: string } };
  'voice:dict-delete': { args: [id: number]; ret: { ok: boolean; error?: string } };
  'voice:accent-phrases': { args: [text: string, styleId: number]; ret: { ok: boolean; accentPhrases?: VoicevoxAccentPhrase[]; error?: string } };
  'voice:mora-data': { args: [accentPhrases: VoicevoxAccentPhrase[], styleId: number]; ret: { ok: boolean; accentPhrases?: VoicevoxAccentPhrase[]; error?: string } };
  'voice:engine-info': { args: []; ret: EngineInfo };
  'voice:engine-start': { args: [engineUrl?: string]; ret: { ok: boolean; result: string; message: string } };
  'voice:pick-engine': { args: []; ret: { canceled: boolean; path: string | null } };
  'voice:fit': { args: [req: VoiceFitRequest]; ret: VoiceFitResult };
  'voice:fit-cancel': { args: []; ret: void };
  'status:get': { args: []; ret: ServiceStatus };
  'llm:local-probe': { args: [url?: string]; ret: LocalLlmProbe };
  'journal:run': { args: []; ret: JournalRunResult };
  'journal:open-folder': { args: []; ret: void };
  'usage:get': { args: []; ret: UsageSummary };
  'usage:breakdown': { args: []; ret: UsageBreakdownRow[] };
  'setup:complete': { args: []; ret: void };
  'app:open-external': { args: [url: string]; ret: void };
  'app:version': { args: []; ret: string };
  /** 今すぐ GitHub の最新版を確認する。新しければそのまま更新して再起動する */
  'update:check': { args: []; ret: { result: 'disabled' | 'busy' | 'up-to-date' | 'no-installer' | 'installing' | 'failed'; current: string; latest: string | null } };
}

export type AdminChannel = keyof AdminInvokeMap;

export const ADMIN_CHANNELS = [
  'settings:get', 'settings:set', 'secrets:status', 'secrets:set-api-key', 'llm:local-probe', 'journal:run', 'journal:open-folder', 'calendar:status', 'calendar:set-url', 'calendar:sync',
  'character:get', 'character:save', 'character:list', 'character:activate', 'character:create',
  'character:pick-model', 'character:pick-folder', 'character:morph-report',
  'character:skill-status', 'character:skill-create', 'character:open-folder', 'character:mode-get', 'character:mode-set',
  'memory:list', 'memory:add', 'memory:update', 'memory:delete', 'memory:delete-all', 'memory:export', 'memory:source',
  'relationship:get', 'history:sessions', 'history:messages', 'history:search',
  'tool-log:list', 'tool-log:undo',
  'voice:speakers', 'voice:preview', 'voice:stop', 'voice:save',
  'voice:dict-list', 'voice:dict-add', 'voice:dict-update', 'voice:dict-delete',
  'voice:accent-phrases', 'voice:mora-data',
  'voice:engine-info', 'voice:engine-start', 'voice:pick-engine', 'voice:fit', 'voice:fit-cancel',
  'status:get', 'usage:get', 'usage:breakdown', 'setup:complete', 'app:open-external', 'app:version', 'update:check',
] as const satisfies readonly AdminChannel[];

/** main -> admin window push events */
export const M2A = {
  navigate: 'admin:navigate',
  status: 'admin:status',
  settingsChanged: 'admin:settings-changed',
  memoryChanged: 'admin:memory-changed',
  toolRun: 'admin:tool-run',
  voiceFitProgress: 'admin:voice-fit-progress',
} as const;

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K];
};

// ---------------- bridge shapes exposed by preload ----------------

type Unsubscribe = () => void;

export interface CharacterBridge {
  send<K extends keyof C2MPayloads>(channel: K, payload: C2MPayloads[K]): void;
  on<K extends keyof M2CPayloads>(channel: K, cb: (payload: M2CPayloads[K]) => void): Unsubscribe;
  /** Absolute file paths for dropped File objects (webUtils.getPathForFile). */
  pathsForFiles(files: File[]): string[];
}

export interface AdminBridge {
  invoke<K extends AdminChannel>(channel: K, ...args: AdminInvokeMap[K]['args']): Promise<AdminInvokeMap[K]['ret']>;
  on(channel: (typeof M2A)[keyof typeof M2A], cb: (payload: unknown) => void): Unsubscribe;
}
