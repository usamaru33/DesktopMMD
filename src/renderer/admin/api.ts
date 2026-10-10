import type { AdminChannel, AdminInvokeMap } from '@shared/ipc';
import type { VoiceFilter } from '@shared/types';
import { createVoiceChain, type VoiceChain } from '../shared/voiceFilter';

export function api<K extends AdminChannel>(channel: K, ...args: AdminInvokeMap[K]['args']): Promise<AdminInvokeMap[K]['ret']> {
  return window.mmdAdmin.invoke(channel, ...args);
}

export const onAdmin = (channel: Parameters<typeof window.mmdAdmin.on>[0], cb: (p: unknown) => void) => window.mmdAdmin.on(channel, cb);

let ctx: AudioContext | null = null;
let chain: VoiceChain | null = null;
let current: AudioBufferSourceNode | null = null;

/** Play a WAV returned by voice:preview inside the admin window (filter: 会話と同じ音質フィルターをかける). */
export async function playWav(wav: ArrayBuffer, filter?: VoiceFilter): Promise<void> {
  ctx ??= new AudioContext();
  stopWav();
  const buf = await ctx.decodeAudioData(wav.slice(0));
  const src = ctx.createBufferSource();
  src.buffer = buf;
  if (filter) {
    if (!chain) {
      chain = createVoiceChain(ctx, filter);
      chain.output.connect(ctx.destination);
    }
    chain.set(filter);
    src.connect(chain.input);
  } else {
    src.connect(ctx.destination);
  }
  src.start();
  current = src;
  await new Promise<void>((r) => (src.onended = () => r()));
}

export function stopWav(): void {
  try {
    current?.stop();
  } catch {
    /* ignore */
  }
  current = null;
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
