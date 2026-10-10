// User dictionary kept in two places: the VOICEVOX engine and our own copy in SQLite (spec 5.6, 6.5).
// Startup sync re-registers words the engine has lost (TC-17).
import type { DictWordInput } from '@shared/ipc';
import type { VoiceDictWord } from '@shared/types';
import type { Store } from '../store/repos';
import type { Logger } from '../util/logger';
import type { DictEntry } from './ttsNormalize';
import type { VoicevoxClient } from './VoicevoxClient';

const KATAKANA = /^[゠-ヿー]+$/;

export function validateWord(w: DictWordInput): string | null {
  if (!w.surface.trim()) return '表記を入力してください';
  const p = w.pronunciation.trim();
  if (!p || !KATAKANA.test(p)) return '読みはカタカナで入力してください';
  const moras = countMoras(p);
  if (!Number.isInteger(w.accentType) || w.accentType < 0 || w.accentType > moras) return `アクセント型は0〜${moras}の整数です`;
  if (!Number.isInteger(w.priority) || w.priority < 0 || w.priority > 10) return '優先度は0〜10です';
  return null;
}

/** Small kana (ャュョァィゥェォ) attach to the previous mora; ー, ッ, ン count as moras. */
export function countMoras(kana: string): number {
  return [...kana].filter((c) => !'ャュョァィゥェォヮ'.includes(c)).length;
}

export class VoiceDictService {
  constructor(
    private readonly store: Store,
    private readonly vv: () => VoicevoxClient,
    private readonly log: Logger,
  ) {}

  list(): VoiceDictWord[] {
    return this.store.voiceDict.list();
  }

  /** ASCII words for text normalization before synthesis. */
  entries(): DictEntry[] {
    return this.store.voiceDict.list().map((w) => ({ surface: w.surface, pronunciation: w.pronunciation }));
  }

  /** Words used as a Whisper prompt to bias recognition. */
  vocab(): string[] {
    return this.store.voiceDict.list().map((w) => w.surface);
  }

  async add(w: DictWordInput): Promise<{ ok: boolean; error?: string; word?: VoiceDictWord }> {
    const err = validateWord(w);
    if (err) return { ok: false, error: err };
    let uuid: string | null = null;
    try {
      uuid = await this.vv().addWord(w);
    } catch (e) {
      this.log.warn('dict add on engine failed (kept locally, will sync on start)', e);
    }
    const word = this.store.voiceDict.insert({ ...w, surface: w.surface.trim(), pronunciation: w.pronunciation.trim(), engineUuid: uuid });
    return { ok: true, word };
  }

  async update(id: number, w: DictWordInput): Promise<{ ok: boolean; error?: string }> {
    const err = validateWord(w);
    if (err) return { ok: false, error: err };
    const cur = this.store.voiceDict.get(id);
    if (!cur) return { ok: false, error: '見つかりません' };
    let uuid = cur.engineUuid;
    try {
      if (uuid) await this.vv().updateWord(uuid, w);
      else uuid = await this.vv().addWord(w);
    } catch (e) {
      this.log.warn('dict update on engine failed', e);
      uuid = null;
    }
    this.store.voiceDict.update(id, { ...w, engineUuid: uuid });
    return { ok: true };
  }

  async delete(id: number): Promise<{ ok: boolean; error?: string }> {
    const cur = this.store.voiceDict.get(id);
    if (!cur) return { ok: true };
    if (cur.engineUuid) {
      try {
        await this.vv().deleteWord(cur.engineUuid);
      } catch (e) {
        this.log.warn('dict delete on engine failed', e);
      }
    }
    this.store.voiceDict.delete(id);
    return { ok: true };
  }

  /** Re-register any word the engine doesn't have (matched by surface + pronunciation). */
  async sync(): Promise<number> {
    let engine: Awaited<ReturnType<VoicevoxClient['userDict']>>;
    try {
      engine = await this.vv().userDict();
    } catch {
      return 0;
    }
    const byUuid = new Map(Object.entries(engine));
    const bySig = new Map(Object.entries(engine).map(([u, w]) => [`${w.surface}\u0000${w.pronunciation}`, u]));
    let fixed = 0;
    for (const w of this.store.voiceDict.list()) {
      // the engine stores surfaces in full-width; compare loosely
      const sigUuid = bySig.get(`${toFullWidth(w.surface)}\u0000${w.pronunciation}`) ?? bySig.get(`${w.surface}\u0000${w.pronunciation}`);
      if (w.engineUuid && byUuid.has(w.engineUuid)) continue;
      if (sigUuid) {
        this.store.voiceDict.setUuid(w.id, sigUuid);
        continue;
      }
      try {
        const uuid = await this.vv().addWord(w);
        this.store.voiceDict.setUuid(w.id, uuid);
        fixed++;
      } catch (e) {
        this.log.warn(`dict re-register failed: ${w.surface}`, e);
      }
    }
    if (fixed) this.log.info(`re-registered ${fixed} dictionary words on VOICEVOX`);
    return fixed;
  }
}

function toFullWidth(s: string): string {
  return s.replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0));
}
