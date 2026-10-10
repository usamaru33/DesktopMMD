// Interfaces between the Orchestrator and the services it drives (NFR-09: swappable adapters).
import type { Emotion } from '@shared/emotions';
import type { CharacterState, MemoryRecord, MessageSource } from '@shared/types';

export interface SentenceJob {
  turnId: number;
  sentenceId: number;
  text: string;
  emotion: Emotion;
  intensity: number;
}

/** Text-to-speech queue. Implemented by SpeechService (VOICEVOX + fallback). */
export interface TtsPort {
  /** Synthesize and send to the renderer. Resolves when the job is queued (not played). */
  enqueue(job: SentenceJob): void;
  /** Stop playback, drop pending synthesis. */
  cancel(): void;
  /** Resolves when every sentence of `turnId` finished playing (or immediately if nothing is pending). */
  whenDrained(turnId: number): Promise<void>;
  /** Called by the renderer bridge when playback of a sentence starts/ends. */
  played(sentenceId: number, phase: 'start' | 'end'): void;
  onFirstAudio?: (turnId: number) => void;
}

/** Speech-to-text side (sidecar). */
export interface SttPort {
  listenStart(mode: 'push' | 'vad'): void;
  listenStop(): void;
  pushAudio(frame: ArrayBuffer): void;
  setSpeakingBoost(on: boolean): void;
  readonly ready: boolean;
}

export interface UiPort {
  state(s: CharacterState): void;
  sentence(p: { turnId: number; sentenceId: number; text: string; emotion: Emotion; intensity: number; silent: boolean }): void;
  detail(turnId: number, markdown: string): void;
  userEcho(text: string, source: 'voice' | 'text' | 'drop'): void;
  toast(text: string, kind?: 'info' | 'warn' | 'error'): void;
  openInput(): void;
}

export interface MemoryPortForTurns {
  search(query: string, signal?: AbortSignal): Promise<MemoryRecord[]>;
  profile(): MemoryRecord[];
  markUsed(ids: number[]): void;
  onTurnFinished(sessionId: number): void;
  recordEmotion(emotion: Emotion, intensity: number): void;
  stage(): number;
}

export type TurnInput =
  | { kind: 'user'; source: Exclude<MessageSource, 'proactive'>; text: string; files?: string[]; speechEndAt?: number; transcriptAt?: number }
  | { kind: 'proactive'; trigger: string; detail: string; eventId?: number };
