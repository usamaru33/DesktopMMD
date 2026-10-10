// SC-04 tray menu (FR-EX-03).
import { Menu, Tray, nativeImage } from 'electron';

export interface TrayActions {
  version(): string;
  isVisible(): boolean;
  isMuted(): boolean;
  isMicOn(): boolean;
  isSleeping(): boolean;
  toggleVisible(): void;
  toggleMute(): void;
  toggleMic(): void;
  toggleSleep(): void;
  openAdmin(page?: 'settings' | 'voice' | 'memory' | 'history' | 'tools'): void;
  openGuide(): void;
  modes(): { list: string[]; current: string | null };
  setMode(mode: string | null): void;
  quit(): void;
}

/** 16x16 tray icon drawn in code (a small pink circle with eyes), so no binary asset is needed. */
function trayIcon(): Electron.NativeImage {
  const size = 32;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const dx = x - 15.5;
      const dy = y - 15.5;
      const d = Math.hypot(dx, dy);
      let [r, g, b, a] = [0, 0, 0, 0];
      if (d < 14) [r, g, b, a] = [236, 120, 160, 255];
      if (d >= 12.5 && d < 14) [r, g, b] = [200, 80, 120];
      const eye = Math.hypot(Math.abs(dx) - 5, dy + 2) < 2.4;
      if (eye && d < 12.5) [r, g, b] = [40, 30, 50];
      if (Math.abs(dy - 6) < 1.2 && Math.abs(dx) < 4 && d < 12.5) [r, g, b] = [120, 40, 70];
      // BGRA
      buf[i] = b;
      buf[i + 1] = g;
      buf[i + 2] = r;
      buf[i + 3] = a;
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: 2 });
}

export function createTray(a: TrayActions): { tray: Tray; refresh(): void } {
  const tray = new Tray(trayIcon());
  tray.setToolTip('DesktopMMD');
  // skill.md の overlays があるときだけ「キャラクターのモード」を出す
  const modeMenu = (): Electron.MenuItemConstructorOptions[] => {
    const { list, current } = a.modes();
    if (!list.length) return [];
    return [
      {
        label: 'キャラクターのモード',
        submenu: [
          { label: 'なし（基本）', type: 'radio', checked: current === null, click: () => { a.setMode(null); refresh(); } },
          ...list.map((m) => ({ label: m, type: 'radio' as const, checked: current === m, click: () => { a.setMode(m); refresh(); } })),
        ],
      },
    ];
  };
  const refresh = () => {
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `DesktopMMD ${a.version()}`, enabled: false },
        { type: 'separator' },
        { label: a.isVisible() ? '隠す' : '表示する', click: () => { a.toggleVisible(); refresh(); } },
        { label: 'ミュート', type: 'checkbox', checked: a.isMuted(), click: () => { a.toggleMute(); refresh(); } },
        { label: 'マイク', type: 'checkbox', checked: a.isMicOn(), click: () => { a.toggleMic(); refresh(); } },
        { label: 'おやすみモード', type: 'checkbox', checked: a.isSleeping(), click: () => { a.toggleSleep(); refresh(); } },
        ...modeMenu(),
        { type: 'separator' },
        { label: '設定…', click: () => a.openAdmin('settings') },
        { label: '調声…', click: () => a.openAdmin('voice') },
        { label: '記憶…', click: () => a.openAdmin('memory') },
        { label: '会話履歴…', click: () => a.openAdmin('history') },
        { label: '作業履歴…', click: () => a.openAdmin('tools') },
        { type: 'separator' },
        { label: '使い方', click: () => a.openGuide() },
        { label: '終了', click: () => a.quit() },
      ]),
    );
  };
  refresh();
  tray.on('click', () => {
    a.toggleVisible();
    refresh();
  });
  return { tray, refresh };
}
