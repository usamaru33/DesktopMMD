// Windows ログイン時の自動起動（HKCU\...\Run に登録）。
import { app } from 'electron';
import type { Logger } from '../util/logger';

/** レジストリの値の名前。アンインストーラ（build/installer.nsh）も同じ名前で消す */
export const LOGIN_ITEM_NAME = 'DesktopMMD';
/** ログイン時に起動されたときに付く引数 */
export const AUTOSTART_ARG = '--autostart';

export function launchedAtLogin(argv: string[] = process.argv): boolean {
  return argv.includes(AUTOSTART_ARG);
}

/**
 * 自動起動の登録・解除。開発中（electron.exe）を登録するとログインのたびに空の Electron が立ち上がるので、
 * インストール版でだけ行う。
 */
export function applyAutoLaunch(enabled: boolean, log: Logger): void {
  if (!app.isPackaged) {
    log.info(`auto launch ${enabled ? 'on' : 'off'} (skipped: not packaged)`);
    return;
  }
  const opts = { path: process.execPath, args: [AUTOSTART_ARG], name: LOGIN_ITEM_NAME };
  try {
    app.setLoginItemSettings({ ...opts, openAtLogin: enabled, enabled });
    const now = app.getLoginItemSettings(opts);
    // 名前を指定して登録すると openAtLogin の読み戻しが false のままになることがあるので、実際に起動されるかの方を見る
    log.info(`auto launch ${enabled ? 'on' : 'off'} → willLaunch=${now.executableWillLaunchAtLogin}`);
  } catch (e) {
    log.warn('auto launch registration failed', e);
  }
}
