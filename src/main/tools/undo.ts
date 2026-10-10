// Undo for tool runs (FR-TL-10, skill mmd-tools-permissions §6).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { PathGuard } from './pathGuard';
import type { UndoInfo } from './types';

export interface UndoDeps {
  guard: PathGuard;
  trashItem(p: string): Promise<void>;
}

export async function applyUndo(info: UndoInfo, deps: UndoDeps): Promise<{ ok: boolean; message: string }> {
  const ensure = (p: string) => {
    const c = deps.guard.check(p);
    if (!c.ok) throw new Error(`許可フォルダ外のため戻せません: ${p}`);
    return c.real;
  };
  try {
    switch (info.kind) {
      case 'restore': {
        const to = ensure(info.to);
        if (!fs.existsSync(info.backup)) return { ok: false, message: '退避したファイルが見つかりません（30日を過ぎると消えます）' };
        await fsp.mkdir(path.dirname(to), { recursive: true });
        await fsp.copyFile(info.backup, to);
        return { ok: true, message: `元に戻しました: ${to}` };
      }
      case 'deleteCreated': {
        const p = ensure(info.path);
        if (!fs.existsSync(p)) return { ok: true, message: '既にありません' };
        await deps.trashItem(p);
        return { ok: true, message: `作成したファイルをごみ箱へ移しました: ${p}` };
      }
      case 'moveBack': {
        const from = ensure(info.from);
        const to = ensure(info.to);
        if (!fs.existsSync(from)) return { ok: false, message: `移動後のファイルが見つかりません: ${from}` };
        if (fs.existsSync(to)) return { ok: false, message: `元の場所に同名のファイルがあります: ${to}` };
        await fsp.mkdir(path.dirname(to), { recursive: true });
        await fsp.rename(from, to);
        return { ok: true, message: `元の場所に戻しました: ${to}` };
      }
      case 'trash':
        return { ok: false, message: `ごみ箱から「元に戻す」で復元してください: ${info.path}` };
    }
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

/** Delete backup folders older than `days` (spec 6.1 backups: 30日保持). */
export async function cleanupBackups(backupDir: string, now: Date, days = 30): Promise<number> {
  let removed = 0;
  const entries = await fsp.readdir(backupDir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!e.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(e.name)) continue;
    const age = (now.getTime() - Date.parse(e.name)) / 86_400_000;
    if (age > days) {
      await fsp.rm(path.join(backupDir, e.name), { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}
