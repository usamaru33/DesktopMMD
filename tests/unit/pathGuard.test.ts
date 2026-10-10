import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PathGuard, type PathFs, isInside } from '../../src/main/tools/pathGuard';

// Fake filesystem: a map of existing paths -> their real path (symlinks map elsewhere).
function fakeFs(entries: Record<string, string>): PathFs {
  const norm = (p: string) => p.toLowerCase();
  const table = new Map(Object.entries(entries).map(([k, v]) => [norm(k), v]));
  return {
    realpath(p) {
      const hit = table.get(norm(p));
      if (!hit) throw new Error('ENOENT ' + p);
      return hit;
    },
    exists: (p) => table.has(norm(p)),
  };
}

const HOME = 'C:\\Users\\me';
const FS = fakeFs({
  'C:\\': 'C:\\',
  'C:\\Users': 'C:\\Users',
  [HOME]: HOME,
  [`${HOME}\\Documents`]: `${HOME}\\Documents`,
  [`${HOME}\\Documents2`]: `${HOME}\\Documents2`,
  [`${HOME}\\Documents\\a.txt`]: `${HOME}\\Documents\\a.txt`,
  // symlink inside Documents pointing at System32
  [`${HOME}\\Documents\\evil`]: 'C:\\Windows\\System32',
  // junction inside Documents pointing at another user folder
  [`${HOME}\\Documents\\link`]: `${HOME}\\Secret`,
  [`${HOME}\\Secret`]: `${HOME}\\Secret`,
  [`${HOME}\\AppData\\Roaming\\mmd-assistant`]: `${HOME}\\AppData\\Roaming\\mmd-assistant`,
  'C:\\Windows': 'C:\\Windows',
  'C:\\Windows\\System32': 'C:\\Windows\\System32',
});

function guard(allowed = ['~\\Documents']) {
  return new PathGuard({
    allowedDirs: allowed,
    denyDirs: ['%APPDATA%\\mmd-assistant'],
    home: HOME,
    env: { APPDATA: `${HOME}\\AppData\\Roaming`, USERPROFILE: HOME },
    fs: FS,
  });
}

describe('PathGuard', () => {
  it('allows files inside an allowed folder (existing or not yet created)', () => {
    expect(guard().check(`${HOME}\\Documents\\a.txt`)).toEqual({ ok: true, real: `${HOME}\\Documents\\a.txt` });
    expect(guard().check('~\\Documents\\new\\b.md')).toEqual({ ok: true, real: `${HOME}\\Documents\\new\\b.md` });
    expect(guard().check('%USERPROFILE%\\Documents\\c.txt').ok).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(guard().check('c:\\users\\ME\\documents\\A.TXT').ok).toBe(true);
  });

  it('rejects sibling folders sharing a prefix (Documents2)', () => {
    expect(guard().check(`${HOME}\\Documents2\\x.txt`)).toMatchObject({ ok: false, reason: 'outside_allowed' });
  });

  it('rejects .. traversal', () => {
    expect(guard().check(`${HOME}\\Documents\\..\\Secret\\x`)).toMatchObject({ ok: false, reason: 'outside_allowed' });
  });

  it('TC-04: rejects system folders even if explicitly allowed', () => {
    expect(guard().check('C:\\Windows\\System32')).toMatchObject({ ok: false, reason: 'system' });
    expect(guard(['C:\\Windows']).check('C:\\Windows\\System32\\drivers')).toMatchObject({ ok: false, reason: 'system' });
  });

  it('TC-05: resolves symlinks/junctions before checking', () => {
    expect(guard().check(`${HOME}\\Documents\\evil\\cmd.exe`)).toMatchObject({ ok: false, reason: 'system' });
    expect(guard().check(`${HOME}\\Documents\\link\\pw.txt`)).toMatchObject({ ok: false, reason: 'outside_allowed' });
  });

  it('rejects UNC, ADS, drive roots and the app data folder', () => {
    expect(guard().check('\\\\server\\share\\x')).toMatchObject({ reason: 'unc' });
    expect(guard().check(`${HOME}\\Documents\\a.txt:secret`)).toMatchObject({ reason: 'ads' });
    expect(guard(['C:\\']).check('C:\\')).toMatchObject({ reason: 'root' });
    expect(guard([HOME]).check('%APPDATA%\\mmd-assistant\\assistant.db')).toMatchObject({ reason: 'app_data' });
    expect(guard().check('')).toMatchObject({ reason: 'empty' });
  });

  it('isInside handles equality and nesting', () => {
    expect(isInside(path.win32, 'C:\\a', 'C:\\a')).toBe(true);
    expect(isInside(path.win32, 'C:\\a', 'C:\\a\\b')).toBe(true);
    expect(isInside(path.win32, 'C:\\a', 'C:\\ab')).toBe(false);
    expect(isInside(path.win32, 'C:\\a', 'D:\\a')).toBe(false);
  });
});

describe('PathGuard with the real filesystem (symlink)', () => {
  it('rejects a real junction that points outside the allowed folder', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mmd-pg-'));
    const allowed = path.join(base, 'allowed');
    const outside = path.join(base, 'outside');
    fs.mkdirSync(allowed);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
    let linked = true;
    try {
      fs.symlinkSync(outside, path.join(allowed, 'jump'), 'junction');
    } catch {
      linked = false;
    }
    const g = new PathGuard({ allowedDirs: [allowed], denyDirs: [] });
    expect(g.check(path.join(allowed, 'ok.txt')).ok).toBe(true);
    if (linked) expect(g.check(path.join(allowed, 'jump', 'secret.txt'))).toMatchObject({ ok: false, reason: 'outside_allowed' });
    fs.rmSync(base, { recursive: true, force: true });
  });
});
