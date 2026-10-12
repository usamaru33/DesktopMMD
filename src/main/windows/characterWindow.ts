// SC-01 character window: transparent, frameless, always on top, click-through outside the model
// (spec 3.2, FR-EX-01/02).
import path from 'node:path';
import { BrowserWindow, screen, shell } from 'electron';
import { C2M, type C2MPayloads, M2C, type M2CPayloads } from '@shared/ipc';
import type { Settings } from '@shared/types';

const BASE_W = 480;
const BASE_H = 720;

export interface CharacterWindowDeps {
  settings(): Settings;
  saveWindow(patch: Partial<Settings['window']>): void;
  preload: string;
  rendererUrl: string | null; // dev server
  rendererFile: string;
}

export class CharacterWindow {
  win: BrowserWindow | null = null;
  private cursorTimer: ReturnType<typeof setInterval> | null = null;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private ignoring = true;
  private lastCursor = { x: -1, y: -1 };
  private hiddenForFullscreen = false;
  /** an approval card must be visible even over a full-screen app */
  private forcedVisible = false;
  userHidden = false;

  constructor(private readonly d: CharacterWindowDeps) {}

  create(): BrowserWindow {
    const s = this.d.settings();
    const scale = clampScale(s.window.scale);
    const w = Math.round(BASE_W * scale);
    const h = Math.round(BASE_H * scale);
    const pos = this.initialPosition(w, h);
    const win = new BrowserWindow({
      x: pos.x,
      y: pos.y,
      width: w,
      height: h,
      transparent: true,
      frame: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      hasShadow: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: true,
      show: false,
      backgroundColor: '#00000000',
      title: 'DesktopMMD',
      webPreferences: {
        preload: this.d.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        spellcheck: false,
      },
    });
    win.setAlwaysOnTop(true, 'floating');
    // links from the detail panel open in the default browser (spec 7.1)
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.on('console-message', (e) => {
      if (e.level === 'error' || e.level === 'warning' || process.env.MMD_DEBUG) console.log(`[character:${e.level}] ${e.message}`);
    });
    win.webContents.on('render-process-gone', (_e, d) => console.error(`[character] renderer gone: ${d.reason}`));
    win.setIgnoreMouseEvents(true, { forward: true });
    win.setVisibleOnAllWorkspaces(true);
    win.once('ready-to-show', () => {
      if (!this.userHidden) win.showInactive();
    });
    // the renderer keeps running while hidden (backgroundThrottling is off for audio and timers), so tell it
    // to stop drawing: a full-screen game or video shouldn't pay for a character nobody can see
    win.on('show', () => this.send(M2C.visible, true));
    win.on('restore', () => this.send(M2C.visible, true));
    win.on('hide', () => this.send(M2C.visible, false));
    win.on('minimize', () => this.send(M2C.visible, false));
    win.on('closed', () => {
      this.win = null;
      this.stopCursorFeed();
      if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    });
    // never stay minimized (Win+D / "show desktop", minimize-all): restore at once
    win.on('minimize', () => {
      if (this.shouldBeVisible()) setTimeout(() => this.reassert(), 50);
    });
    // safety net: if something hid us or pushed us below another topmost window, come back
    this.keepAliveTimer = setInterval(() => this.reassert(), 3000);
    if (this.d.rendererUrl) void win.loadURL(`${this.d.rendererUrl}/character/index.html`);
    else void win.loadFile(this.d.rendererFile);
    this.win = win;
    this.startCursorFeed();
    return win;
  }

  private initialPosition(w: number, h: number): { x: number; y: number } {
    const s = this.d.settings().window;
    if (s.x !== null && s.y !== null) {
      // keep it on a connected display
      const disp = screen.getDisplayMatching({ x: s.x, y: s.y, width: w, height: h });
      const a = disp.workArea;
      const x = Math.min(Math.max(s.x, a.x - w / 2), a.x + a.width - w / 2);
      const y = Math.min(Math.max(s.y, a.y), a.y + a.height - h / 3);
      return { x: Math.round(x), y: Math.round(y) };
    }
    const a = screen.getPrimaryDisplay().workArea;
    return { x: a.x + a.width - w - 16, y: a.y + a.height - h };
  }

