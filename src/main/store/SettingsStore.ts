// settings.json (spec 6.2), secrets.bin (spec 7.1), characters/<id>/character.json (spec 6.3).
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { DEFAULT_CHARACTER, DEFAULT_SETTINGS, SETTINGS_VERSION } from '@shared/defaults';
import type { DeepPartial } from '@shared/ipc';
import type { CharacterPreset, Settings } from '@shared/types';

export function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === undefined) return base;
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return (patch as T) ?? base;
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === undefined) continue;
    const cur = out[k];
    out[k] = cur !== null && typeof cur === 'object' && !Array.isArray(cur) ? deepMerge(cur, v) : v;
  }
  return out as T;
}

/**
 * 古い settings.json を今の形に直す（読み込み時に1回）。
 * v1→v2: 自動起動を既定でONにした。v1 では既定OFFの値がそのまま保存されているので、一度だけONにする。
 */
export function migrateSettings(raw: Record<string, unknown>): Record<string, unknown> {
  const out = { ...raw };
  const v = typeof out.settingsVersion === 'number' ? out.settingsVersion : 1;
  if (v < 2) out.autoLaunch = true;
  out.settingsVersion = SETTINGS_VERSION;
  return out;
}

function writeAtomic(file: string, data: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export class SettingsStore extends EventEmitter {
  private value: Settings;

  constructor(private readonly file: string) {
    super();
    this.value = this.load();
  }

  private load(): Settings {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, unknown>;
      const migrated = migrateSettings(raw);
      const value = deepMerge(DEFAULT_SETTINGS, migrated);
      if (raw.settingsVersion !== migrated.settingsVersion) {
        try {
          writeAtomic(this.file, JSON.stringify(value, null, 2));
        } catch {
          /* 次の保存で書かれる */
        }
      }
      return value;
    } catch {
      return structuredClone(DEFAULT_SETTINGS);
    }
  }

  get(): Settings {
    return this.value;
  }

  set(patch: DeepPartial<Settings>): Settings {
    const prev = this.value;
    this.value = deepMerge(this.value, patch);
    writeAtomic(this.file, JSON.stringify(this.value, null, 2));
    this.emit('change', this.value, prev);
    return this.value;
  }
}

export interface Encryptor {
  isAvailable(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(data: Buffer): string;
}

export class Secrets {
  constructor(
    private readonly file: string,
    private readonly enc: Encryptor,
  ) {}

  private blob: { anthropicApiKey?: string; calendarUrl?: string } | undefined;

  private read(): { anthropicApiKey?: string; calendarUrl?: string } {
    if (this.blob) return this.blob;
    try {
      const data = JSON.parse(this.enc.decrypt(fs.readFileSync(this.file)));
      this.blob = {
        anthropicApiKey: typeof data.anthropicApiKey === 'string' ? data.anthropicApiKey : undefined,
        calendarUrl: typeof data.calendarUrl === 'string' ? data.calendarUrl : undefined,
      };
    } catch {
      this.blob = {};
    }
    return this.blob;
  }

  private write(next: { anthropicApiKey?: string; calendarUrl?: string }): void {
    if (!this.enc.isAvailable()) throw new Error('OSの暗号化機能が使えないため、保存できません');
    writeAtomic(this.file, this.enc.encrypt(JSON.stringify(next)));
    this.blob = next;
  }

  getApiKey(): string | null {
    if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
    return this.read().anthropicApiKey || null;
  }

  setApiKey(key: string): void {
    this.write({ ...this.read(), anthropicApiKey: key.trim() || undefined });
  }

  /** Googleカレンダーの非公開iCal URL。URL自体が合い言葉なので、APIキーと同じくmainだけが持つ。 */
  getCalendarUrl(): string | null {
    return this.read().calendarUrl || null;
  }

  setCalendarUrl(url: string): void {
    this.write({ ...this.read(), calendarUrl: url.trim() || undefined });
  }

  calendarStatus(): { hasUrl: boolean; masked: string } {
    const u = this.getCalendarUrl();
    return { hasUrl: !!u, masked: u ? 'calendar.google.com/…' + u.slice(-8) : '' };
  }

  status(): { hasKey: boolean; masked: string } {
    const k = this.getApiKey();
    return { hasKey: !!k, masked: maskKey(k) };
  }
}

export function maskKey(k: string | null | undefined): string {
  if (!k) return '';
  return k.length <= 12 ? '****' : `${k.slice(0, 7)}…${k.slice(-4)}`;
}

export class CharacterStore {
  constructor(private readonly dir: string) {}

  folder(id: string): string {
    if (!/^[\w-]+$/.test(id)) throw new Error('invalid character id');
    return path.join(this.dir, id);
  }

  list(): { id: string; name: string }[] {
    const out: { id: string; name: string }[] = [];
    for (const e of fs.readdirSync(this.dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      try {
        const p = this.load(e.name);
        out.push({ id: p.id, name: p.name });
      } catch {
        /* skip broken presets */
      }
    }
    return out;
  }

  ensureDefault(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const f = path.join(this.folder('default'), 'character.json');
    if (!fs.existsSync(f)) this.save(DEFAULT_CHARACTER);
  }

  load(id: string): CharacterPreset {
    const raw = JSON.parse(fs.readFileSync(path.join(this.folder(id), 'character.json'), 'utf8'));
    const merged = deepMerge(DEFAULT_CHARACTER, raw);
    merged.id = id;
    return merged;
  }

  save(p: CharacterPreset): void {
    const folder = this.folder(p.id);
    fs.mkdirSync(path.join(folder, 'model'), { recursive: true });
    fs.mkdirSync(path.join(folder, 'motions'), { recursive: true });
    writeAtomic(path.join(folder, 'character.json'), JSON.stringify(p, null, 2));
  }

  create(name: string): CharacterPreset {
    let id = name.toLowerCase().replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '') || 'character';
    let n = 1;
    while (fs.existsSync(this.folder(id))) id = `${id.replace(/-\d+$/, '')}-${++n}`;
    const p: CharacterPreset = { ...structuredClone(DEFAULT_CHARACTER), id, name };
    this.save(p);
    return p;
  }

  /** Absolute path of the PMX (relative paths resolve against the character folder). null if unset. */
  modelPath(p: CharacterPreset): string | null {
    if (!p.model) return null;
    return path.isAbsolute(p.model) ? p.model : path.join(this.folder(p.id), p.model);
  }

  motionPath(p: CharacterPreset, file: string): string {
    return path.isAbsolute(file) ? file : path.join(this.folder(p.id), 'motions', file);
  }
}
