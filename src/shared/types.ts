import type { Emotion, EmotionVoice } from './emotions';

// ---------- Character state machine (spec 3.5) ----------

export type CharacterState =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'acting'
  | 'awaiting'
  | 'sleeping';

// ---------- Settings (spec 6.2) ----------

export type PermissionLevel = 'L0' | 'L1' | 'L2';
export type VoiceInputMode = 'push' | 'wake' | 'off';
export type Effort = 'low' | 'medium' | 'high';
/** 動きの活発さ（呼吸・揺れの大きさ、手持ちぶさたの仕草の頻度、話しながらのうなずき） */
export type Liveliness = 'calm' | 'normal' | 'lively';
/** キャラクターのどこを触ったか（画面上のボーン位置から決める） */
export type TouchPart = 'head' | 'cheek' | 'hand' | 'shoulder' | 'body' | 'legs';
/** tap: クリック、pat: 頭の上でマウスを左右に動かす（なでる） */
export type TouchKind = 'tap' | 'pat';
export type LlmProvider = 'claude' | 'local';

export interface AppEntry {
  name: string;
  path: string;
}

export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  level: PermissionLevel;
  enabled?: boolean;
}

export interface Settings {
  activeCharacter: string;
  llm: {
    /** 会話に使うAI。local は Ollama（会話だけ。ツール・Web検索は使えない） */
    provider: LlmProvider;
    /** provider=local のときの Ollama のURLとモデル名 */
    localUrl: string;
    localModel: string;
    /** ローカルAIでも作業（ツール）を使う（実験的）。依頼らしい発話のときだけ考える時間を取る */
    localTools: boolean;
    /** 声かけ（挨拶・休憩・リマインダー）だけはローカルAIで作る（Claudeで会話していても。Ollamaが無ければClaude） */
    localForProactive: boolean;
    chatModel: string;
    utilityModel: string;
    /** model for proactive speech (greetings, break suggestions, reminders) */
    proactiveModel: string;
    /** prompt cache lifetime: 1h costs more to write but survives the gaps between sporadic questions */
    cacheTtl: '5m' | '1h';
    monthlyBudgetUsd: number;
    effort: Effort;
  };
  user: { callName: string };
  voice: {
    input: VoiceInputMode;
    sttModel: string;
    sttDevice: 'auto' | 'cuda' | 'cpu';
    muted: boolean;
    volume: number;
    speed: number;
    micEnabled: boolean;
    wakeWord: string;
    /** アプリ起動時に VOICEVOX エンジンが動いていなければ起動する（このPCのエンジンのときだけ） */
    autoStartEngine: boolean;
    /** VOICEVOX の場所（空なら既定のインストール先を探す） */
    enginePath: string;
    /** 再生前の音質フィルター（off: なし / soft: 高域を少し削って軽く圧縮 / room: soft＋ごく短い残響） */
    postFilter: VoiceFilter;
  };
  window: {
    x: number | null;
    y: number | null;
    scale: number;
    displayId: number | null;
    /** FR-EX-05: hide while a full-screen app (game, video, slideshow) is in front */
    hideOnFullscreen: boolean;
  };
  render: {
    fps: number;
    physics: boolean;
    hardwareAcceleration: boolean;
    /** 視線の上限角度（度）。カーソルが画面の端にあっても、目線はこの角度までしか動かさない（白目が見えすぎるのを防ぐ） */
    gazeLimit: number;
    /** 会話の吹き出しを表示する（OFFでも読み上げと「詳細」パネルは使える） */
    showBubble: boolean;
    /** 個別に指定していない感情で、標準のモーション（VMD）を使う。OFFなら自前の簡単な動き */
    defaultMotions: boolean;
    /** 動きの活発さ */
    liveliness: Liveliness;
    /** 触ったり撫でたりしたときに、ひとこと話す（OFFでも表情と仕草の反応はする） */
    touchVoice: boolean;
  };
  tools: {
    allowedDirs: string[];
    apps: AppEntry[];
    levelOverrides: Record<string, PermissionLevel>;
    runCommandEnabled: boolean;
  };
  mcp: { servers: McpServerConfig[] };
  proactive: {
    enabled: boolean;
    quietHours: [string, string];
    bedtime: string;
    maxPerHour: number;
    /** 時報と休憩の声かけの間隔（分）。0で無効 */
    chimeMinutes: 0 | 30 | 60;
  };
  calendar: {
    enabled: boolean;
    /** 予定の何分前に知らせるか */
    leadMinutes: 5 | 10 | 15 | 30;
  };
  /** 夜のふりかえり日記（会話と作業をまとめたMarkdownを、決まった時刻に保存する） */
  journal: {
    enabled: boolean;
    /** 書く時刻 HH:MM */
    time: string;
    /** 保存先フォルダ（許可フォルダの中であること） */
    folder: string;
  };
  privacy: { watchActiveWindow: boolean; saveTranscripts: boolean };
  hotkeys: {
    pushToTalk: string;
    mute: string;
    toggleVisible: string;
  };
  sleeping: boolean;
  /** Windows にログインしたら起動する（インストール版のみ登録） */
  autoLaunch: boolean;
  /** 起動時に GitHub のリリースを確認し、新しい版があれば自動で更新する */
  autoUpdate: boolean;
  setupCompleted: boolean;
  /** 管理画面の表示。advanced: 細かい設定（モーション・キャラ設定の詳細・モデル選択など）も表示する */
  ui: { advanced: boolean };
  /** settings.json の形式の版。SettingsStore の migrateSettings が使う */
  settingsVersion: number;
}

