// Thin wrapper over node:sqlite (DatabaseSync). See skill mmd-architecture §5 for why not better-sqlite3.
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { MIGRATIONS } from './migrations';

export type Row = Record<string, unknown>;
type Param = null | number | bigint | string | Uint8Array;

export class Db {
  readonly raw: DatabaseSync;
  private readonly cache = new Map<string, StatementSync>();

  constructor(file: string) {
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  run(sql: string, ...params: Param[]): { changes: number; lastId: number } {
    const r = this.stmt(sql).run(...params);
    return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
  }

  get<T = Row>(sql: string, ...params: Param[]): T | undefined {
    return this.stmt(sql).get(...params) as T | undefined;
  }

  all<T = Row>(sql: string, ...params: Param[]): T[] {
    return this.stmt(sql).all(...params) as T[];
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  tx<T>(fn: () => T): T {
    this.raw.exec('BEGIN');
    try {
      const r = fn();
      this.raw.exec('COMMIT');
      return r;
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    }
  }

  migrate(): number {
    this.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
    const cur = this.get<{ v: number | null }>('SELECT MAX(version) AS v FROM schema_version')?.v ?? 0;
    let applied = 0;
    for (const m of MIGRATIONS) {
      if (m.version <= cur) continue;
      this.tx(() => {
        this.exec(m.sql);
        this.run('INSERT INTO schema_version (version) VALUES (?)', m.version);
      });
      applied++;
    }
    return applied;
  }

  get version(): number {
    return this.get<{ v: number | null }>('SELECT MAX(version) AS v FROM schema_version')?.v ?? 0;
  }

  close(): void {
    this.cache.clear();
    this.raw.close();
  }
}

export function toBlob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
}

export function fromBlob(b: unknown): Float32Array | null {
  if (!(b instanceof Uint8Array) || b.byteLength % 4 !== 0 || b.byteLength === 0) return null;
  const copy = new Uint8Array(b); // align
  return new Float32Array(copy.buffer, 0, copy.byteLength / 4);
}
