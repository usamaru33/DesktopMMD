// VOICEVOX engine HTTP API (skill mmd-voice-pipeline §1).
import type { VoicevoxAccentPhrase, VoicevoxAudioQuery, VoicevoxSpeaker, WordType } from '@shared/types';

export class VoicevoxError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface EngineDictWord {
  surface: string;
  pronunciation: string;
  accent_type: number;
  word_type?: string;
  priority: number;
}

export class VoicevoxClient {
  constructor(
    public baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async req(path: string, init: RequestInit & { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Response> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), init.timeoutMs ?? 5000);
    const onAbort = () => ac.abort();
    init.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await this.fetchImpl(this.baseUrl.replace(/\/$/, '') + path, { ...init, signal: ac.signal });
      if (!res.ok) {
        let detail = '';
        try {
          detail = await res.text();
        } catch {
          /* ignore */
        }
        throw new VoicevoxError(`VOICEVOX ${path.split('?')[0]} ${res.status} ${detail.slice(0, 200)}`, res.status);
      }
      return res;
    } catch (e) {
      if (e instanceof VoicevoxError) throw e;
      throw new VoicevoxError(`VOICEVOX に接続できません (${(e as Error).message})`);
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener('abort', onAbort);
    }
  }

  async version(timeoutMs = 2000): Promise<string> {
    const r = await this.req('/version', { timeoutMs });
    return String(await r.json());
  }

  /** エンジンの名前（engine_manifest）。古いエンジンなど取れなければ空 */
  async engineName(): Promise<string> {
    try {
      const r = await this.req('/engine_manifest', { timeoutMs: 3000 });
      return String(((await r.json()) as { name?: unknown }).name ?? '');
    } catch {
      return '';
    }
  }

  async speakers(): Promise<VoicevoxSpeaker[]> {
    return (await this.req('/speakers')).json() as Promise<VoicevoxSpeaker[]>;
  }

  async initializeSpeaker(speaker: number): Promise<void> {
    await this.req(`/initialize_speaker?speaker=${speaker}&skip_reinit=true`, { method: 'POST', timeoutMs: 60_000 });
  }

  async audioQuery(text: string, speaker: number, signal?: AbortSignal): Promise<VoicevoxAudioQuery> {
    const r = await this.req(`/audio_query?text=${encodeURIComponent(text)}&speaker=${speaker}`, { method: 'POST', signal, timeoutMs: 5000 });
    return r.json() as Promise<VoicevoxAudioQuery>;
  }

  /** upspeak=false: 疑問文の語尾上げをエンジンにさせない（shapePitch で入れ済みのとき） */
  async synthesis(query: VoicevoxAudioQuery, speaker: number, signal?: AbortSignal, timeoutMs = 15_000, upspeak = true): Promise<ArrayBuffer> {
    const r = await this.req(`/synthesis?speaker=${speaker}${upspeak ? '' : '&enable_interrogative_upspeak=false'}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'audio/wav' },
      body: JSON.stringify(query),
      signal,
      timeoutMs,
    });
    return r.arrayBuffer();
  }

  async accentPhrases(text: string, speaker: number): Promise<VoicevoxAccentPhrase[]> {
    const r = await this.req(`/accent_phrases?text=${encodeURIComponent(text)}&speaker=${speaker}`, { method: 'POST' });
    return r.json() as Promise<VoicevoxAccentPhrase[]>;
  }

  async moraData(accentPhrases: VoicevoxAccentPhrase[], speaker: number): Promise<VoicevoxAccentPhrase[]> {
    const r = await this.req(`/mora_data?speaker=${speaker}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(accentPhrases),
    });
    return r.json() as Promise<VoicevoxAccentPhrase[]>;
  }

  async userDict(): Promise<Record<string, EngineDictWord>> {
    return (await this.req('/user_dict')).json() as Promise<Record<string, EngineDictWord>>;
  }

  private dictQuery(w: { surface: string; pronunciation: string; accentType: number; wordType: WordType; priority: number }): string {
    const q = new URLSearchParams({
      surface: w.surface,
      pronunciation: w.pronunciation,
      accent_type: String(w.accentType),
      word_type: w.wordType,
      priority: String(w.priority),
    });
    return q.toString();
  }

  async addWord(w: { surface: string; pronunciation: string; accentType: number; wordType: WordType; priority: number }): Promise<string> {
    const r = await this.req(`/user_dict_word?${this.dictQuery(w)}`, { method: 'POST' });
    return String(await r.json());
  }

  async updateWord(uuid: string, w: { surface: string; pronunciation: string; accentType: number; wordType: WordType; priority: number }): Promise<void> {
    await this.req(`/user_dict_word/${encodeURIComponent(uuid)}?${this.dictQuery(w)}`, { method: 'PUT' });
  }

  async deleteWord(uuid: string): Promise<void> {
    await this.req(`/user_dict_word/${encodeURIComponent(uuid)}`, { method: 'DELETE' });
  }
}

/** Rebuild an AudioQuery from saved accent phrases (fixed phrases, spec 5.6). */
export function queryFromAccentPhrases(accentPhrases: VoicevoxAccentPhrase[]): VoicevoxAudioQuery {
  return {
    accent_phrases: structuredClone(accentPhrases),
    speedScale: 1,
    pitchScale: 0,
    intonationScale: 1,
    volumeScale: 1,
    prePhonemeLength: 0.1,
    postPhonemeLength: 0.1,
    pauseLength: null,
    pauseLengthScale: 1,
    outputSamplingRate: 24000,
    outputStereo: false,
  };
}

/** Duration in seconds of a 16-bit PCM WAV (reads the header). */
export function wavDurationSec(buf: ArrayBuffer): number {
  const v = new DataView(buf);
  if (buf.byteLength < 44 || v.getUint32(0, false) !== 0x52494646) return 0; // "RIFF"
  let off = 12;
  let byteRate = 0;
  while (off + 8 <= buf.byteLength) {
    const id = v.getUint32(off, false);
    const size = v.getUint32(off + 4, true);
    if (id === 0x666d7420) byteRate = v.getUint32(off + 16, true); // "fmt "
    if (id === 0x64617461) return byteRate ? size / byteRate : 0; // "data"
    off += 8 + size + (size % 2);
  }
  return 0;
}
