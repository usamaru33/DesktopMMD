import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { isNewer, parseVersion, pickInstaller, UpdateService, type ReleaseInfo } from '../../src/main/update/UpdateService';
import { limitGaze } from '../../src/renderer/character/character/motion';

const log = { debug() {}, info() {}, warn() {}, error() {} };
const rel = (over: Partial<ReleaseInfo> = {}): ReleaseInfo => ({
  tag_name: 'v0.3.0',
  assets: [{ name: 'DesktopMMD-Setup-0.3.0.exe', browser_download_url: 'https://github.com/usamaru33/DesktopMMD/releases/download/v0.3.0/DesktopMMD-Setup-0.3.0.exe' }],
  ...over,
});

describe('version', () => {
  it('compares x.y.z numerically', () => {
    expect(parseVersion('v1.2.3')).toEqual([1, 2, 3]);
    expect(parseVersion('1.2.3-beta')).toBeNull();
    expect(isNewer('v0.10.0', '0.9.9')).toBe(true);
    expect(isNewer('0.2.2', '0.2.2')).toBe(false);
    expect(isNewer('0.2.1', '0.2.2')).toBe(false);
    expect(isNewer('garbage', '0.2.2')).toBe(false);
  });
});

describe('pickInstaller', () => {
  it('picks the official installer only', () => {
    expect(pickInstaller(rel())?.name).toBe('DesktopMMD-Setup-0.3.0.exe');
    expect(pickInstaller(rel({ prerelease: true }))).toBeNull();
    expect(pickInstaller(rel({ draft: true }))).toBeNull();
    expect(pickInstaller(rel({ assets: [{ name: 'evil.exe', browser_download_url: 'https://github.com/x/evil.exe' }] }))).toBeNull();
    expect(pickInstaller(rel({ assets: [{ name: 'DesktopMMD-Setup-0.3.0.exe', browser_download_url: 'https://evil.example/DesktopMMD-Setup-0.3.0.exe' }] }))).toBeNull();
    expect(pickInstaller(rel({ assets: [{ name: 'DesktopMMD-Setup-0.3.0.exe', browser_download_url: 'http://github.com/a.exe' }] }))).toBeNull();
  });
  it('reads the sha256 digest', () => {
    const sha = 'a'.repeat(64);
    const r = rel({ assets: [{ name: 'DesktopMMD-Setup-0.3.0.exe', browser_download_url: 'https://github.com/a/b/DesktopMMD-Setup-0.3.0.exe', digest: `sha256:${sha}` }] });
    expect(pickInstaller(r)?.sha256).toBe(sha);
  });
});

describe('UpdateService', () => {
  const body = Buffer.from('installer-bytes');
  const sha = crypto.createHash('sha256').update(body).digest('hex');
  const make = (release: ReleaseInfo | number, enabled = true, current = '0.2.2') => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-'));
    const runInstaller = vi.fn();
    const f = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('api.github.com')) {
        return typeof release === 'number' ? new Response('', { status: release }) : new Response(JSON.stringify(release));
      }
      return new Response(body);
    });
    const svc = new UpdateService({ currentVersion: current, repo: 'o/r', enabled: () => enabled, canUpdate: () => true, downloadDir: dir, fetch: f as never, runInstaller, notify: () => {}, log });
    return { svc, runInstaller, f, dir };
  };
  const withDigest = (digest: string) => rel({ assets: [{ name: 'DesktopMMD-Setup-0.3.0.exe', browser_download_url: 'https://github.com/o/r/DesktopMMD-Setup-0.3.0.exe', size: body.length, digest }] });

  it('downloads a newer release and runs the installer', async () => {
    const { svc, runInstaller, dir } = make(withDigest(`sha256:${sha}`));
    expect(await svc.checkAndUpdate()).toBe('installing');
    const file = path.join(dir, 'DesktopMMD-Setup-0.3.0.exe');
    expect(runInstaller).toHaveBeenCalledWith(file);
    expect(fs.readFileSync(file)).toEqual(body);
  });
  it('rejects a corrupted download', async () => {
    const { svc, runInstaller, dir } = make(withDigest(`sha256:${'0'.repeat(64)}`));
    expect(await svc.checkAndUpdate()).toBe('failed');
    expect(runInstaller).not.toHaveBeenCalled();
    expect(fs.readdirSync(dir)).toEqual([]);
  });
  it('refuses to install when the release has no sha256 digest', async () => {
    const { svc, runInstaller, dir } = make(withDigest(''));
    expect(await svc.checkAndUpdate()).toBe('failed');
    expect(runInstaller).not.toHaveBeenCalled();
    expect(fs.readdirSync(dir)).toEqual([]);
  });
  it('does nothing when current, disabled, or no release exists', async () => {
    expect(await make(rel(), true, '0.3.0').svc.checkAndUpdate()).toBe('up-to-date');
    const off = make(rel(), false);
    expect(await off.svc.checkAndUpdate()).toBe('disabled');
    expect(off.f).not.toHaveBeenCalled();
    expect(await make(404).svc.checkAndUpdate()).toBe('up-to-date');
    expect(await make(500).svc.checkAndUpdate()).toBe('failed');
  });
  it('a manual check ignores the auto-update setting and reports the latest version', async () => {
    const m = make(rel(), false, '0.3.0');
    expect(await m.svc.checkAndUpdate(true)).toBe('up-to-date');
    expect(m.svc.latestVersion).toBe('0.3.0');
    const n = make(rel(), false);
    expect((await n.svc.checkAndUpdate(true)) !== 'disabled').toBe(true);
    expect(n.svc.latestVersion).toBe('0.3.0');
  });
});

describe('limitGaze', () => {
  it('caps the gaze angle; pitch gets 60% of it', () => {
    const [x, y] = limitGaze(1.5, -1.5, 40);
    expect(x).toBeCloseTo((40 * Math.PI) / 180);
    expect(y).toBeCloseTo((-24 * Math.PI) / 180);
    expect(limitGaze(0.1, 0.05, 40)).toEqual([0.1, 0.05]);
    expect(limitGaze(1, 1, 0)).toEqual([0, 0]);
  });
});
