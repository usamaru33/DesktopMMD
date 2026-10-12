// Being carried (the window dragged around): the window's velocity and acceleration, smoothed, so the body can
// lean and the hair / skirt can swing as if the character were really picked up and moved. Pure; no three.js.
import { type Pose, ZERO_POSE } from './motion';

const D = Math.PI / 180;

export class Carry {
  private dx = 0;
  private dy = 0;
  /** smoothed window velocity / acceleration, screen px/s and px/s² (y down) */
  vx = 0;
  vy = 0;
  ax = 0;
  ay = 0;

  /** The window moved by (dx, dy) screen px since the last frame. */
  push(dx: number, dy: number): void {
    this.dx += dx;
    this.dy += dy;
  }

  update(dt: number): void {
    if (dt <= 0) return;
    // mouse events come in bursts: smooth the velocity, then the acceleration derived from it
    const kv = Math.min(1, dt * 12);
    const vx = this.vx + (this.dx / dt - this.vx) * kv;
    const vy = this.vy + (this.dy / dt - this.vy) * kv;
    this.dx = 0;
    this.dy = 0;
    const ka = Math.min(1, dt * 10);
    this.ax += ((vx - this.vx) / dt - this.ax) * ka;
    this.ay += ((vy - this.vy) / dt - this.ay) * ka;
    this.vx = vx;
    this.vy = vy;
    if (this.still) this.vx = this.vy = this.ax = this.ay = 0;
  }

  get still(): boolean {
    return Math.abs(this.vx) + Math.abs(this.vy) < 1 && Math.abs(this.ax) + Math.abs(this.ay) < 5;
  }
}

/**
 * The pull felt in a moving window, as extra gravity in world units/s² (+Y up): the window accelerating
 * right pushes the hair left, and so on. Capped at `limit` so a flick doesn't throw the skirt over the head.
 */
export function inertialGravity(ax: number, ay: number, worldPerPx: number, limit: number): [number, number] {
  let gx = -ax * worldPerPx;
  let gy = ay * worldPerPx;
  const m = Math.hypot(gx, gy);
  if (m > limit) {
    gx *= limit / m;
    gy *= limit / m;
  }
  return [gx, gy];
}

/** Leaning while carried: the upper body trails behind the motion, the head looks down a little. */
export function carryPose(vx: number, vy: number): Pose {
  const p = ZERO_POSE();
  const lean = Math.max(-1, Math.min(1, vx / 1500));
  p.upper[2] = 8 * D * lean;
  p.head[2] = -4 * D * lean;
  p.head[0] = 6 * D + 4 * D * Math.max(-1, Math.min(1, vy / 1500));
  return p;
}
