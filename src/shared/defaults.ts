import type { CharacterPreset, Settings, VoiceBase } from './types';

/** 視線の上限角度（度）の既定値と範囲 */
export const GAZE_LIMIT_DEFAULT = 40;
export const GAZE_LIMIT_RANGE = { min: 0, max: 90 } as const;
/** settings.json の形式の版（上げたら SettingsStore.migrateSettings に移行処理を足す） */
export const SETTINGS_VERSION = 2;

/** Single source of truth for setting defaults (spec 6.2). */
export const DEFAULT_SETTINGS: Settings = {
  activeCharacter: 'default',
  llm: {
    provider: 'claude',
    localUrl: 'http://127.0.0.1:11434',
    localModel: 'qwen3:8b',
    localTools: false,
    localForProactive: false,
    chatModel: 'claude-sonnet-5-5',
    utilityModel: 'claude-haiku-4-5',
    proactiveModel: 'claude-haiku-4-5',
    cacheTtl: '1h',
    monthlyBudgetUsd: 20,
    effort: 'low',
  },
  user: { callName: '' },
  voice: {
    input: 'push',
    sttModel: 'large-v3-turbo',
    sttDevice: 'auto',
    muted: false,
    volume: 1.0,
    speed: 1.05,
    micEnabled: true,
    wakeWord: '',
    autoStartEngine: true,
    enginePath: '',
    postFilter: 'soft',
  },
  window: { x: null, y: null, scale: 1.0, displayId: null, hideOnFullscreen: true },
  render: { fps: 30, physics: true, hardwareAcceleration: true, gazeLimit: GAZE_LIMIT_DEFAULT, showBubble: true, defaultMotions: true, liveliness: 'normal', touchVoice: true },
  tools: {
    allowedDirs: ['~\\Documents', '~\\Desktop'],
    apps: [],
    levelOverrides: {},
    runCommandEnabled: false,
  },
  mcp: { servers: [] },
  proactive: {
    enabled: true,
    quietHours: ['00:30', '08:00'],
    bedtime: '01:00',
    maxPerHour: 2,
    chimeMinutes: 0,
  },
  calendar: { enabled: false, leadMinutes: 15 },
  journal: { enabled: false, time: '22:30', folder: '~\\Documents\\DesktopMMD日記' },
  privacy: { watchActiveWindow: false, saveTranscripts: true },
  hotkeys: {
    pushToTalk: 'Ctrl+Alt+Space',
    mute: 'Ctrl+Alt+M',
    toggleVisible: 'Ctrl+Alt+H',
  },
  sleeping: false,
  autoUpdate: true,
  autoLaunch: true,
  setupCompleted: false,
  ui: { advanced: false },
  settingsVersion: SETTINGS_VERSION,
};

/** VOICEVOX defaults: pitch 0.0, other scales 1.0 (spec 6.5). */
export const VOICEVOX_DEFAULT_BASE: VoiceBase = {
  speedScale: 1.0,
  pitchScale: 0.0,
  intonationScale: 1.0,
  volumeScale: 1.0,
  pauseLengthScale: 1.0,
  prePhonemeLength: 0.1,
  postPhonemeLength: 0.1,
};

/** Ranges and steps for tuning sliders (spec 6.5). */
export const VOICE_RANGES: Record<keyof VoiceBase, { min: number; max: number; step: number; label: string }> = {
  speedScale: { min: 0.5, max: 2.0, step: 0.01, label: '話速' },
  pitchScale: { min: -0.15, max: 0.15, step: 0.01, label: '音高' },
  intonationScale: { min: 0, max: 2.0, step: 0.01, label: '抑揚' },
  volumeScale: { min: 0, max: 2.0, step: 0.01, label: '音量' },
  pauseLengthScale: { min: 0, max: 2.0, step: 0.01, label: '文中の間' },
  prePhonemeLength: { min: 0, max: 1.5, step: 0.01, label: '文頭の無音' },
  postPhonemeLength: { min: 0, max: 1.5, step: 0.01, label: '文末の無音' },
};

export const DEFAULT_CHARACTER: CharacterPreset = {
  id: 'default',
  name: 'アシスタント',
  firstPerson: 'わたし',
  persona:
    '明るく素直で、少し照れ屋なデスクトップアシスタント。ユーザーの作業をそばで手伝うのが好き。' +
    '丁寧だが堅すぎない話し方をする。知らないことは知らないと言う。',
  speechExamples: [
    ['はじめまして。何かお手伝いできることはありますか？', 'わかりました、調べてみますね。'],
    ['おかえりなさい。今日も一緒にがんばりましょう。', 'それならこうしてみるのはどうですか？'],
    ['おつかれさま！ちょっと休憩しない？', 'それ、前に言ってたやつだよね。'],
    ['ねえ、今日はどうだった？', 'まかせて。いつもの感じでやっとくね。'],
  ],
  model: '',
  scale: 1.0,
  voice: {
    engineUrl: 'http://127.0.0.1:50021',
    speakerId: 0,
    base: { ...VOICEVOX_DEFAULT_BASE },
    emotions: {},
    phrases: [],
  },
  morphMap: {},
  motions: { emotions: {}, idle: [] },
  credits: { model: '', voice: 'VOICEVOX', termsUrls: [] },
};

export const LIMITS = {
  toolRoundTrips: 10,
  webSearchPerReply: 3,
  approvalTimeoutMs: 60_000,
  chatMaxTokens: 1024,
  extractMaxTokens: 2048,
  historyTurns: 20,
  historyTokens: 12_000,
  sessionGapMs: 30 * 60_000,
  extractIdleMs: 5 * 60_000,
  extractTurns: 20,
  memoryTopK: 8,
  memoryTokenBudget: 800,
  memoryMinCos: 0.35,
  readFileMaxBytes: 5 * 1024 * 1024,
  maxTimers: 20,
  /** 読み上げ（または表示）が終わってから吹き出しが消え始めるまで */
  bubbleHideMs: 2_000,
  bubbleFadeMs: 600,
} as const;
