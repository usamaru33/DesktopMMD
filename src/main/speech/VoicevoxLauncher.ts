// アプリ起動時に読み上げエンジン（VOICEVOX の vv-engine/run.exe、AivisSpeech の AivisSpeech-Engine/run.exe）を起動する。
// 自分で起動したものだけ終了時に止める。
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { type EngineKind, engineKindFromUrl, ENGINE_PRESETS } from '@shared/voiceEngine';
import type { Logger } from '../util/logger';

export type LaunchResult = 'already' | 'started' | 'remote' | 'not_found' | 'timeout' | 'failed';

/** エンジンURLがこのPCを指しているときだけ起動できる。ポートも返す */
export function localEndpoint(engineUrl: string): { host: string; port: number } | null {
  try {
    const u = new URL(engineUrl);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) return null;
    return { host: '127.0.0.1', port: Number(u.port) || 50021 };
  } catch {
    return null;
  }
}

const ENGINE_DIR: Record<EngineKind, { app: string; engine: string }> = {
  voicevox: { app: 'VOICEVOX', engine: 'vv-engine' },
  aivis: { app: 'AivisSpeech', engine: 'AivisSpeech-Engine' },
};

/**
 * run.exe の場所を探す。指定があればそれを優先（run.exe そのもの、アプリのフォルダ、エンジンのフォルダ、VOICEVOX.exe / AivisSpeech.exe のどれでもよい）。
 * 指定がエンジンの種類と合わない（AivisSpeech を使うのに VOICEVOX の場所が入っている等）ときと、見つからないときは既定のインストール先を見る。
 */
export function findEngineExe(
  custom: string,
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = fs.existsSync,
  kind: EngineKind = 'voicevox',
): string | null {
  const out: string[] = [];
  const dir = ENGINE_DIR[kind];
  const c = custom.trim().replace(/^"|"$/g, '');
  if (c && /aivis/i.test(c) === (kind === 'aivis')) {
    if (/\.exe$/i.test(c)) {
      if (/run\.exe$/i.test(c)) out.push(c);
      else out.push(path.join(path.dirname(c), dir.engine, 'run.exe'), path.join(path.dirname(c), 'run.exe'));
    } else {
      out.push(path.join(c, dir.engine, 'run.exe'), path.join(c, 'run.exe'));
    }
  }
  for (const base of [env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', dir.app), env.ProgramFiles && path.join(env.ProgramFiles, dir.app)]) {
    if (base) out.push(path.join(base, dir.engine, 'run.exe'), path.join(base, 'run.exe'));
  }
  return out.find((p) => exists(p)) ?? null;
}

/** そのポートで何かが待ち受けているか（起動途中のエンジンは /version にまだ答えないことがある） */
export function portInUse(port: number, host = '127.0.0.1', timeoutMs = 700): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (v: boolean) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

export interface LauncherDeps {
  /** 応答があれば true（/version） */
  ping(): Promise<boolean>;
  log: Logger;
  spawnImpl?: typeof spawn;
  /** テスト用 */
  exists?: (p: string) => boolean;
  portInUse?: (port: number) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
}

export class VoicevoxLauncher {
  private proc: ChildProcess | null = null;
  private starting: Promise<LaunchResult> | null = null;

  constructor(private readonly d: LauncherDeps) {}

  /** このアプリが起動したエンジンが動いているか */
  get ownsEngine(): boolean {
    return !!this.proc && this.proc.exitCode === null && !this.proc.killed;
  }

  ensureRunning(engineUrl: string, customPath: string, timeoutMs = 90_000): Promise<LaunchResult> {
    this.starting ??= this.run(engineUrl, customPath, timeoutMs).finally(() => (this.starting = null));
    return this.starting;
  }

  private async run(engineUrl: string, customPath: string, timeoutMs: number): Promise<LaunchResult> {
    if (await this.d.ping()) return 'already';
    const ep = localEndpoint(engineUrl);
    if (!ep) return 'remote';
    const sleep = this.d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const deadline = Date.now() + timeoutMs;
    if (await (this.d.portInUse ?? portInUse)(ep.port)) {
      // VOICEVOX エディタなどが起動中。二重に起動するとポートが取れずに落ちるので、応答を待つだけにする
      this.d.log.info(`port ${ep.port} is in use; waiting for the engine that is starting`);
      while (Date.now() < deadline) {
        await sleep(500);
        if (await this.d.ping()) return 'already';
      }
      return 'timeout';
    }
    const kind = engineKindFromUrl(engineUrl);
    const exe = findEngineExe(customPath, process.env, this.d.exists, kind);
    if (!exe) {
      this.d.log.warn(`${ENGINE_PRESETS[kind].label} engine (run.exe) not found`);
      return 'not_found';
    }
    this.d.log.info(`starting ${ENGINE_PRESETS[kind].label} engine: ${exe} :${ep.port}`);
    try {
      const p = (this.d.spawnImpl ?? spawn)(exe, ['--host', ep.host, '--port', String(ep.port)], {
        cwd: path.dirname(exe),
        windowsHide: true,
        stdio: 'ignore',
      });
      this.proc = p;
      p.on('error', (e) => this.d.log.warn('VOICEVOX spawn error', e));
      p.on('exit', (code) => {
        this.d.log.info(`VOICEVOX engine exited (${code})`);
        if (this.proc === p) this.proc = null;
      });
    } catch (e) {
      this.d.log.warn('VOICEVOX spawn failed', e);
      return 'failed';
    }
    while (Date.now() < deadline) {
      await sleep(500);
      if (await this.d.ping()) return this.ownsEngine ? 'started' : 'already';
      if (!this.proc) return 'failed'; // すぐ落ちた（ポートが使用中など）
    }
    return 'timeout';
  }

  /** 自分で起動したエンジンだけ止める（エディタなど他から起動されたものには触らない） */
  stop(): void {
    const p = this.proc;
    this.proc = null;
    if (!p?.pid || p.exitCode !== null) return;
    this.d.log.info('stopping VOICEVOX engine');
    // run.exe が子プロセスを持つ版があるので、プロセスツリーごと止める
    // 終了処理の途中で呼ばれるので同期で待つ（非同期だとアプリが先に終わって残ることがある）
    try {
      execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
    } catch {
      p.kill();
    }
  }
}
