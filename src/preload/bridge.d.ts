import type { AdminBridge, CharacterBridge } from '../shared/ipc';

declare global {
  interface Window {
    mmd: CharacterBridge;
    mmdAdmin: AdminBridge;
  }
}

export {};
