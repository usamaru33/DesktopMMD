// Sentence-level synthesis queue (spec 2.5 ⑤, 5.6; skill mmd-voice-pipeline §3–4).
import { autoEmotionStyles, type Emotion } from '@shared/emotions';
import type { CharacterPreset, CharacterVoice, Settings, VoicevoxAudioQuery, VoicevoxSpeaker } from '@shared/types';
import { type EngineKind, engineKind } from '@shared/voiceEngine';
import type { SpeechAudioPayload } from '@shared/ipc';
import type { SentenceJob, TtsPort } from '../adapters';
import type { Logger } from '../util/logger';
import { FallbackTts } from './FallbackTts';
import { type DictEntry, normalizeForTts, phraseKey } from './ttsNormalize';
import { shapePitch } from './pitchShape';
import { applyTuning, computeTuning } from './voiceTuning';
import { queryFromAccentPhrases, VoicevoxClient, VoicevoxError, wavDurationSec } from './VoicevoxClient';

type JobStatus = 'pending' | 'synth' | 'sent' | 'playing' | 'done';

interface Job extends SentenceJob {
  status: JobStatus;
  watchdog?: ReturnType<typeof setTimeout>;
}

export interface SpeechDeps {
  vv: VoicevoxClient;
  fallback: FallbackTts;
  character(): CharacterPreset;
  settings(): Settings;
  dict(): DictEntry[];
  send(p: SpeechAudioPayload): void;
  stop(): void;
  onSpeaking(on: boolean): void;
  onEngineStatus(s: 'ok' | 'down' | 'fallback'): void;
  onFirstAudio?(turnId: number): void;
  log: Logger;
}

const LOOKAHEAD = 2;

export interface SynthOut {
  wav: ArrayBuffer;
  /** 口パク用。モーラの長さが分からないとき（AivisSpeech・Windows音声）は null */
  query: VoicevoxAudioQuery | null;
  engine: EngineKind | 'fallback';
}

export class SpeechService implements TtsPort {
  private jobs: Job[] = [];
  private abort = new AbortController();
  private working = false;
  private drainWaiters: { turnId: number; resolve: () => void }[] = [];
  private engineOk = true;
  private recheck: ReturnType<typeof setInterval> | null = null;
  private speaking = false;
  private firstAudioTurns = new Set<number>();
  private previewAbort: AbortController | null = null;
  /** エンジンURLごとの種類と話者一覧（取れたときだけ覚える） */
  private kinds = new Map<string, EngineKind>();
  private speakerLists = new Map<string, VoicevoxSpeaker[]>();

  constructor(private readonly d: SpeechDeps) {}

  get engineAvailable(): boolean {
    return this.engineOk;
  }

  async checkEngine(): Promise<boolean> {
    this.d.vv.baseUrl = this.d.character().voice.engineUrl;
    try {
      await this.d.vv.version();
      await this.engineKindOf(this.d.vv.baseUrl);
      this.setEngine(true);
      return true;
    } catch {
      this.setEngine(false);
      return false;
    }
  }

  async warmUp(): Promise<boolean> {
    // エンジンの入れ替えや話者の追加に追いつくため、覚えていた種類と話者一覧を捨てる
    this.kinds.clear();
    this.speakerLists.clear();
    if (!(await this.checkEngine())) return false;
    const v = this.d.character().voice;
    const auto = Object.values(await this.autoStyles(v));
    const ids = new Set([v.speakerId, ...auto, ...Object.values(v.emotions).map((e) => e?.styleId).filter((x): x is number => x != null)]);
    for (const id of ids) {
      try {
        await this.d.vv.initializeSpeaker(id);
      } catch (e) {
        this.d.log.warn(`initialize_speaker ${id} failed`, e);
      }
    }
    return true;
  }

