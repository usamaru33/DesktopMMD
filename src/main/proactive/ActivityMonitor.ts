// Watches user activity for proactive speech (spec 5.8): idle time, active app, full-screen, mic in use.
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { Logger } from '../util/logger';
import type { ActivityState } from './suppression';

export interface WindowInfo {
  app: string | null;
  /** full path of the owning exe (shell detection must not rely on the localized display name) */
  path?: string | null;
  bounds: { x: number; y: number; width: number; height: number } | null;
}

export interface ActivityDeps {
  idleSeconds(): number; // powerMonitor.getSystemIdleTime
  activeWindow(): Promise<WindowInfo | null>;
  displayBoundsFor(rect: { x: number; y: number; width: number; height: number }): { x: number; y: number; width: number; height: number };
  ownPid: number;
  watchApps(): boolean;
  now(): Date;
  log: Logger;
}

const AWAY_GAP_SEC = 4 * 3600;
const BREAK_IDLE_SEC = 5 * 60;

export class ActivityMonitor extends EventEmitter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private winTimer: ReturnType<typeof setInterval> | null = null;
  private streakStart: number | null = null;
  private streakApp: string | null = null;
  private lastActiveAt = 0;
  private lastDay = '';
  returnedAt: Date | null = null;
  fullscreen = false;
  activeApp: string | null = null;
  micInUse = false;
  private fsStreak = 0;

  constructor(private readonly d: ActivityDeps) {
    super();
  }

  start(): void {
    this.tick();
    this.timer = setInterval(() => this.tick(), 10_000);
    this.winTimer = setInterval(() => void this.pollWindow(), 5_000);
    void this.pollWindow();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.winTimer) clearInterval(this.winTimer);
  }

  state(): ActivityState {
    const now = this.d.now().getTime();
    return {
      activeStreakMin: this.streakStart ? (now - this.streakStart) / 60_000 : 0,
      streakApp: this.streakApp,
      idleSec: this.d.idleSeconds(),
      returnedAt: this.returnedAt,
    };
  }

  private tick(): void {
    const now = this.d.now();
    const idle = this.d.idleSeconds();
    const day = now.toDateString();
    if (idle < 10) {
      // active now
      const gap = this.lastActiveAt ? (now.getTime() - this.lastActiveAt) / 1000 : Infinity;
      if (gap > AWAY_GAP_SEC || day !== this.lastDay) {
        this.returnedAt = now;
        this.emit('returned', now);
      }
      if (!this.streakStart || gap > BREAK_IDLE_SEC) {
        this.streakStart = now.getTime();
        this.streakApp = this.activeApp;
      }
      this.lastActiveAt = now.getTime();
      this.lastDay = day;
      this.emit('activeMinute', now, this.d.watchApps() ? this.activeApp : null);
    } else if (idle > BREAK_IDLE_SEC) {
      this.streakStart = null;
    }
  }

  private async pollWindow(): Promise<void> {
    try {
      const w = await this.d.activeWindow();
      const app = w?.app ?? null;
      if (app !== this.activeApp) {
        this.activeApp = app;
        // a different app breaks the "same app" streak
        if (this.streakApp && app && app !== this.streakApp) this.streakApp = null;
      }
      const fs = !!w?.bounds && isFullscreenWindow(w, this.d.displayBoundsFor(w.bounds));
      // hide only after two consecutive full-screen polls (alt-tab flicker), show again immediately
      this.fsStreak = fs ? this.fsStreak + 1 : 0;
      const next = this.fsStreak >= 2;
      if (next !== this.fullscreen) {
        this.fullscreen = next;
        this.emit('fullscreen', next);
      }
    } catch (e) {
      this.d.log.debug('active window poll failed', e);
    }
  }

  /** Checked lazily right before speaking: spawning PowerShell every few seconds would cost idle CPU (NFR-04). */
  async refreshMicInUse(): Promise<boolean> {
    this.micInUse = await micInUseByOthers().catch(() => false);
    return this.micInUse;
  }
}

/** Windows shell surfaces that are display-sized but are not "a full-screen app" (desktop, start, search…). */
const SHELL_EXES = new Set([
  'explorer.exe', 'shellexperiencehost.exe', 'startmenuexperiencehost.exe', 'searchhost.exe', 'searchapp.exe',
  'searchui.exe', 'textinputhost.exe', 'lockapp.exe', 'applicationframehost.exe', 'widgets.exe', 'shellhost.exe',
]);

/**
 * A window counts as full screen only when it covers the display exactly (±1px).
 * Maximized windows overhang the display by their invisible resize borders (≈7px) and are excluded, and
 * the desktop/shell is recognized by its exe file name — the display name is localized
 * (explorer.exe is「エクスプローラー」on Japanese Windows), so it can't be matched by name.
 */
export function isFullscreenWindow(
  w: WindowInfo,
  disp: { x: number; y: number; width: number; height: number },
): boolean {
  const b = w.bounds;
  if (!b) return false;
  const exe = (w.path ?? '').split(/[\\/]/).pop()?.toLowerCase() ?? '';
  if (SHELL_EXES.has(exe)) return false;
  if (!exe && w.app && /^(explorer|windows explorer|エクスプローラー|program manager)/i.test(w.app)) return false;
  const near = (a: number, c: number) => Math.abs(a - c) <= 1;
  return near(b.x, disp.x) && near(b.y, disp.y) && near(b.width, disp.width) && near(b.height, disp.height);
}

/**
 * True if another app is currently recording (Windows privacy registry: LastUsedTimeStop == 0).
 * Our own Electron process is excluded by name.
 */
export function micInUseByOthers(): Promise<boolean> {
  const ps = `
$base = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone'
$hit = $false
foreach ($k in @(Get-ChildItem $base -ErrorAction SilentlyContinue) + @(Get-ChildItem "$base\\NonPackaged" -ErrorAction SilentlyContinue)) {
  $p = Get-ItemProperty $k.PSPath -ErrorAction SilentlyContinue
  if ($p -and $p.LastUsedTimeStart -gt 0 -and $p.LastUsedTimeStop -eq 0 -and $k.PSChildName -notmatch 'electron|desktopmmd') { $hit = $true }
}
if ($hit) { '1' } else { '0' }`;
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 4000 }, (err, stdout) => {
      resolve(!err && stdout.trim() === '1');
    });
  });
}
