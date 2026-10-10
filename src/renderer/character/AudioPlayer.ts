// Plays synthesized sentences in order and drives the mouth (spec 2.3 AudioPlayer, 4.4).
import type { SpeechAudioPayload } from '@shared/ipc';
import type { VoiceFilter } from '@shared/types';
import { createVoiceChain, type VoiceChain } from '../shared/voiceFilter';
import { buildLipTimeline, type LipKey, type MouthWeights, sampleMouth, VolumeLip } from './lipsync';

interface Item {
  p: SpeechAudioPayload;
  buffer: AudioBuffer | null;
  keys: LipKey[] | null;
}

export interface AudioPlayerEvents {
  onStart(p: SpeechAudioPayload): void;
  onEnd(p: SpeechAudioPayload): void;
}

const ZERO: MouthWeights = { a: 0, i: 0, u: 0, e: 0, o: 0 };

export class AudioPlayer {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private chain: VoiceChain | null = null;
  private filter: VoiceFilter = 'soft';
  private queue: Item[] = [];
  private current: { item: Item; src: AudioBufferSourceNode; startedAt: number } | null = null;
  private volLip = new VolumeLip();
  private lastSample = 0;
  private readonly data = new Float32Array(1024);
  private decoding = Promise.resolve();

  constructor(private readonly ev: AudioPlayerEvents) {}

  private audio(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.connect(this.ctx.destination);
      this.chain = createVoiceChain(this.ctx, this.filter);
      this.chain.output.connect(this.analyser);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  enqueue(p: SpeechAudioPayload): void {
    const item: Item = { p, buffer: null, keys: p.query ? buildLipTimeline(p.query) : null };
    this.queue.push(item);
    // decode in arrival order, then try to play
    this.decoding = this.decoding.then(async () => {
      try {
        item.buffer = await this.audio().decodeAudioData(p.wav.slice(0));
      } catch (e) {
        console.warn('decode failed', e);
        this.queue = this.queue.filter((q) => q !== item);
        this.ev.onEnd(p);
      }
      this.pump();
    });
  }

  private pump(): void {
    if (this.current) return;
    const next = this.queue[0];
    if (!next || !next.buffer) return;
    this.queue.shift();
    const ctx = this.audio();
    const src = ctx.createBufferSource();
    src.buffer = next.buffer;
    src.connect(this.chain!.input);
    const startAt = ctx.currentTime + 0.02;
    src.start(startAt);
    this.current = { item: next, src, startedAt: startAt };
    this.ev.onStart(next.p);
    src.onended = () => {
      if (this.current?.src !== src) return;
      this.current = null;
      this.ev.onEnd(next.p);
      this.pump();
    };
  }

  /** 音質フィルター（設定の voice.postFilter） */
  setFilter(mode: VoiceFilter): void {
    this.filter = mode;
    this.chain?.set(mode);
  }

  stop(): void {
    const cur = this.current;
    this.current = null;
    if (cur) {
      try {
        cur.src.onended = null;
        cur.src.stop();
      } catch {
        /* already stopped */
      }
    }
    this.queue = [];
  }

  get playing(): boolean {
    return !!this.current;
  }

  /** Mouth weights at the current playback position (mora timeline, or volume fallback). */
  mouth(): MouthWeights {
    const cur = this.current;
    if (!cur || !this.ctx) return ZERO;
    const t = this.ctx.currentTime - cur.startedAt;
    if (cur.item.keys) return sampleMouth(cur.item.keys, t);
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastSample) / 1000);
    this.lastSample = now;
    this.analyser!.getFloatTimeDomainData(this.data);
    let sum = 0;
    for (const v of this.data) sum += v * v;
    const a = this.volLip.update(Math.sqrt(sum / this.data.length), dt);
    return { a, i: 0, u: 0, e: 0, o: 0 };
  }
}
