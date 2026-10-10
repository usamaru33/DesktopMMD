// Hold-to-talk hotkey via uiohook-napi (globalShortcut has no key-up). Spec 3.3, skill mmd-voice-pipeline §7.
import { uIOhook, UiohookKey } from 'uiohook-napi';
import type { Logger } from '../util/logger';

export interface PttHandlers {
  down(): void;
  /** heldMs: how long the key combo was held */
  up(heldMs: number): void;
}

interface Combo {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  key: number;
}

const KEY_NAMES: Record<string, number> = {
  Space: UiohookKey.Space,
  Enter: UiohookKey.Enter,
  Tab: UiohookKey.Tab,
  Backquote: UiohookKey.Backquote,
  F1: UiohookKey.F1, F2: UiohookKey.F2, F3: UiohookKey.F3, F4: UiohookKey.F4, F5: UiohookKey.F5, F6: UiohookKey.F6,
  F7: UiohookKey.F7, F8: UiohookKey.F8, F9: UiohookKey.F9, F10: UiohookKey.F10, F11: UiohookKey.F11, F12: UiohookKey.F12,
};

/** Parse an Electron accelerator like "Ctrl+Alt+Space" into a uiohook combo. */
export function parseAccelerator(acc: string): Combo | null {
  const parts = acc.split('+').map((p) => p.trim());
  const c: Combo = { ctrl: false, alt: false, shift: false, meta: false, key: -1 };
  for (const p of parts) {
    const l = p.toLowerCase();
    if (l === 'ctrl' || l === 'control' || l === 'commandorcontrol' || l === 'cmdorctrl') c.ctrl = true;
    else if (l === 'alt' || l === 'option') c.alt = true;
    else if (l === 'shift') c.shift = true;
    else if (l === 'super' || l === 'meta' || l === 'win') c.meta = true;
    else if (KEY_NAMES[p] !== undefined) c.key = KEY_NAMES[p];
    else if (/^[A-Z0-9]$/i.test(p)) c.key = (UiohookKey as unknown as Record<string, number>)[p.toUpperCase()] ?? -1;
    else return null;
  }
  return c.key >= 0 ? c : null;
}

export class PushToTalk {
  private combo: Combo | null = null;
  private downAt = 0;
  private started = false;
  private handlers: PttHandlers | null = null;

  constructor(private readonly log: Logger) {}

  /** Returns false if uiohook could not start (caller falls back to a toggle shortcut). */
  start(accelerator: string, handlers: PttHandlers): boolean {
    this.combo = parseAccelerator(accelerator);
    this.handlers = handlers;
    if (!this.combo) {
      this.log.warn(`push-to-talk: cannot parse ${accelerator}`);
      return false;
    }
    if (this.started) return true;
    try {
      uIOhook.on('keydown', (e) => {
        const c = this.combo;
        if (!c || this.downAt || e.keycode !== c.key) return;
        if (e.ctrlKey !== c.ctrl || e.altKey !== c.alt || e.shiftKey !== c.shift || e.metaKey !== c.meta) return;
        this.downAt = Date.now();
        this.handlers?.down();
      });
      uIOhook.on('keyup', (e) => {
        const c = this.combo;
        if (!c || !this.downAt) return;
        // releasing the main key or any required modifier ends the hold
        const isPart =
          e.keycode === c.key ||
          (c.ctrl && (e.keycode === UiohookKey.Ctrl || e.keycode === UiohookKey.CtrlRight)) ||
          (c.alt && (e.keycode === UiohookKey.Alt || e.keycode === UiohookKey.AltRight)) ||
          (c.shift && (e.keycode === UiohookKey.Shift || e.keycode === UiohookKey.ShiftRight));
        if (!isPart) return;
        const held = Date.now() - this.downAt;
        this.downAt = 0;
        this.handlers?.up(held);
      });
      uIOhook.start();
      this.started = true;
      return true;
    } catch (e) {
      this.log.warn('uiohook failed to start', e);
      return false;
    }
  }

  update(accelerator: string): boolean {
    this.combo = parseAccelerator(accelerator);
    return !!this.combo;
  }

  stop(): void {
    if (!this.started) return;
    try {
      uIOhook.stop();
    } catch {
      /* ignore */
    }
    this.started = false;
  }
}
