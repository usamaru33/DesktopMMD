// End-to-end sidecar test: VOICEVOX speech → 16 kHz PCM → sidecar VAD + Whisper → transcript; embeddings;
// kill → auto restart (TC-13). Runs only with MMD_IT_SIDECAR=1 (downloads models on first run).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { SidecarClient } from '../../src/main/sidecar/SidecarClient';
import { VoicevoxClient } from '../../src/main/speech/VoicevoxClient';
import { cosine } from '../../src/main/memory/scoring';

const enabled = process.env.MMD_IT_SIDECAR === '1';
const root = path.resolve(__dirname, '../..');
const log = { debug() {}, info: (m: string) => console.log(m), warn: (m: string) => console.log(m), error: (m: string) => console.log(m) };

function waitFor<T>(sc: SidecarClient, ev: string, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${ev}`)), timeoutMs);
    sc.once(ev, (...a: unknown[]) => {
      clearTimeout(t);
      resolve(a as T);
    });
  });
}

/** Parse a 16-bit PCM WAV and resample (linear) to 16 kHz mono Int16. */
function to16k(wav: ArrayBuffer): Int16Array {
  const v = new DataView(wav);
  let off = 12;
  let rate = 24000;
  let ch = 1;
  let data: Int16Array | null = null;
  while (off + 8 <= wav.byteLength) {
    const id = String.fromCharCode(v.getUint8(off), v.getUint8(off + 1), v.getUint8(off + 2), v.getUint8(off + 3));
    const size = v.getUint32(off + 4, true);
    if (id === 'fmt ') {
      ch = v.getUint16(off + 10, true);
      rate = v.getUint32(off + 12, true);
    }
    if (id === 'data') data = new Int16Array(wav.slice(off + 8, off + 8 + size));
    off += 8 + size + (size % 2);
  }
  const src = data!;
  const frames = src.length / ch;
  const outLen = Math.floor((frames * 16000) / rate);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const x = (i * rate) / 16000;
    const i0 = Math.floor(x);
    const f = x - i0;
    const a = src[i0 * ch] ?? 0;
    const b = src[Math.min(frames - 1, i0 + 1) * ch] ?? 0;
    out[i] = Math.round(a + (b - a) * f);
  }
  return out;
}

describe.skipIf(!enabled)('sidecar (real models)', () => {
  let sc: SidecarClient;

  beforeAll(async () => {
    sc = new SidecarClient({
      // MMD_IT_SIDECAR_EXE=1 tests the PyInstaller build used by the installer
      command: process.env.MMD_IT_SIDECAR_EXE === '1' ? path.join(root, 'sidecar', 'dist', 'sidecar', 'sidecar.exe') : path.join(root, 'sidecar', '.venv', 'Scripts', 'python.exe'),
      args: process.env.MMD_IT_SIDECAR_EXE === '1' ? [] : ['-I', path.join(root, 'sidecar', 'main.py')],
      modelsDir: path.join(os.homedir(), 'AppData', 'Roaming', 'mmd-assistant', 'models'),
      sttModel: () => process.env.MMD_IT_STT_MODEL ?? 'large-v3-turbo',
      device: () => 'auto',
      vocab: () => ['アシスタント'],
      sttEnabled: () => true,
      log,
    });
    const ready = waitFor<[string, string]>(sc, 'sttReady', 30 * 60_000);
    sc.start();
    const [device, model] = await ready;
    console.log(`STT ready: ${model} on ${device}`);
  }, 30 * 60_000);

  afterAll(() => sc?.stop());

  it('transcribes VOICEVOX speech through VAD (vad mode, auto end-of-speech)', async () => {
    const vv = new VoicevoxClient('http://127.0.0.1:50021');
    const text = '明日の午前十時に会議の予定を入れてください。';
    const q = await vv.audioQuery(text, 3);
    const pcm = to16k(await vv.synthesis(q, 3));
    // 0.5 s of silence before and 1 s after, fed in 100 ms frames like the renderer does
    const silence = (ms: number) => new Int16Array(16 * ms);
    const all = new Int16Array([...silence(500), ...pcm, ...silence(1000)]);
    const started = waitFor(sc, 'speechStart', 10_000);
    const transcript = waitFor<[{ text: string; procMs: number }]>(sc, 'transcript', 60_000);
    sc.listenStart('vad');
    for (let i = 0; i < all.length; i += 1600) sc.pushAudio(all.slice(i, i + 1600).buffer);
    await started;
    const [t] = await transcript;
    console.log(`transcript: ${t.text} (${t.procMs} ms)`);
    sc.listenStop();
    expect(t.text).toMatch(/会議/);
    expect(t.text).toMatch(/予定/);
  }, 120_000);

  it('push-to-talk: flushes on listen_stop', async () => {
    const vv = new VoicevoxClient('http://127.0.0.1:50021');
    const pcm = to16k(await vv.synthesis(await vv.audioQuery('こんにちは、元気ですか。', 3), 3));
    const transcript = waitFor<[{ text: string }]>(sc, 'transcript', 60_000);
    sc.listenStart('push');
    for (let i = 0; i < pcm.length; i += 1600) sc.pushAudio(pcm.slice(i, i + 1600).buffer);
    await new Promise((r) => setTimeout(r, 200));
    sc.listenStop();
    const [t] = await transcript;
    console.log(`push transcript: ${t.text}`);
    expect(t.text).toMatch(/こんにち/);
  }, 120_000);

  it('NFR-05: right after an idle working-set trim, transcription is still fast', async () => {
    const vv = new VoicevoxClient('http://127.0.0.1:50021');
    const pcm = to16k(await vv.synthesis(await vv.audioQuery('今日の予定を教えてください。', 3), 3));
    sc.trim();
    await new Promise((r) => setTimeout(r, 1000));
    const transcript = waitFor<[{ text: string; procMs: number }]>(sc, 'transcript', 60_000);
    sc.listenStart('push');
    for (let i = 0; i < pcm.length; i += 1600) sc.pushAudio(pcm.slice(i, i + 1600).buffer);
    const t0 = Date.now();
    sc.listenStop();
    const [t] = await transcript;
    const ms = Date.now() - t0;
    console.log(`after trim: "${t.text}" proc=${t.procMs}ms end-to-end=${ms}ms`);
    expect(t.text).toMatch(/予定/);
    expect(ms).toBeLessThan(1500);
  }, 120_000);

  it('embeds Japanese text; related sentences are closer', async () => {
    for (let i = 0; i < 600 && !sc.embedReady; i++) await new Promise((r) => setTimeout(r, 500));
    const [q] = await sc.embed(['おすすめの飲み物は？'], 'query', 60_000);
    const [coffee, research] = await sc.embed(['コーヒーが苦手', '研究テーマは音声対話システム'], 'passage', 60_000);
    expect(q.length).toBe(384);
    expect(cosine(q, coffee)).toBeGreaterThan(cosine(q, research));
  }, 360_000);

  it('TC-13: restarts within 10 s after being killed', async () => {
    const proc = (sc as unknown as { proc: { kill(): void } }).proc;
    const back = waitFor(sc, 'status', 15_000);
    const t0 = Date.now();
    proc.kill();
    // first event is 'down', then 'starting'
    await back;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no restart')), 10_000);
      const on = (s: string) => {
        if (s === 'starting') {
          clearTimeout(timer);
          sc.off('status', on);
          resolve();
        }
      };
      sc.on('status', on);
    });
    expect(Date.now() - t0).toBeLessThan(10_000);
  }, 30_000);
});
