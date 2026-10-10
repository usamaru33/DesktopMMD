// App log (spec 7.4): state transitions, timings, errors. Never conversation text or API keys.
import fs from 'node:fs';
import path from 'node:path';

type Level = 'debug' | 'info' | 'warn' | 'error';

let logFile: string | null = null;
let stream: fs.WriteStream | null = null;

const KEY_RE = /sk-ant-[A-Za-z0-9_-]{8,}/g;

export function redact(s: string): string {
  return s.replace(KEY_RE, (k) => `${k.slice(0, 7)}…${k.slice(-4)}`);
}

export function initLogger(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  rotate(dir, 7);
  const day = new Date().toISOString().slice(0, 10);
  logFile = path.join(dir, `main-${day}.log`);
  stream = fs.createWriteStream(logFile, { flags: 'a' });
}

function rotate(dir: string, days: number): void {
  const cutoff = Date.now() - days * 86_400_000;
  for (const f of fs.readdirSync(dir)) {
    const m = /^main-(\d{4}-\d{2}-\d{2})\.log$/.exec(f);
    if (m && Date.parse(m[1]) < cutoff) fs.rmSync(path.join(dir, f), { force: true });
  }
}

function write(level: Level, scope: string, msg: string, extra?: unknown): void {
  let line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  if (extra !== undefined) {
    const e = extra instanceof Error ? `${extra.name}: ${extra.message}` : safe(extra);
    line += ` ${e}`;
  }
  line = redact(line);
  if (level !== 'debug' || process.env.MMD_DEBUG) {
    (level === 'error' ? console.error : console.log)(line);
  }
  stream?.write(line + '\n');
}

function safe(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function getLogger(scope: string) {
  return {
    debug: (m: string, x?: unknown) => write('debug', scope, m, x),
    info: (m: string, x?: unknown) => write('info', scope, m, x),
    warn: (m: string, x?: unknown) => write('warn', scope, m, x),
    error: (m: string, x?: unknown) => write('error', scope, m, x),
  };
}

export type Logger = ReturnType<typeof getLogger>;
