// Single sandboxed preload for both windows (a sandboxed preload can't require shared chunks, so the
// two bridges live in one bundle). Each window gets only its own bridge, chosen by the page it loads.
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { ADMIN_CHANNELS, type AdminBridge, C2M, type CharacterBridge, M2A, M2C } from '@shared/ipc';

function characterBridge(): CharacterBridge {
  const SEND = new Set<string>(Object.values(C2M));
  const RECV = new Set<string>(Object.values(M2C));
  return {
    send(channel, payload) {
      if (!SEND.has(channel)) throw new Error(`channel not allowed: ${channel}`);
      ipcRenderer.send(channel, payload);
    },
    on(channel, cb) {
      if (!RECV.has(channel)) throw new Error(`channel not allowed: ${channel}`);
      const listener = (_e: Electron.IpcRendererEvent, payload: unknown) => cb(payload as never);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    },
    pathsForFiles(files) {
      return files.map((f) => webUtils.getPathForFile(f)).filter(Boolean);
    },
  };
}

function adminBridge(): AdminBridge {
  const INVOKE = new Set<string>(ADMIN_CHANNELS);
  const RECV = new Set<string>(Object.values(M2A));
  return {
    invoke(channel, ...args) {
      if (!INVOKE.has(channel)) return Promise.reject(new Error(`channel not allowed: ${channel}`));
      return ipcRenderer.invoke(channel, ...args);
    },
    on(channel, cb) {
      if (!RECV.has(channel)) throw new Error(`channel not allowed: ${channel}`);
      const listener = (_e: Electron.IpcRendererEvent, payload: unknown) => cb(payload);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    },
  };
}

if (/\/admin\/index\.html/.test((globalThis as unknown as { location: { pathname: string } }).location.pathname)) contextBridge.exposeInMainWorld('mmdAdmin', adminBridge());
else contextBridge.exposeInMainWorld('mmd', characterBridge());
