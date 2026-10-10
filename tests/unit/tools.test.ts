import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAssistantTools } from '../../src/main/tools/builtin/assistantTools';
import { createSystemTools, runPowerShell } from '../../src/main/tools/builtin/systemTools';
import { decodeText, readDocument } from '../../src/main/tools/builtin/fileTools';
import { applyUndo, cleanupBackups } from '../../src/main/tools/undo';
import { PathGuard } from '../../src/main/tools/pathGuard';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import type { ToolContext, ToolDef } from '../../src/main/tools/types';

const ctx = (): ToolContext => ({
  turnId: 1, toolRunId: 1, signal: new AbortController().signal,
  guard: new PathGuard({ allowedDirs: [os.tmpdir()], denyDirs: [] }), backupDir: os.tmpdir(),
  now: () => new Date('2026-10-07T12:00:00+09:00'),
});

function byName(list: ToolDef[], n: string): ToolDef {
  return list.find((t) => t.name === n)!;
}

describe('assistant tools', () => {
  const timers = { add: vi.fn(() => ({ ok: true as const, id: 7 })), list: vi.fn(() => [{ id: 7, kind: 'timer', label: 'x', fireAt: '2026-10-07T03:03:00.000Z' }]), cancel: vi.fn(() => true) };
  const memory = { save: vi.fn(async () => '覚えました'), forget: vi.fn(async () => '忘れました') };
  const tools = createAssistantTools(timers, memory);

  it('set_timer schedules relative to now', async () => {
    const r = await byName(tools, 'set_timer').run({ seconds: 180, label: 'カップ麺' }, ctx());
    expect(r.ok).toBe(true);
    const at = (timers.add.mock.calls[0] as unknown as [string, string, Date])[2];
    expect(at.toISOString()).toBe('2026-10-07T03:03:00.000Z');
  });

  it('set_reminder rejects past times and validates the date', async () => {
    const t = byName(tools, 'set_reminder');
    expect((await t.run({ at: '2026-10-07T11:00:00+09:00', label: 'x' }, ctx())).ok).toBe(false);
    expect((await t.run({ at: '2026-10-08T10:00:00+09:00', label: '歯医者' }, ctx())).ok).toBe(true);
    expect(t.inputSchema.safeParse({ at: 'あした', label: 'x' }).success).toBe(false);
  });

  it('list / cancel timers', async () => {
    expect(String((await byName(tools, 'list_timers').run({}, ctx())).content)).toContain('#7');
    expect((await byName(tools, 'cancel_timer').run({ id: 7 }, ctx())).ok).toBe(true);
  });

  it('memory_save converts due_at and passes replaces_query; memory_forget', async () => {
    await byName(tools, 'memory_save').run({ content: '10/20に面接', kind: 'schedule', due_at: '2026-10-20T10:00:00+09:00', replaces_query: '面接' }, ctx());
    expect(memory.save).toHaveBeenCalledWith({ kind: 'schedule', content: '10/20に面接', importance: 0.7, dueAt: '2026-10-20T01:00:00.000Z', replacesQuery: '面接' });
    expect((await byName(tools, 'memory_forget').run({ query: 'コーヒー' }, ctx())).content).toBe('忘れました');
  });
});