  /** VOICEVOX か AivisSpeech か（engine_manifest の名前で見分ける） */
  async engineKindOf(url: string): Promise<EngineKind> {
    const known = this.kinds.get(url);
    if (known) return known;
    const client = url === this.d.vv.baseUrl ? this.d.vv : new VoicevoxClient(url);
    const name = await client.engineName();
    const kind = engineKind(name, url);
    if (name) this.kinds.set(url, kind);
    return kind;
  }

  /** 感情ごとに自動で使うスタイル（OFF のときと話者一覧が取れないときは空） */
  private async autoStyles(voice: CharacterVoice): Promise<Partial<Record<Emotion, number>>> {
    if (voice.autoEmotionStyles === false) return {};
    let list = this.speakerLists.get(voice.engineUrl);
    if (!list) {
      try {
        list = await (voice.engineUrl === this.d.vv.baseUrl ? this.d.vv : new VoicevoxClient(voice.engineUrl)).speakers();
        this.speakerLists.set(voice.engineUrl, list);
      } catch {
        return {};
      }
    }
    return autoEmotionStyles(list, voice.speakerId);
  }

  private setEngine(ok: boolean): void {
    if (ok === this.engineOk && (ok || this.recheck)) return;
    this.engineOk = ok;
    this.d.onEngineStatus(ok ? 'ok' : 'fallback');
    if (!ok && !this.recheck) {
      this.recheck = setInterval(() => {
        this.d.vv
          .version()
          .then(() => {
            this.d.log.info('VOICEVOX is back');
            if (this.recheck) clearInterval(this.recheck);
            this.recheck = null;
            this.setEngine(true);
          })
          .catch(() => {});
      }, 30_000);
    }
  }

  // ---------------- TtsPort ----------------

  enqueue(job: SentenceJob): void {
    this.jobs.push({ ...job, status: 'pending' });
    void this.work();
  }

  cancel(): void {
    this.abort.abort();
    this.abort = new AbortController();
    for (const j of this.jobs) if (j.watchdog) clearTimeout(j.watchdog);
    this.jobs = [];
    this.d.stop();
    this.setSpeaking(false);
    this.flushWaiters();
  }

  whenDrained(turnId: number): Promise<void> {
    if (!this.jobs.some((j) => j.turnId === turnId && j.status !== 'done')) return Promise.resolve();
    return new Promise((resolve) => this.drainWaiters.push({ turnId, resolve }));
  }

  played(sentenceId: number, phase: 'start' | 'end'): void {
    const j = this.jobs.find((x) => x.sentenceId === sentenceId);
    if (!j) return;
    if (phase === 'start') {
      j.status = 'playing';
      this.setSpeaking(true);
      if (!this.firstAudioTurns.has(j.turnId)) {
        this.firstAudioTurns.add(j.turnId);
        this.d.onFirstAudio?.(j.turnId);
      }
    } else {
      this.finish(j);
    }
    void this.work();
  }

  // ---------------- internals ----------------

  private finish(j: Job): void {
    if (j.watchdog) clearTimeout(j.watchdog);
    j.status = 'done';
    this.jobs = this.jobs.filter((x) => x.status !== 'done');
    if (!this.jobs.length) this.setSpeaking(false);
    this.flushWaiters();
  }

  private flushWaiters(): void {
    this.drainWaiters = this.drainWaiters.filter((w) => {
      const pending = this.jobs.some((j) => j.turnId === w.turnId && j.status !== 'done');
      if (!pending) w.resolve();
      return pending;
    });
  }

  private setSpeaking(on: boolean): void {
    if (on === this.speaking) return;
    this.speaking = on;
    this.d.onSpeaking(on);
  }

