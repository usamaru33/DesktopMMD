// Python sidecar process management and WebSocket client (spec 2.4, 5.6; NFR-08 auto restart).
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import readline from 'node:readline';
import WebSocket from 'ws';
import type { SttPort } from '../adapters';
import type { Logger } from '../util/logger';

export interface SidecarOptions {
  /** python.exe (dev venv) or the packaged sidecar.exe */
  command: string;
  args: string[];
  modelsDir: string;
  sttModel(): string;
  device(): 'auto' | 'cuda' | 'cpu';
  vocab(): string[];
  sttEnabled(): boolean;
  log: Logger;
}

export interface SidecarEvents {
  status: [status: 'starting' | 'ok' | 'down' | 'disabled', detail?: string];
  speechStart: [];
  speechEnd: [discarded: boolean];
  transcript: [t: { text: string; confidence: number; durationMs: number; procMs: number }];
  sttReady: [device: string, model: string];
  embedReady: [];
}

export class SidecarClient extends EventEmitter implements SttPort {
  private proc: ChildProcess | null = null;
  private ws: WebSocket | null = null;
  private token = '';
  private stopped = false;
  private backoff = 1000;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastPong = 0;
  private sttOk = false;
  private embedOk = false;
  private embedSeq = 0;
  private pendingEmbeds = new Map<number, { resolve: (v: Float32Array[]) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private pendingClips = new Map<number, { resolve: (text: string) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  device = '';

  constructor(private readonly o: SidecarOptions) {
    super();
  }

  get ready(): boolean {
    return this.sttOk && this.ws?.readyState === WebSocket.OPEN;
  }

  get embedReady(): boolean {
    return this.embedOk && this.ws?.readyState === WebSocket.OPEN;
  }

  start(): void {
    this.stopped = false;
    if (!fs.existsSync(this.o.command)) {
      this.o.log.warn(`sidecar not found: ${this.o.command} (dev: "npm run sidecar:setup" / installer: "npm run sidecar:build" before "npm run dist")`);
      this.emit('status', 'disabled', 'not_installed');
      return;
    }
    this.spawn();
  }

  private spawn(): void {
    this.token = randomBytes(24).toString('hex');
    this.emit('status', 'starting');
    const args = [...this.o.args, '--port', '0', '--token', this.token, '--models-dir', this.o.modelsDir];
    this.o.log.info('starting sidecar');
    const p = spawn(this.o.command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' } });
    this.proc = p;
    const rl = readline.createInterface({ input: p.stdout! });
    let gotPort = false;
    rl.on('line', (line) => {
      if (gotPort) return;
      try {
        const { port } = JSON.parse(line);
        gotPort = true;
        this.connect(port);
      } catch {
        /* not the port line */
      }
    });
    p.stderr?.on('data', (d: Buffer) => {
      const s = d.toString('utf8').trim();
      if (s) this.o.log.debug(`py: ${s.slice(0, 300)}`);
    });
    p.on('exit', (code) => {
      this.o.log.warn(`sidecar exited (${code})`);
      this.cleanup();
      if (!this.stopped) this.scheduleRestart();
    });
    p.on('error', (e) => this.o.log.error('sidecar spawn error', e));
  }

  private connect(port: number): void {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { perMessageDeflate: false });
    this.ws = ws;
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', token: this.token, sttModel: this.o.sttModel(), device: this.o.device(), stt: this.o.sttEnabled(), vocab: this.o.vocab() }));
      this.lastPong = Date.now();
      this.pingTimer = setInterval(() => this.ping(), 5000);
      this.backoff = 1000;
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      try {
        this.onMessage(JSON.parse(data.toString()));
      } catch (e) {
        this.o.log.warn('bad sidecar message', e);
      }
    });
    ws.on('close', () => {
      if (this.ws === ws) this.ws = null;
    });
    ws.on('error', (e) => this.o.log.warn('sidecar ws error', e));
  }

  private ping(): void {
    if (Date.now() - this.lastPong > 15_000) {
      this.o.log.warn('sidecar not responding, restarting');
      this.proc?.kill();
      return;
    }
    this.sendJson({ type: 'ping', t: Date.now() });
  }

