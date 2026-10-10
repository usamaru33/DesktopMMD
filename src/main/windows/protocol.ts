// mmd:// — read-only access for the renderer to the active model's folder and motions (spec 7.1 不正なPMX/VMD).
// The PMX is only ever read (model terms forbid modification); nothing here can write.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { net, protocol } from 'electron';
import { isInside } from '../tools/pathGuard';

export const MMD_SCHEME = 'mmd';

export function registerSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: MMD_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
  ]);
}

export interface MmdRoots {
  /** folder containing the PMX (textures live next to it) */
  model: string | null;
  /** characters/<id>/motions */
  motions: string | null;
  /** 標準の感情別モーション */
  defaults?: string | null;
}

const ALLOWED_EXT = new Set(['.pmx', '.pmd', '.vmd', '.vpd', '.png', '.jpg', '.jpeg', '.bmp', '.tga', '.dds', '.gif', '.sph', '.spa', '.webp']);
const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.bmp': 'image/bmp', '.gif': 'image/gif',
  '.webp': 'image/webp', '.sph': 'image/bmp', '.spa': 'image/bmp', '.tga': 'application/octet-stream',
};

export function handleMmdProtocol(getRoots: () => MmdRoots): void {
  protocol.handle(MMD_SCHEME, async (req) => {
    try {
      const u = new URL(req.url);
      const roots = getRoots();
      const base = u.hostname === 'model' ? roots.model : u.hostname === 'motion' ? roots.motions : u.hostname === 'default-motion' ? (roots.defaults ?? null) : null;
      if (!base) return new Response('not found', { status: 404 });
      const rel = decodeURIComponent(u.pathname).replace(/\\/g, '/').replace(/^\/+/, '');
      const target = path.resolve(base, rel);
      if (!isInside(path.win32, base, target)) return new Response('forbidden', { status: 403 });
      const ext = path.extname(target).toLowerCase();
      if (!ALLOWED_EXT.has(ext)) return new Response('forbidden', { status: 403 });
      let file = target;
      if (!fs.existsSync(file)) {
        // texture paths in PMX files are often wrong in letter case or extension; try a case-insensitive match
        const alt = findCaseInsensitive(target);
        if (!alt) return new Response('not found', { status: 404 });
        file = alt;
      }
      const res = await net.fetch(pathToFileURL(file).toString());
      const headers = new Headers(res.headers);
      const mime = MIME[path.extname(file).toLowerCase()];
      if (mime) headers.set('Content-Type', mime);
      return new Response(res.body, { status: res.status, headers });
    } catch {
      return new Response('error', { status: 500 });
    }
  });
}

function findCaseInsensitive(p: string): string | null {
  const dir = path.dirname(p);
  const name = path.basename(p).toLowerCase();
  try {
    const hit = fs.readdirSync(dir).find((f) => f.toLowerCase() === name);
    return hit ? path.join(dir, hit) : null;
  } catch {
    return null;
  }
}

export function modelUrl(modelPath: string): string {
  return `${MMD_SCHEME}://model/${encodeURIComponent(path.basename(modelPath))}`;
}

export function defaultMotionUrl(emotion: string): string {
  return `${MMD_SCHEME}://default-motion/${encodeURIComponent(emotion)}.vmd`;
}

export function motionUrl(file: string): string {
  return `${MMD_SCHEME}://motion/${file.split(/[\\/]/).map(encodeURIComponent).join('/')}`;
}
