// SC-10..15 admin window: ordinary window for settings, voice tuning, memory, history, tool log, setup.
import { BrowserWindow, nativeTheme, shell } from 'electron';
import { type AdminPage, M2A } from '@shared/ipc';

export interface AdminWindowDeps {
  preload: string;
  rendererUrl: string | null;
  rendererFile: string;
}

export class AdminWindow {
  win: BrowserWindow | null = null;

  constructor(private readonly d: AdminWindowDeps) {}

  open(page: AdminPage = 'settings'): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send(M2A.navigate, page);
      if (this.win.isMinimized()) this.win.restore();
      this.win.show();
      this.win.focus();
      return;
    }
    const win = new BrowserWindow({
      width: 1080,
      height: 760,
      minWidth: 760,
      minHeight: 520,
      title: 'DesktopMMD 管理',
      show: false,
      autoHideMenuBar: true,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1a21' : '#f6f5f2',
      webPreferences: {
        preload: this.d.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    win.setMenuBarVisibility(false);
    win.once('ready-to-show', () => win.show());
    win.on('closed', () => (this.win = null));
    // links open in the default browser, never inside the app (spec 7.1)
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.on('console-message', (e) => {
      if (e.level === 'error' || e.level === 'warning' || process.env.MMD_DEBUG) console.log(`[admin:${e.level}] ${e.message}`);
    });
    const hash = `#${page}`;
    if (this.d.rendererUrl) void win.loadURL(`${this.d.rendererUrl}/admin/index.html${hash}`);
    else void win.loadFile(this.d.rendererFile, { hash: page });
    this.win = win;
  }

  send(channel: string, payload: unknown): void {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, payload);
  }
}