  private onMessage(m: Record<string, unknown>): void {
    switch (m.type) {
      case 'pong':
        this.lastPong = Date.now();
        break;
      case 'ready':
        if (m.component === 'stt') {
          this.sttOk = true;
          this.device = String(m.device);
          this.o.log.info(`sidecar STT ready on ${m.device} (${m.sttModel}, ${m.loadMs}ms)`);
          this.emit('sttReady', String(m.device), String(m.sttModel));
          this.emit('status', 'ok', String(m.device));
        } else if (m.component === 'embed') {
          this.embedOk = true;
          this.emit('embedReady');
        } else if (m.component === 'vad' && !this.o.sttEnabled()) {
          this.emit('status', 'ok', 'embed-only');
        }
        break;
      case 'speech_start':
        this.emit('speechStart');
        break;
      case 'speech_end':
        this.emit('speechEnd', !!m.discarded);
        break;
      case 'transcript':
        if (!m.discarded && typeof m.text === 'string' && m.text) {
          this.emit('transcript', { text: m.text, confidence: Number(m.confidence ?? 0), durationMs: Number(m.durationMs ?? 0), procMs: Number(m.procMs ?? 0) });
        } else this.emit('transcript', { text: '', confidence: 0, durationMs: 0, procMs: 0 });
        break;
      case 'embedding': {
        const p = this.pendingEmbeds.get(Number(m.id));
        if (p) {
          clearTimeout(p.timer);
          this.pendingEmbeds.delete(Number(m.id));
          p.resolve((m.vectors as number[][]).map((v) => Float32Array.from(v)));
        }
        break;
      }
      case 'clip_transcript': {
        const p = this.pendingClips.get(Number(m.id));
        if (p) {
          clearTimeout(p.timer);
          this.pendingClips.delete(Number(m.id));
          p.resolve(String(m.text ?? ''));
        }
        break;
      }
      case 'error': {
        this.o.log.warn(`sidecar error [${m.component ?? ''}] ${m.message}`);
        if (m.id !== undefined && m.component === 'clip') {
          const p = this.pendingClips.get(Number(m.id));
          if (p) {
            clearTimeout(p.timer);
            this.pendingClips.delete(Number(m.id));
            p.reject(new Error(String(m.message)));
          }
          break;
        }
        if (m.id !== undefined) {
          const p = this.pendingEmbeds.get(Number(m.id));
          if (p) {
            clearTimeout(p.timer);
            this.pendingEmbeds.delete(Number(m.id));
            p.reject(new Error(String(m.message)));
          }
        }
        if (m.component === 'stt' && m.message !== 'not_ready') this.emit('status', 'down', String(m.message));
        break;
      }
    }
  }

  private sendJson(o: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(o));
  }

  listenStart(mode: 'push' | 'vad'): void {
    this.sendJson({ type: 'listen_start', mode });
  }

  listenStop(): void {
    this.sendJson({ type: 'listen_stop' });
  }

  pushAudio(frame: ArrayBuffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(Buffer.from(frame), { binary: true });
  }

  setSpeakingBoost(on: boolean): void {
    this.sendJson({ type: 'set_threshold', speakingBoost: on });
  }

  /** Ask the sidecar to release idle memory now (tests / diagnostics). */
  trim(): void {
    this.sendJson({ type: 'trim' });
  }

  setVocab(vocab: string[]): void {
    this.sendJson({ type: 'set_vocab', vocab });
  }

  embed(texts: string[], kind: 'query' | 'passage', timeoutMs = 10_000): Promise<Float32Array[]> {
    if (!this.embedReady) return Promise.reject(new Error('embedder not ready'));
    const id = ++this.embedSeq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingEmbeds.delete(id);
        reject(new Error('embed timeout'));
      }, timeoutMs);
      this.pendingEmbeds.set(id, { resolve, reject, timer });
      this.sendJson({ type: 'embed', id, texts, kind });
    });
  }

  /** 音声ファイル1本を書き起こす（16kHz モノラル）。自動調声のサンプル用 */
  transcribeClip(samples: Float32Array, timeoutMs = 120_000): Promise<string> {
    if (!this.ready) return Promise.reject(new Error('音声認識が準備できていません'));
    const pcm = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767)));
    const id = ++this.embedSeq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingClips.delete(id);
        reject(new Error('書き起こしがタイムアウトしました'));
      }, timeoutMs);
      this.pendingClips.set(id, { resolve, reject, timer });
      this.sendJson({ type: 'transcribe_clip', id, pcm: Buffer.from(pcm.buffer).toString('base64') });
    });
  }

  private cleanup(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.ws?.terminate();
    this.ws = null;
    this.proc = null;
    this.sttOk = false;
    this.embedOk = false;
    for (const p of this.pendingEmbeds.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('sidecar restarted'));
    }
    this.pendingEmbeds.clear();
    for (const p of this.pendingClips.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('sidecar restarted'));
    }
    this.pendingClips.clear();
    this.emit('status', 'down');
  }

  private scheduleRestart(): void {
    const delay = this.backoff;
    this.backoff = Math.min(30_000, this.backoff * 2);
    setTimeout(() => {
      if (!this.stopped) this.spawn();
    }, delay);
  }

  /** Restart with new settings (model / device). */
  restart(): void {
    this.proc?.kill();
  }

  stop(): void {
    this.stopped = true;
    try {
      this.proc?.stdin?.end();
    } catch {
      /* ignore */
    }
    const p = this.proc;
    setTimeout(() => p?.kill(), 2000);
  }
}