// ---------- Character preset (spec 6.3 / 6.5) ----------

export interface VoiceBase {
  speedScale: number;
  pitchScale: number;
  intonationScale: number;
  volumeScale: number;
  pauseLengthScale: number;
  prePhonemeLength: number;
  postPhonemeLength: number;
}

export interface VoicevoxMora {
  text: string;
  consonant?: string | null;
  consonant_length?: number | null;
  vowel: string;
  vowel_length: number;
  pitch: number;
}

export interface VoicevoxAccentPhrase {
  moras: VoicevoxMora[];
  accent: number;
  pause_mora?: VoicevoxMora | null;
  is_interrogative?: boolean;
}

export interface VoicevoxAudioQuery extends VoiceBase {
  accent_phrases: VoicevoxAccentPhrase[];
  pauseLength?: number | null;
  outputSamplingRate: number;
  outputStereo: boolean;
  kana?: string;
}

export interface VoicePhrase {
  text: string;
  styleId: number;
  accentPhrases: VoicevoxAccentPhrase[];
}

export type VoiceFilter = 'off' | 'soft' | 'room';

export interface CharacterVoice {
  engineUrl: string;
  speakerId: number;
  base: VoiceBase;
  emotions: Partial<Record<Emotion, EmotionVoice>>;
  phrases: VoicePhrase[];
  /** 感情別の設定が無い感情は、話者に合うスタイル（喜び・悲しみなど）があればそれで話す。未設定は ON */
  autoEmotionStyles?: boolean;
}

export interface CharacterPreset {
  id: string;
  name: string;
  firstPerson: string;
  persona: string;
  /** Speech examples per affinity stage (index 0..3). */
  speechExamples: string[][];
  /** PMX path relative to the character folder, or an absolute path. Never copied, never modified. */
  model: string;
  scale: number;
  voice: CharacterVoice;
  /** Overrides like {"happy.eye": "笑い2", "mouth.a": "あ２"}. */
  morphMap: Record<string, string>;
  motions: {
    emotions: Partial<Record<Emotion, string>>;
    idle: string[];
  };
  credits: { model: string; voice: string; termsUrls: string[] };
}

// ---------- Conversation ----------

export type MessageRole = 'user' | 'assistant' | 'tool';
export type MessageSource = 'voice' | 'text' | 'proactive' | 'drop';

export interface MessageRecord {
  id: number;
  sessionId: number;
  role: MessageRole;
  source: MessageSource;
  content: string;
  emotion: Emotion | null;
  tokensIn: number;
  tokensOut: number;
  createdAt: string;
}

export interface SessionRecord {
  id: number;
  startedAt: string;
  endedAt: string | null;
  summary: string | null;
  extracted: boolean;
  noMemory: boolean;
}

// ---------- Memory (spec 5.7 / 6.4) ----------

export type MemoryKind = 'profile' | 'preference' | 'fact' | 'episode' | 'schedule';
export type MemoryStatus = 'active' | 'archived' | 'superseded' | 'trashed';

