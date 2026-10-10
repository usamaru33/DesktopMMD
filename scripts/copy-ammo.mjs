// Copy three r170's bundled ammo.wasm build into the character renderer's public dir.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const src = join('node_modules', 'three', 'examples', 'jsm', 'libs');
const dst = join('src', 'renderer', 'public');
if (existsSync(src)) {
  mkdirSync(dst, { recursive: true });
  for (const f of ['ammo.wasm.js', 'ammo.wasm.wasm']) cpSync(join(src, f), join(dst, f));
}
