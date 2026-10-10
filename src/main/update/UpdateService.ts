// 起動時の自動更新: GitHub の最新リリースを見て、新しい版ならインストーラーを落として静かに入れ替える。
// Electron には依存せず、通信・保存先・起動方法は注入する（テスト容易性）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Logger } from '../util/logger';

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size?: number;
  /** GitHub が付ける "sha256:<hex>" */
  digest?: string | null;
}

export interface ReleaseInfo {
  tag_name: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: ReleaseAsset[];
}

export interface Installer {
  version: string;
  name: string;
  url: string;
  size?: number;
  sha256?: string;
}

/** "v1.2.3" → [1,2,3]。x.y.z 以外（beta 付きなど）は null。 */
export function parseVersion(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

const INSTALLER_NAME = /^DesktopMMD-Setup-[\w.-]+\.exe$/;
const ALLOWED_HOSTS = ['github.com'];

/** 正式リリースから、公式のインストーラー（DesktopMMD-Setup-x.y.z.exe）だけを選ぶ。 */
export function pickInstaller(rel: ReleaseInfo): Installer | null {
  if (rel.draft || rel.prerelease) return null;
  if (!parseVersion(rel.tag_name)) return null;
  const version = rel.tag_name.replace(/^v/, '');
  const asset = (rel.assets ?? []).find((a) => INSTALLER_NAME.test(a.name) && a.name.includes(version));
  if (!asset) return null;
  let url: URL;
  try {
    url = new URL(asset.browser_download_url);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.includes(url.hostname)) return null;
  const sha = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest ?? '');
  return { version, name: asset.name, url: url.toString(), size: asset.size, sha256: sha?.[1].toLowerCase() };
}

export interface UpdateDeps {
  currentVersion: string;
  /** "owner/repo" */
  repo: string;
  /** 起動時の自動確認をするか（canUpdate かつ設定がON） */
  enabled(): boolean;
  /** 更新できる環境か（開発起動・疑似LLMでは false）。手動の確認で使う */
  canUpdate(): boolean;
  downloadDir: string;
  fetch: typeof fetch;
  /** インストーラーを起動して、このアプリを終了させる（戻らない想定） */
  runInstaller(file: string): void;
  notify(text: string, kind: 'info' | 'warn'): void;
  log: Logger;
}

export type UpdateResult = 'disabled' | 'busy' | 'up-to-date' | 'no-installer' | 'installing' | 'failed';

export class UpdateService {
  private running = false;
  /** 直近の確認で分かった最新版（確認できなかったときは null） */
  latestVersion: string | null = null;

  constructor(private readonly d: UpdateDeps) {}

  /** manual=true は設定画面のボタンから。自動更新の設定がOFFでも確認する。 */
  async checkAndUpdate(manual = false): Promise<UpdateResult> {
    if (this.running) return 'busy';
    if (!(manual ? this.d.canUpdate() : this.d.enabled())) return 'disabled';
    this.running = true;
    try {
      this.latestVersion = null;
      const rel = await this.latest();
      this.latestVersion = rel && parseVersion(rel.tag_name) ? rel.tag_name.replace(/^v/, '') : null;
      if (!rel || !isNewer(rel.tag_name, this.d.currentVersion)) return 'up-to-date';
      const inst = pickInstaller(rel);
      if (!inst) {
        this.d.log.warn(`新しい版 ${rel.tag_name} がありますが、インストーラーが見つかりません`);
        return 'no-installer';
      }
      this.d.log.info(`update ${this.d.currentVersion} → ${inst.version}`);
      this.d.notify(`新しい版 ${inst.version} を見つけました。ダウンロードして更新します`, 'info');
      const file = await this.download(inst);
      this.d.notify('更新のため再起動します', 'info');
      this.d.runInstaller(file);
      return 'installing';
    } catch (e) {
      this.d.log.warn('update failed', e);
      return 'failed';
    } finally {
      this.running = false;
    }
  }

  private async latest(): Promise<ReleaseInfo | null> {
    const res = await this.d.fetch(`https://api.github.com/repos/${this.d.repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'DesktopMMD-updater' },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404) return null; // リリースがまだ無い
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    return (await res.json()) as ReleaseInfo;
  }

  private async download(inst: Installer): Promise<string> {
    fs.mkdirSync(this.d.downloadDir, { recursive: true });
    const dest = path.join(this.d.downloadDir, inst.name);
    const part = `${dest}.part`;
    const res = await this.d.fetch(inst.url, { headers: { 'User-Agent': 'DesktopMMD-updater' }, signal: AbortSignal.timeout(15 * 60_000) });
    if (!res.ok || !res.body) throw new Error(`download ${res.status}`);
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    const src = Readable.fromWeb(res.body as never);
    src.on('data', (c: Buffer) => {
      hash.update(c);
      bytes += c.length;
    });
    try {
      await pipeline(src, fs.createWriteStream(part));
      if (inst.size && bytes !== inst.size) throw new Error(`size mismatch (${bytes} / ${inst.size})`);
      if (!inst.sha256) throw new Error('sha256 digest missing');
      if (hash.digest('hex') !== inst.sha256) throw new Error('sha256 mismatch');
    } catch (e) {
      fs.rmSync(part, { force: true });
      throw e;
    }
    fs.rmSync(dest, { force: true });
    fs.renameSync(part, dest);
    return dest;
  }
}