export interface MemoryRecord {
  id: number;
  kind: MemoryKind;
  content: string;
  importance: number;
  dueAt: string | null;
  sourceMessageId: number | null;
  status: MemoryStatus;
  supersededBy: number | null;
  pinned: boolean;
  useCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Relationship {
  affinity: number;
  mood: number;
  dailyDelta: number;
  deltaDate: string;
  firstMetAt: string;
}

// ---------- Tools (spec 5.5 / 6.4) ----------

export type ToolDecision = 'auto' | 'approved' | 'denied' | 'timeout' | 'blocked';

export interface ToolRunRecord {
  id: number;
  messageId: number | null;
  tool: string;
  level: PermissionLevel;
  argsJson: string;
  resultJson: string;
  decision: ToolDecision;
  undoJson: string | null;
  undoneAt: string | null;
  createdAt: string;
}

export interface ApprovalRequest {
  id: string;
  tool: string;
  title: string;
  targets: string[];
  summary: string;
  level: PermissionLevel;
  voiceAllowed: boolean;
  alwaysTodayAllowed: boolean;
  expiresAt: number;
}

export type ApprovalAnswer = 'approve' | 'deny' | 'always_today';

// ---------- Voice dictionary (spec 6.5) ----------

export type WordType = 'PROPER_NOUN' | 'COMMON_NOUN' | 'VERB' | 'ADJECTIVE' | 'SUFFIX';

export interface VoiceDictWord {
  id: number;
  surface: string;
  pronunciation: string;
  accentType: number;
  wordType: WordType;
  priority: number;
  engineUuid: string | null;
  updatedAt: string;
}

/** サンプル音声からの自動調声で合わせる値 */
export interface FitParams {
  speedScale: number;
  pitchScale: number;
  intonationScale: number;
}

export interface FitCandidate {
  styleId: number;
  label: string;
  params: FitParams;
  /** 0〜100。声色と高さの近さの目安 */
  score: number;
  /** 合わせたあとの合成音の測定値 */
  result: { f0Hz: number; logF0Std: number; activeSec: number };
}

export interface VoicevoxSpeaker {
  name: string;
  speaker_uuid: string;
  styles: { name: string; id: number; type?: string }[];
}

// ---------- Usage ----------

export interface UsageSummary {
  monthUsd: number;
  budgetUsd: number;
  todayUsd: number;
  degraded: boolean;
}

export interface UsageBreakdownRow {
  /** chat | tool_followup | proactive | extract | conflict | summary | other */
  purpose: string;
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearches: number;
  usd: number;
}

/** characters/<id>/skill.md の読み込み状態（docs/CHARACTER_SKILL_FORMAT.md） */
export interface SkillStatus {
  /** none: ファイルなし（character.json を使う） / ok: 使用中 / invalid: エラーがあるので使っていない */
  state: 'none' | 'ok' | 'invalid';
  path: string;
  name: string | null;
  version: string | null;
  chars: number;
  overlays: string[];
  issues: { level: 'error' | 'warning'; line: number; message: string }[];
}

export interface JournalRunResult {
  ok: boolean;
  path?: string;
  message: string;
  reason?: 'disabled' | 'folder' | 'no_material' | 'busy' | 'failed';
}

export interface LocalHardware {
  ramGb: number;
  gpuName: string | null;
  /** NVIDIA のVRAM合計(GB)。検出できなければ null */
  vramGb: number | null;
}

export interface LocalRecommendation {
  level: 'good' | 'ok' | 'light' | 'api';
  /** おすすめのモデル名（api のときは null） */
  model: string | null;
  message: string;
}

export interface LocalLlmProbe {
  ok: boolean;
  error?: string;
  version?: string | null;
  models: string[];
  /** 設定中のモデルが入っているか */
  hasModel: boolean;
  hardware: LocalHardware;
  recommendation: LocalRecommendation;
}

export interface ServiceStatus {
  llm: 'ok' | 'no_key' | 'error' | 'fake';
  voicevox: 'ok' | 'down' | 'fallback';
  sidecar: 'ok' | 'starting' | 'down' | 'disabled';
  sidecarDevice?: string;
  mcp: { name: string; status: 'ok' | 'error' | 'starting'; tools: number }[];
}