  send<K extends keyof M2CPayloads>(channel: K, payload: M2CPayloads[K]): void {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, payload);
  }

  // ---- handlers for renderer messages ----

  onIgnoreMouse(ignore: C2MPayloads[typeof C2M.ignoreMouse]): void {
    if (!this.win || ignore === this.ignoring) return;
    this.ignoring = ignore;
    this.win.setIgnoreMouseEvents(ignore, { forward: true });
  }

  onDrag({ dx, dy }: C2MPayloads[typeof C2M.drag]): void {
    if (!this.win) return;
    const [x, y] = this.win.getPosition();
    this.win.setPosition(Math.round(x + dx), Math.round(y + dy));
  }

  onDragEnd(): void {
    this.persistBounds();
  }

  onScale(factor: number): void {
    if (!this.win) return;
    const s = this.d.settings().window;
    const next = clampScale(s.scale * factor);
    if (next === s.scale) return;
    const b = this.win.getBounds();
    const w = Math.round(BASE_W * next);
    const h = Math.round(BASE_H * next);
    // keep the feet (bottom center) where they are
    const x = Math.round(b.x + b.width / 2 - w / 2);
    const y = Math.round(b.y + b.height - h);
    this.win.setBounds({ x, y, width: w, height: h });
    this.d.saveWindow({ scale: next, x, y });
    this.send(M2C.windowBounds, { width: w, height: h, scale: next });
  }

  resetPosition(): void {
    if (!this.win) return;
    const b = this.win.getBounds();
    const a = screen.getPrimaryDisplay().workArea;
    this.win.setPosition(a.x + a.width - b.width - 16, a.y + a.height - b.height);
    this.persistBounds();
  }

  private persistBounds(): void {
    if (!this.win) return;
    const [x, y] = this.win.getPosition();
    this.d.saveWindow({ x, y });
  }

  // ---- visibility ----

  toggleVisible(): void {
    this.userHidden = !this.userHidden;
    this.applyVisibility();
  }

  setFullscreenHidden(hidden: boolean): void {
    this.hiddenForFullscreen = hidden;
    this.applyVisibility();
  }

  show(): void {
    this.userHidden = false;
    this.applyVisibility();
  }

  /** Keep the window visible while an approval card is pending (otherwise it would silently time out). */
  setForcedVisible(on: boolean): void {
    this.forcedVisible = on;
    this.applyVisibility();
  }

  /** Apply a scale chosen in the admin window (no-op if already at that size). */
  setScale(scale: number): void {
    if (!this.win) return;
    const next = clampScale(scale);
    const b = this.win.getBounds();
    const w = Math.round(BASE_W * next);
    const h = Math.round(BASE_H * next);
    if (b.width === w && b.height === h) return;
    this.win.setBounds({ x: Math.round(b.x + b.width / 2 - w / 2), y: Math.round(b.y + b.height - h), width: w, height: h });
    this.send(M2C.windowBounds, { width: w, height: h, scale: next });
  }

  private shouldBeVisible(): boolean {
    return this.forcedVisible || (!this.userHidden && !this.hiddenForFullscreen);
  }

  /** Restore + re-raise when the window should be visible but isn't (minimized, hidden, lost topmost). */
  private reassert(): void {
    const win = this.win;
    if (!win || win.isDestroyed() || !this.shouldBeVisible()) return;
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.showInactive();
    if (!win.isAlwaysOnTop()) win.setAlwaysOnTop(true, 'floating');
  }

  private applyVisibility(): void {
    if (!this.win) return;
    const visible = this.shouldBeVisible();
    if (visible && !this.win.isVisible()) this.win.showInactive();
    if (!visible && this.win.isVisible()) this.win.hide();
  }

  get visible(): boolean {
    return !!this.win?.isVisible();
  }

  focusForInput(): void {
    if (!this.win) return;
    this.show();
    this.win.setIgnoreMouseEvents(false);
    this.ignoring = false;
    this.win.focus();
  }

  // ---- cursor feed for gaze tracking (30 Hz, only when it moved) ----

  private startCursorFeed(): void {
    this.cursorTimer = setInterval(() => {
      if (!this.win || !this.win.isVisible()) return;
      const p = screen.getCursorScreenPoint();
      if (p.x === this.lastCursor.x && p.y === this.lastCursor.y) return;
      this.lastCursor = p;
      const [winX, winY] = this.win.getPosition();
      this.send(M2C.cursor, { x: p.x, y: p.y, winX, winY });
    }, 33);
  }

  private stopCursorFeed(): void {
    if (this.cursorTimer) clearInterval(this.cursorTimer);
    this.cursorTimer = null;
  }

  capture(): Promise<Electron.NativeImage> | null {
    return this.win ? this.win.webContents.capturePage() : null;
  }
}

function clampScale(s: number): number {
  if (!Number.isFinite(s)) return 1;
  return Math.round(Math.min(2, Math.max(0.5, s)) * 100) / 100;
}

export function rendererPaths(outDir: string): { character: string; admin: string } {
  return {
    character: path.join(outDir, 'renderer', 'character', 'index.html'),
    admin: path.join(outDir, 'renderer', 'admin', 'index.html'),
  };
}