describe('system tools', () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.tools.apps = [{ name: 'メモ帳', path: 'C:\\Windows\\notepad.exe' }];
  const opened: string[] = [];
  const deps = {
    settings: () => settings,
    openExternal: vi.fn(async (u: string) => void opened.push(u)),
    openPath: vi.fn(async (p: string) => (opened.push(p), '')),
    readClipboard: async () => '秘密のメモ',
    writeClipboard: vi.fn(),
    screenshot: async () => Buffer.from([0x89, 0x50]),
    defaultCwd: () => os.tmpdir(),
  };
  const tools = createSystemTools(deps);

  it('open_url only accepts http(s)', () => {
    const s = byName(tools, 'open_url').inputSchema;
    expect(s.safeParse({ url: 'https://example.com' }).success).toBe(true);
    expect(s.safeParse({ url: 'file:///C:/Windows' }).success).toBe(false);
    expect(s.safeParse({ url: 'javascript:alert(1)' }).success).toBe(false);
  });

  it('open_app only launches registered apps', async () => {
    const t = byName(tools, 'open_app');
    expect((await t.run({ name: 'メモ帳' }, ctx())).ok).toBe(true);
    const r = await t.run({ name: 'calc' }, ctx());
    expect(r.ok).toBe(false);
    expect(String(r.content)).toContain('登録されていません');
  });

  it('open_path refuses executables', () => {
    const s = byName(tools, 'open_path').inputSchema;
    expect(s.safeParse({ path: 'C:\\x\\evil.exe' }).success).toBe(false);
    expect(s.safeParse({ path: 'C:\\x\\report.pdf' }).success).toBe(true);
  });

  it('clipboard content is wrapped as external data; screenshot returns an image block', async () => {
    expect(String((await byName(tools, 'clipboard_read').run({}, ctx())).content)).toContain('<external_data source="clipboard">');
    const shot = await byName(tools, 'take_screenshot').run({}, ctx());
    expect(Array.isArray(shot.content) && shot.content[1].type).toBe('image');
  });

  it('run_command is disabled by default and runs PowerShell when enabled', async () => {
    const t = byName(tools, 'run_command');
    expect(t.enabled!()).toBe(false);
    settings.tools.runCommandEnabled = true;
    expect(t.enabled!()).toBe(true);
    const r = await runPowerShell('Write-Output "こんにちは"', os.tmpdir(), 20_000);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('こんにちは');
  }, 30_000);

  it('get_datetime', async () => {
    expect(String((await byName(tools, 'get_datetime').run({}, ctx())).content)).toContain('2026');
  });
});

describe('file helpers', () => {
  it('decodes UTF-8, UTF-16LE and Shift_JIS text', () => {
    expect(decodeText(Buffer.from('こんにちは', 'utf8'))).toBe('こんにちは');
    expect(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('テスト', 'utf16le')]))).toBe('テスト');
    const sjis = Buffer.from([0x82, 0xb1, 0x82, 0xf1, 0x82, 0xc9, 0x82, 0xbf, 0x82, 0xcd]); // こんにちは
    expect(decodeText(sjis)).toBe('こんにちは');
  });

  it('reads a PDF', async () => {
    // minimal one-page PDF with the text "Hello PDF"
    const pdf = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 44>>stream
BT /F1 18 Tf 20 40 Td (Hello PDF) Tj ET
endstream endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
%%EOF`;
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mmd-pdf-')), 'a.pdf');
    fs.writeFileSync(f, pdf);
    expect(await readDocument(f)).toContain('Hello PDF');
  }, 30_000);
});

describe('undo edge cases', () => {
  it('refuses to restore outside the allowed folders and reports missing backups', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mmd-undo-'));
    const guard = new PathGuard({ allowedDirs: [path.join(base, 'ok')], denyDirs: [] });
    fs.mkdirSync(path.join(base, 'ok'));
    const trash = async () => {};
    expect((await applyUndo({ kind: 'restore', backup: path.join(base, 'nope'), to: path.join(base, 'ok', 'a.txt') }, { guard, trashItem: trash })).ok).toBe(false);
    expect((await applyUndo({ kind: 'restore', backup: path.join(base, 'nope'), to: path.join(base, 'elsewhere.txt') }, { guard, trashItem: trash })).message).toContain('許可フォルダ外');
    expect((await applyUndo({ kind: 'trash', path: 'x' }, { guard, trashItem: trash })).ok).toBe(false);
    fs.writeFileSync(path.join(base, 'ok', 'b.txt'), 'b');
    fs.writeFileSync(path.join(base, 'ok', 'c.txt'), 'c');
    const r = await applyUndo({ kind: 'moveBack', from: path.join(base, 'ok', 'b.txt'), to: path.join(base, 'ok', 'c.txt') }, { guard, trashItem: trash });
    expect(r.ok).toBe(false);
  });

  it('cleans backup folders older than 30 days', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mmd-bk-'));
    fs.mkdirSync(path.join(base, '2026-08-01'));
    fs.mkdirSync(path.join(base, '2026-10-01'));
    expect(await cleanupBackups(base, new Date('2026-10-07'))).toBe(1);
    expect(fs.existsSync(path.join(base, '2026-10-01'))).toBe(true);
  });
});
