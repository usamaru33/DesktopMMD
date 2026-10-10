import { EventEmitter } from 'node:events';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false } }));

import { migrateSettings } from '../../src/main/store/SettingsStore';
import { findEngineExe, localEndpoint, VoicevoxLauncher } from '../../src/main/speech/VoicevoxLauncher';
import { AUTOSTART_ARG, launchedAtLogin } from '../../src/main/system/autoLaunch';
import { SETTINGS_VERSION } from '../../src/shared/defaults';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

describe('settings migration', () => {
  it('v1 files get auto launch turned on once', () => {
    expect(migrateSettings({ autoLaunch: false })).toMatchObject({ autoLaunch: true, settingsVersion: SETTINGS_VERSION });
  });
  it('later choices are kept', () => {
    expect(migrateSettings({ autoLaunch: false, settingsVersion: 2 }).autoLaunch).toBe(false);
  });
});

describe('auto launch', () => {
  it('detects the login argument', () => {
    expect(launchedAtLogin(['DesktopMMD.exe', AUTOSTART_ARG])).toBe(true);
    expect(launchedAtLogin(['DesktopMMD.exe'])).toBe(false);
  });
});

describe('VOICEVOX launcher', () => {
  const env = { LOCALAPPDATA: String.raw`C:\Users\me\AppData\Local`, ProgramFiles: String.raw`C:\Program Files` } as NodeJS.ProcessEnv;
  const installed = path.join(env.LOCALAPPDATA!, 'Programs', 'VOICEVOX', 'vv-engine', 'run.exe');

  it('only starts engines on this PC', () => {
    expect(localEndpoint('http://127.0.0.1:50021')).toEqual({ host: '127.0.0.1', port: 50021 });
    expect(localEndpoint('http://localhost:50100/')).toEqual({ host: '127.0.0.1', port: 50100 });
    expect(localEndpoint('http://192.168.0.5:50021')).toBeNull();
    expect(localEndpoint('not a url')).toBeNull();
  });

  it('finds the default install, or the folder / exe the user picked', () => {
    expect(findEngineExe('', env, (p) => p === installed)).toBe(installed);
    expect(findEngineExe('', env, () => false)).toBeNull();
    const custom = path.join(String.raw`D:\Apps\VOICEVOX`, 'vv-engine', 'run.exe');
    expect(findEngineExe(String.raw`D:\Apps\VOICEVOX`, env, (p) => p === custom)).toBe(custom);
    expect(findEngineExe(String.raw`"D:\Apps\VOICEVOX\VOICEVOX.exe"`, env, (p) => p === custom)).toBe(custom);
    expect(findEngineExe(custom, env, (p) => p === custom)).toBe(custom);
  });

  it('does nothing when the engine already answers', async () => {
    const spawnImpl = vi.fn();
    const l = new VoicevoxLauncher({ ping: async () => true, log: silent, spawnImpl: spawnImpl as never });
    expect(await l.ensureRunning('http://127.0.0.1:50021', '')).toBe('already');
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('starts run.exe on the configured port and waits until it answers', async () => {
    let up = false;
    const proc = Object.assign(new EventEmitter(), { exitCode: null, killed: false, pid: 1234 });
    const spawnImpl = vi.fn(() => {
      setTimeout(() => (up = true), 0);
      return proc;
    });
    const custom = String.raw`D:\VV\vv-engine\run.exe`;
    const l = new VoicevoxLauncher({ ping: async () => up, log: silent, spawnImpl: spawnImpl as never, sleep: () => new Promise((r) => setTimeout(r, 1)), exists: (p) => p === custom, portInUse: async () => false });
    expect(await l.ensureRunning('http://127.0.0.1:50100', custom)).toBe('started');
    expect(spawnImpl).toHaveBeenCalledWith(custom, ['--host', '127.0.0.1', '--port', '50100'], expect.objectContaining({ windowsHide: true }));
    expect(l.ownsEngine).toBe(true);
  });

  it('waits for an engine that another app (VOICEVOX editor) is starting instead of starting a second one', async () => {
    let n = 0;
    const spawnImpl = vi.fn();
    const l = new VoicevoxLauncher({ ping: async () => ++n > 3, log: silent, spawnImpl: spawnImpl as never, portInUse: async () => true, sleep: async () => {} });
    expect(await l.ensureRunning('http://127.0.0.1:50021', '')).toBe('already');
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(l.ownsEngine).toBe(false);
  });

  it('reports a missing engine and remote URLs', async () => {
    const l = new VoicevoxLauncher({ ping: async () => false, log: silent, exists: () => false, portInUse: async () => false });
    expect(await l.ensureRunning('http://192.168.0.5:50021', '')).toBe('remote');
    expect(await l.ensureRunning('http://127.0.0.1:50021', '')).toBe('not_found');
  });
});
