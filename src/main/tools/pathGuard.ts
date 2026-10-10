// Path normalization and allowed-folder checks (spec 5.5 判定③, 7.1; skill mmd-tools-permissions §4).
// Pure apart from the injected fs functions, so it can be unit-tested with fakes.
import nodePath from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

export interface PathFs {
  realpath(p: string): string; // throws if missing
  exists(p: string): boolean;
}

export const realFs: PathFs = {
  realpath: (p) => fs.realpathSync.native(p),
  exists: (p) => fs.existsSync(p),
};

export interface PathGuardOptions {
  allowedDirs: string[];
  /** always denied, even if inside an allowed dir (app data, etc.) */
  denyDirs: string[];
  home?: string;
  env?: Record<string, string | undefined>;
  fs?: PathFs;
  path?: typeof nodePath.win32;
}

export type PathCheck =
  | { ok: true; real: string }
  | { ok: false; reason: 'empty' | 'unc' | 'ads' | 'outside_allowed' | 'system' | 'root' | 'app_data' | 'invalid'; real?: string };

const SYSTEM_DIRS = ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData', 'C:\\$Recycle.Bin', 'C:\\System Volume Information'];

export class PathGuard {
  private readonly p: typeof nodePath.win32;
  private readonly fs: PathFs;
  private readonly home: string;
  private readonly env: Record<string, string | undefined>;
  private allowed: string[] = [];
  private deny: string[] = [];
  /** exact files the user dropped onto the character: readable even outside the allowed folders */
  private readableFiles = new Set<string>();

  constructor(opts: PathGuardOptions) {
    this.p = opts.path ?? nodePath.win32;
    this.fs = opts.fs ?? realFs;
    this.home = opts.home ?? os.homedir();
    this.env = opts.env ?? process.env;
    this.setAllowedDirs(opts.allowedDirs, opts.denyDirs);
  }

  setAllowedDirs(allowedDirs: string[], denyDirs: string[] = []): void {
    this.allowed = allowedDirs
      .map((d) => this.tryResolve(d))
      .filter((d): d is string => !!d);
    this.deny = denyDirs.map((d) => this.tryResolve(d) ?? this.expand(d));
  }

  get allowedDirs(): string[] {
    return [...this.allowed];
  }

  /** Expand ~ and %VAR%, then make absolute. Does not touch the filesystem. */
  expand(input: string): string {
    let s = input.trim().replace(/^["']|["']$/g, '');
    if (s === '~' || s.startsWith('~\\') || s.startsWith('~/')) s = this.home + s.slice(1);
    s = s.replace(/%([^%]+)%/g, (m, name: string) => {
      const key = Object.keys(this.env).find((k) => k.toLowerCase() === name.toLowerCase());
      return key ? (this.env[key] ?? m) : m;
    });
    return this.p.resolve(s);
  }

  /** Resolve symlinks/junctions. For a missing path, realpath the nearest existing ancestor. */
  normalize(input: string): string {
    const abs = this.expand(input);
    const rest: string[] = [];
    let cur = abs;
    for (;;) {
      try {
        const real = this.fs.realpath(cur);
        return rest.length ? this.p.join(real, ...rest.reverse()) : real;
      } catch {
        const parent = this.p.dirname(cur);
        if (parent === cur) return abs;
        rest.push(this.p.basename(cur));
        cur = parent;
      }
    }
  }

  /** FR-IN-06: a file the user dropped is an explicit grant to read that one file (never to write/move it). */
  allowReadFiles(paths: string[]): void {
    for (const p of paths) {
      try {
        this.readableFiles.add(this.normalize(p).toLowerCase());
      } catch {
        /* ignore */
      }
    }
  }

  check(input: string, opts: { forRead?: boolean } = {}): PathCheck {
    if (!input || !input.trim()) return { ok: false, reason: 'empty' };
    const raw = input.trim();
    if (raw.startsWith('\\\\') || raw.startsWith('//')) return { ok: false, reason: 'unc' };
    // alternate data streams: a colon anywhere except the drive letter
    const withoutDrive = raw.replace(/^[a-zA-Z]:/, '');
    if (withoutDrive.includes(':')) return { ok: false, reason: 'ads' };
    if (/[<>"|?*\x00-\x1f]/.test(withoutDrive)) return { ok: false, reason: 'invalid' };

    const real = this.normalize(raw);
    if (real.startsWith('\\\\')) return { ok: false, reason: 'unc', real };
    if (this.p.parse(real).root === real || /^[a-zA-Z]:\\?$/.test(real)) return { ok: false, reason: 'root', real };
    for (const d of this.deny) if (isInside(this.p, d, real)) return { ok: false, reason: 'app_data', real };
    for (const d of SYSTEM_DIRS) if (isInside(this.p, d, real)) return { ok: false, reason: 'system', real };
    for (const d of this.allowed) if (isInside(this.p, d, real)) return { ok: true, real };
    if (opts.forRead && this.readableFiles.has(real.toLowerCase())) return { ok: true, real };
    return { ok: false, reason: 'outside_allowed', real };
  }

  private tryResolve(d: string): string | null {
    try {
      return this.normalize(d);
    } catch {
      return null;
    }
  }
}

/** child is dir itself or below it. Case-insensitive (Windows). */
export function isInside(p: typeof nodePath.win32, dir: string, child: string): boolean {
  const rel = p.relative(dir.toLowerCase(), child.toLowerCase());
  return rel === '' || (!rel.startsWith('..') && !p.isAbsolute(rel));
}

export const PATH_REASON_JA: Record<string, string> = {
  empty: 'パスが指定されていません',
  unc: 'ネットワーク上のパスは扱えません',
  ads: 'このパスの形式は扱えません',
  invalid: 'パスに使えない文字が含まれています',
  outside_allowed: '許可されたフォルダの外です',
  system: 'システムフォルダは操作できません',
  root: 'ドライブ直下は操作できません',
  app_data: 'アシスタント自身のデータフォルダは操作できません',
};