  private async work(): Promise<void> {
    if (this.working) return;
    this.working = true;
    try {
      for (;;) {
        const ahead = this.jobs.filter((j) => j.status === 'sent').length;
        const next = this.jobs.find((j) => j.status === 'pending');
        if (!next || ahead >= LOOKAHEAD) break;
        next.status = 'synth';
        const signal = this.abort.signal;
        const out = await this.synthesize(next.text, next.emotion, next.intensity, this.d.character().voice, signal).catch((e) => {
          if (!signal.aborted) this.d.log.warn('synthesis failed', e);
          return null;
        });
        if (signal.aborted || !this.jobs.includes(next)) continue;
        if (!out) {
          this.finish(next);
          continue;
        }
        next.status = 'sent';
        const dur = wavDurationSec(out.wav);
        next.watchdog = setTimeout(() => {
          if (next.status !== 'done') {
            this.d.log.warn(`playback watchdog fired for sentence ${next.sentenceId}`);
            this.finish(next);
            void this.work();
          }
        }, (dur + 20) * 1000);
        this.d.send({ turnId: next.turnId, sentenceId: next.sentenceId, wav: out.wav, query: out.query, emotion: next.emotion, intensity: next.intensity });
      }
    } finally {
      this.working = false;
    }
  }

  /** VOICEVOX with tuning; falls back to Windows voice. Returns null if there is nothing to say. */
  async synthesize(
    rawText: string,
    emotion: Emotion,
    intensity: number,
    voice: CharacterVoice,
    signal: AbortSignal,
  ): Promise<SynthOut | null> {
    const text = normalizeForTts(rawText, this.d.dict());
    if (!text) return null;
    const s = this.d.settings();
    const global = { speed: s.voice.speed, volume: s.voice.volume };

    if (this.engineOk) {
      try {
        this.d.vv.baseUrl = voice.engineUrl;
        const kind = await this.engineKindOf(voice.engineUrl);
        const tuning = computeTuning(voice, emotion, intensity, global, { autoStyles: await this.autoStyles(voice), engine: kind });
        const key = phraseKey(text);
        // AivisSpeech はモーラの高さ・長さを使わないので、定型文のアクセント調整は効かない
        const phrase = kind === 'voicevox' ? voice.phrases.find((p) => phraseKey(p.text) === key && p.accentPhrases.length) : undefined;
        let q: VoicevoxAudioQuery;
        let speaker = tuning.speaker;
        if (phrase) {
          q = queryFromAccentPhrases(phrase.accentPhrases);
          speaker = phrase.styleId;
        } else {
          q = await this.d.vv.audioQuery(text, speaker, signal);
        }
        q = applyTuning(q, tuning);
        if (kind === 'aivis') {
          // モーラの長さが返らない（0）ので、口パクは音量で動かす（query を渡さない）
          return { wav: await this.d.vv.synthesis(q, speaker, signal), query: null, engine: kind };
        }
        // 高すぎる音を抑えるため、音高と抑揚はアプリ側でかける（疑問文の語尾上げも含めて）
        q = shapePitch(q, undefined, voice.base.pitchScale);
        const wav = await this.d.vv.synthesis(q, speaker, signal, undefined, false);
        return { wav, query: q, engine: kind };
      } catch (e) {
        if (signal.aborted) throw e;
        if (e instanceof VoicevoxError && e.status && e.status < 500) throw e; // bad input: don't switch engines
        this.d.log.warn('VOICEVOX unavailable, switching to Windows voice', e);
        this.setEngine(false);
      }
    }
    const tuning = computeTuning(voice, emotion, intensity, global);
    const wav = await this.d.fallback.synthesize(text, { speed: tuning.params.speedScale, volume: tuning.params.volumeScale }, signal);
    return { wav, query: null, engine: 'fallback' };
  }

  /** Tuning-screen preview with unsaved values; separate from the conversation queue (spec 5.6). */
  async preview(text: string, voice: CharacterVoice, emotion: Emotion, intensity = 1): Promise<SynthOut | null> {
    this.previewAbort?.abort();
    const ac = new AbortController();
    this.previewAbort = ac;
    // let a running conversation finish its current synthesis first
    for (let i = 0; i < 100 && this.working; i++) await new Promise((r) => setTimeout(r, 50));
    return this.synthesize(text, emotion, intensity, voice, ac.signal);
  }

  stopPreview(): void {
    this.previewAbort?.abort();
  }

  dispose(): void {
    if (this.recheck) clearInterval(this.recheck);
    this.cancel();
  }
}
