// File layout (spec 6.1): %APPDATA%\mmd-assistant\...
import path from 'node:path';
import { app } from 'electron';

export interface AppPaths {
  root: string;
  settings: string;
  secrets: string;
  db: string;
  characters: string;
  backups: string;
  logs: string;
  models: string;
  /** 標準の感情別モーション（起動時にコードから書き出す） */
  defaultMotions: string;
}

export function appPaths(): AppPaths {
  // MMD_DATA_DIR: use a throwaway data folder for tests/screenshots instead of the real one
  const root = process.env.MMD_DATA_DIR ? path.resolve(process.env.MMD_DATA_DIR) : path.join(app.getPath('appData'), 'mmd-assistant');
  return {
    root,
    settings: path.join(root, 'settings.json'),
    secrets: path.join(root, 'secrets.bin'),
    db: path.join(root, 'assistant.db'),
    characters: path.join(root, 'characters'),
    backups: path.join(root, 'backups'),
    logs: path.join(root, 'logs'),
    models: path.join(root, 'models'),
    defaultMotions: path.join(root, 'default-motions'),
  };
}

/** Python sidecar launcher: venv in dev, PyInstaller exe when packaged. */
export function sidecarCommand(): { command: string; args: string[] } {
  if (app.isPackaged) {
    return { command: path.join(process.resourcesPath, 'sidecar', 'sidecar.exe'), args: [] };
  }
  const root = app.getAppPath();
  return { command: path.join(root, 'sidecar', '.venv', 'Scripts', 'python.exe'), args: ['-I', path.join(root, 'sidecar', 'main.py')] };
}
