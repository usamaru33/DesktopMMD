// 攻撃を想定したテスト（SQLインジェクション、パス回避、URLスキーム）。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Db } from '../../src/main/store/Db';
import { Store } from '../../src/main/store/repos';
import { PathGuard } from '../../src/main/tools/pathGuard';
import { createSystemTools } from '../../src/main/tools/builtin/systemTools';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';

const SQLI = [
  "' OR '1'='1",
  "'; DROP TABLE messages; --",
  "x' UNION SELECT * FROM sessions --",
  '" OR ""="',
  '%',
  '_',
  '\\',
  "a' ESCAPE '\\' --",
  'NEAR(a b) OR *',
  '"unterminated',
];

describe('SQL injection', () => {
  let store: Store;
  beforeEach(() => {
    const db = new Db(':memory:');
    db.migrate();
    store = new Store(db);
  });

  it('search and list treat input as data, never as SQL', () => {
    const s = store.conv.createSession();
    store.conv.addMessage({ sessionId: s.id, role: 'user', source: 'text', content: 'こんにちは、普通のメッセージです' });
    for (const q of SQLI) {
      const hits = store.conv.search(q);
      // wildcard-looking input must not match unrelated rows
      expect(hits.every((h) => h.message.content.includes(q)), q).toBe(true);
      expect(() => store.memories.list({ query: q })).not.toThrow();
      expect(store.memories.list({ query: q })).toEqual([]);
    }
    // tables are intact
    expect(store.conv.search('普通のメッセージ')).toHaveLength(1);
  });

  it('stores hostile content verbatim', () => {
    const s = store.conv.createSession();
    for (const q of SQLI) store.conv.addMessage({ sessionId: s.id, role: 'user', source: 'text', content: q });
    const m = store.memories.insert({ kind: 'profile', content: SQLI[1], importance: 0.5, embedding: null });
    expect(store.memories.get(m.id)?.content).toBe(SQLI[1]);
    expect(store.memories.list({ query: 'DROP TABLE' })).toHaveLength(1);
  });
});

describe('path attacks (real filesystem)', () => {
  let base: string;
  let allowed: string;
  let secret: string;
  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'mmd-sec-'));
    allowed = path.join(base, 'allowed');
    secret = path.join(base, 'secret');
    fs.mkdirSync(allowed);
    fs.mkdirSync(secret);
    fs.writeFileSync(path.join(secret, 'key.txt'), 'top secret');
  });
  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  const guard = () => new PathGuard({ allowedDirs: [allowed], denyDirs: [] });

  it.each([
    ['dot-dot with backslash', () => `${allowed}\\..\\secret\\key.txt`],
    ['dot-dot with forward slash', () => `${allowed}/../secret/key.txt`],
    ['mixed separators', () => `${allowed}\\.\\..\\/secret/key.txt`],
    ['extended-length prefix', () => `\\\\?\\${secret}\\key.txt`],
    ['device namespace', () => `\\\\.\\${secret}\\key.txt`],
    ['UNC admin share', () => `\\\\localhost\\${secret.replace(':', '$')}\\key.txt`],
    ['alternate data stream', () => `${allowed}\\a.txt:hidden`],
    ['wildcard', () => `${allowed}\\*`],
    ['control character', () => `${allowed}\\a\u0000.txt`],
    ['quoted traversal', () => `"${allowed}\\..\\secret\\key.txt"`],
  ])('rejects %s', (_name, make) => {
    expect(guard().check(make()).ok).toBe(false);
  });

  it('rejects a junction pointing outside the allowed folder', () => {
    const link = path.join(allowed, 'jn');
    try {
      fs.symlinkSync(secret, link, 'junction');
    } catch {
      return; // cannot create junctions in this environment
    }
    expect(guard().check(path.join(link, 'key.txt')).ok).toBe(false);
    expect(guard().check(path.join(link, 'new.txt')).ok).toBe(false);
  });

  it('does not let a trailing dot or space reach a sibling folder', () => {
    expect(guard().check(`${allowed}. \\..\\secret\\key.txt`).ok).toBe(false);
  });
});

describe('open_url / open_path', () => {
  const tools = createSystemTools({
    settings: () => DEFAULT_SETTINGS,
    openExternal: async () => {},
    openPath: async () => '',
    readClipboard: () => '',
    writeClipboard: () => {},
    screenshot: async () => null,
    defaultCwd: () => os.tmpdir(),
  });
  const openUrl = tools.find((t) => t.name === 'open_url')!;
  const openPath = tools.find((t) => t.name === 'open_path')!;

  it.each([
    'javascript:alert(1)',
    'file:///C:/Windows/System32/calc.exe',
    'data:text/html,<script>alert(1)</script>',
    'ftp://example.com/a',
    'ms-msdt:/id PCWDiagnostic',
    'vbscript:msgbox(1)',
    'C:\\Windows\\System32\\cmd.exe',
    '\\\\evil\\share\\a.exe',
    '//evil.example/a',
    'view-source:https://example.com',
    '',
  ])('open_url refuses %j', (u) => {
    expect(openUrl.inputSchema.safeParse({ url: u }).success).toBe(false);
  });

  it('open_url accepts http(s)', () => {
    expect(openUrl.inputSchema.safeParse({ url: 'https://example.com/a?b=c' }).success).toBe(true);
  });

  it.each(['a.exe', 'a.BAT', 'a.cmd', 'a.ps1', 'a.lnk', 'a.msi', 'a.hta', 'a.js', 'a.vbs', 'a.scr', 'a.jar', 'a.com'])('open_path refuses %s', (p) => {
    expect(openPath.inputSchema.safeParse({ path: `C:\\x\\${p}` }).success).toBe(false);
  });
});
