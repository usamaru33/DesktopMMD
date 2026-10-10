// File tools: list/search/read (L0), write/move/rename (L1), delete (L2). Spec 5.5.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { LIMITS } from '@shared/defaults';
import { type ToolDef, type ToolResult, external, truncate } from '../types';

export interface FileToolDeps {
  trashItem(p: string): Promise<void>;
}

const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.log',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.c', '.h', '.cpp', '.hpp',
  '.cs', '.php', '.swift', '.sh', '.ps1', '.bat', '.sql', '.html', '.htm', '.css', '.scss', '.xml', '.svg', '.tex', '.bib', '.r', '.m',
]);
const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', '__pycache__', '.cache', 'dist', 'out', '$RECYCLE.BIN']);

function fmtSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function fmtDate(d: Date): string {
  return d.toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export async function readDocument(p: string): Promise<string> {
  const ext = path.extname(p).toLowerCase();
  if (ext === '.pdf') {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const data = new Uint8Array(await fsp.readFile(p));
    const task = pdfjs.getDocument({ data, useSystemFonts: false });
    const doc = await task.promise;
    const parts: string[] = [];
    const pages = Math.min(doc.numPages, 100);
    for (let i = 1; i <= pages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      parts.push(`--- ${i}ページ ---\n` + tc.items.map((it) => ('str' in it ? it.str : '')).join(''));
    }
    if (doc.numPages > pages) parts.push(`(全${doc.numPages}ページ中、先頭${pages}ページのみ)`);
    await task.destroy();
    return parts.join('\n');
  }
  if (ext === '.docx') {
    const mammoth = await import('mammoth');
    const r = await mammoth.extractRawText({ path: p });
    return r.value;
  }
  const buf = await fsp.readFile(p);
  return decodeText(buf);
}

export function decodeText(buf: Buffer): string {
  // UTF-8 (with/without BOM) first; fall back to Shift_JIS which is common on Japanese Windows.
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  const bad = (utf8.match(/�/g) ?? []).length;
  if (bad > 0 && bad / Math.max(1, utf8.length) > 0.001) {
    try {
      return new TextDecoder('shift_jis').decode(buf);
    } catch {
      return utf8;
    }
  }
  return utf8.replace(/^﻿/, '');
}

async function walk(root: string, visit: (p: string, st: fs.Stats) => boolean | void, maxFiles = 20000, maxDepth = 8): Promise<void> {
  let count = 0;
  const stack: [string, number][] = [[root, 0]];
  while (stack.length) {
    const [dir, depth] = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue; // never follow links while walking
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.') && depth < maxDepth) stack.push([p, depth + 1]);
        continue;
      }
      if (++count > maxFiles) return;
      let st: fs.Stats;
      try {
        st = await fsp.stat(p);
      } catch {
        continue;
      }
      if (visit(p, st) === false) return;
    }
  }
}

function globToRegExp(q: string): RegExp {
  const esc = q.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(q.includes('*') || q.includes('?') ? `^${esc}$` : esc, 'i');
}

export function createFileTools(deps: FileToolDeps): ToolDef[] {
  const listDir: ToolDef<{ path: string }> = {
    name: 'list_dir',
    title: 'フォルダの中を見る',
    description: '許可されたフォルダの中身（ファイル名、サイズ、更新日時）を一覧します。',
    inputSchema: z.object({ path: z.string().describe('フォルダのパス。~ はホームフォルダ') }),
    level: 'L0',
    pathArgs: ['path'],
    readsExternal: true,
    summarize: (i) => ({ targets: [i.path], summary: 'フォルダの一覧を見る' }),
    async run(i) {
      const st = await fsp.stat(i.path).catch(() => null);
      if (!st) return { ok: false, content: `見つかりません: ${i.path}` };
      if (!st.isDirectory()) return { ok: false, content: `フォルダではありません: ${i.path}` };
      const entries = await fsp.readdir(i.path, { withFileTypes: true });
      const lines: string[] = [];
      for (const e of entries.slice(0, 300)) {
        const p = path.join(i.path, e.name);
        const s = await fsp.stat(p).catch(() => null);
        if (!s) continue;
        lines.push(e.isDirectory() ? `[フォルダ] ${e.name}` : `${e.name}  ${fmtSize(s.size)}  ${fmtDate(s.mtime)}`);
      }
      if (entries.length > 300) lines.push(`…ほか${entries.length - 300}件`);
      return { ok: true, content: external(i.path, lines.join('\n') || '(空のフォルダ)'), note: `${path.basename(i.path)} を見ました` };
    },
  };

  const searchFiles: ToolDef<{ dir: string; name?: string; content?: string }> = {
    name: 'search_files',
    title: 'ファイルを探す',
    description:
      '許可フォルダ内をファイル名（部分一致、* ? 可）と内容（テキストファイルのみ）で検索します。name と content の少なくとも一方を指定。',
    inputSchema: z
      .object({
        dir: z.string().describe('検索するフォルダ'),
        name: z.string().optional().describe('ファイル名の一部またはワイルドカード'),
        content: z.string().optional().describe('ファイル内容に含まれる文字列'),
      })
      .refine((v) => !!(v.name || v.content), { message: 'name か content を指定してください' }),
    level: 'L0',
    pathArgs: ['dir'],
    readsExternal: true,
    summarize: (i) => ({ targets: [i.dir], summary: `「${i.name ?? i.content}」を探す` }),
    async run(i, ctx) {
      const nameRe = i.name ? globToRegExp(i.name) : null;
      const needle = i.content?.toLowerCase();
      const hits: string[] = [];
      await walk(i.dir, (p, st) => {
        if (ctx.signal.aborted) return false;
        if (nameRe && !nameRe.test(path.basename(p))) return;
        if (needle) {
          if (!TEXT_EXT.has(path.extname(p).toLowerCase()) || st.size > LIMITS.readFileMaxBytes) return;
          let text: string;
          try {
            text = decodeText(fs.readFileSync(p));
          } catch {
            return;
          }
          const idx = text.toLowerCase().indexOf(needle);
          if (idx < 0) return;
          const line = text.slice(Math.max(0, idx - 30), idx + needle.length + 30).replace(/\s+/g, ' ');
          hits.push(`${p}  …${line}…`);
        } else {
          hits.push(`${p}  ${fmtSize(st.size)}  ${fmtDate(st.mtime)}`);
        }
        if (hits.length >= 200) return false;
      });
      return {
        ok: true,
        content: external(i.dir, hits.length ? hits.join('\n') : '見つかりませんでした。'),
        note: `${hits.length}件見つけました`,
      };
    },
  };

  const readFile: ToolDef<{ path: string }> = {
    name: 'read_file',
    title: 'ファイルを読む',
    description: 'テキスト、PDF、Word(docx)ファイルの内容を読みます（5MBまで）。要約や質問への回答に使います。',
    inputSchema: z.object({ path: z.string() }),
    level: 'L0',
    pathArgs: ['path'],
    readsExternal: true,
    summarize: (i) => ({ targets: [i.path], summary: 'ファイルを読む' }),
    async run(i) {
      const st = await fsp.stat(i.path).catch(() => null);
      if (!st || !st.isFile()) return { ok: false, content: `ファイルが見つかりません: ${i.path}` };
      if (st.size > LIMITS.readFileMaxBytes) return { ok: false, content: `ファイルが大きすぎます（${fmtSize(st.size)}、上限5MB）` };
      const ext = path.extname(i.path).toLowerCase();
      if (!TEXT_EXT.has(ext) && ext !== '.pdf' && ext !== '.docx' && ext !== '') {
        return { ok: false, content: `この形式（${ext}）は読めません。テキスト、PDF、docxに対応しています。` };
      }
      const text = await readDocument(i.path);
      return { ok: true, content: external(i.path, truncate(text, 60_000)), note: `${path.basename(i.path)} を読みました` };
    },
  };

  const writeFile: ToolDef<{ path: string; content: string; mode: 'create' | 'overwrite' | 'append' }> = {
    name: 'write_file',
    title: 'ファイルに書き込む',
    description:
      'テキストファイルを作成・上書き・追記します。mode: create=新規（既存ならエラー）、overwrite=上書き（元は退避され取り消し可）、append=末尾に追記。',
    inputSchema: z.object({
      path: z.string(),
      content: z.string(),
      mode: z.enum(['create', 'overwrite', 'append']).default('create'),
    }),
    level: 'L1',
    pathArgs: ['path'],
    undoable: true,
    summarize: (i) => ({
      targets: [i.path],
      summary: `${i.mode === 'create' ? '新規作成' : i.mode === 'overwrite' ? '上書き' : '追記'}（${i.content.length}文字）: ${i.content.slice(0, 60).replace(/\s+/g, ' ')}${i.content.length > 60 ? '…' : ''}`,
    }),
    async run(i, ctx): Promise<ToolResult> {
      const exists = fs.existsSync(i.path);
      if (i.mode === 'create' && exists) return { ok: false, content: `既に存在します: ${i.path}。上書きなら mode=overwrite を指定してください。` };
      await fsp.mkdir(path.dirname(i.path), { recursive: true });
      if (!exists) {
        await fsp.writeFile(i.path, i.content, 'utf8');
        return { ok: true, content: `作成しました: ${i.path}`, undo: { kind: 'deleteCreated', path: i.path } };
      }
      const backup = await backupFile(i.path, ctx.backupDir, ctx.toolRunId, ctx.now());
      if (i.mode === 'append') await fsp.appendFile(i.path, i.content, 'utf8');
      else await fsp.writeFile(i.path, i.content, 'utf8');
      return {
        ok: true,
        content: `${i.mode === 'append' ? '追記' : '上書き'}しました: ${i.path}（元の内容は退避済み）`,
        undo: { kind: 'restore', backup, to: i.path },
      };
    },
  };

  const moveFile: ToolDef<{ from: string; to: string }> = {
    name: 'move_file',
    title: 'ファイルを移動',
    description: 'ファイルやフォルダを移動します。移動先に同名があればエラー。to がフォルダならその中へ移動します。',
    inputSchema: z.object({ from: z.string(), to: z.string() }),
    level: 'L1',
    pathArgs: ['from', 'to'],
    undoable: true,
    summarize: (i) => ({ targets: [i.from, `→ ${i.to}`], summary: '移動する' }),
    async run(i) {
      if (!fs.existsSync(i.from)) return { ok: false, content: `見つかりません: ${i.from}` };
      let dest = i.to;
      const st = await fsp.stat(dest).catch(() => null);
      if (st?.isDirectory()) dest = path.join(dest, path.basename(i.from));
      else if (st) return { ok: false, content: `移動先に同名のファイルがあります: ${dest}` };
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.rename(i.from, dest);
      return { ok: true, content: `移動しました: ${i.from} → ${dest}`, undo: { kind: 'moveBack', from: dest, to: i.from } };
    },
  };

  const renameFile: ToolDef<{ path: string; newName: string }> = {
    name: 'rename_file',
    title: '名前を変更',
    description: 'ファイルやフォルダの名前を変更します（同じフォルダ内）。',
    inputSchema: z.object({
      path: z.string(),
      newName: z.string().min(1).refine((n) => !/[\\/:*?"<>|]/.test(n) && n !== '.' && n !== '..', 'ファイル名に使えない文字があります'),
    }),
    level: 'L1',
    pathArgs: ['path'],
    undoable: true,
    summarize: (i) => ({ targets: [i.path, `→ ${i.newName}`], summary: '名前を変更する' }),
    async run(i) {
      if (!fs.existsSync(i.path)) return { ok: false, content: `見つかりません: ${i.path}` };
      const dest = path.join(path.dirname(i.path), i.newName);
      if (fs.existsSync(dest)) return { ok: false, content: `同名のファイルがあります: ${dest}` };
      await fsp.rename(i.path, dest);
      return { ok: true, content: `名前を変更しました: ${path.basename(i.path)} → ${i.newName}`, undo: { kind: 'moveBack', from: dest, to: i.path } };
    },
  };

  const deleteFile: ToolDef<{ paths: string[] }> = {
    name: 'delete_file',
    title: 'ファイルを削除（ごみ箱へ）',
    description: 'ファイルやフォルダをごみ箱へ移動します。完全削除はしません。必ずユーザーのクリック承認が必要です。',
    inputSchema: z.object({ paths: z.array(z.string()).min(1).max(100) }),
    level: 'L2',
    pathArgs: ['paths'],
    summarize: (i) => ({ targets: i.paths, summary: `${i.paths.length}件をごみ箱へ移動する` }),
    async run(i) {
      const done: string[] = [];
      const failed: string[] = [];
      for (const p of i.paths) {
        try {
          if (!fs.existsSync(p)) throw new Error('not found');
          await deps.trashItem(p);
          done.push(p);
        } catch (e) {
          failed.push(`${p}（${(e as Error).message}）`);
        }
      }
      return {
        ok: failed.length === 0,
        content: `ごみ箱へ移動: ${done.length}件${failed.length ? `、失敗: ${failed.join(', ')}` : ''}`,
        undo: done.length === 1 ? { kind: 'trash', path: done[0] } : undefined,
      };
    },
  };

  return [listDir, searchFiles, readFile, writeFile, moveFile, renameFile, deleteFile];
}

export async function backupFile(src: string, backupDir: string, runId: number, now: Date): Promise<string> {
  const day = now.toISOString().slice(0, 10);
  const dir = path.join(backupDir, day);
  await fsp.mkdir(dir, { recursive: true });
  const dest = path.join(dir, `${runId}_${path.basename(src)}`);
  await fsp.copyFile(src, dest);
  return dest;
}
