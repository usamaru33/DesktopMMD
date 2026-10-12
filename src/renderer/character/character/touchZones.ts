// Where on the body a click / stroke landed (FR-EX-05), from the bones' screen positions. Pure; no three.js.
import type { TouchPart } from '@shared/types';

export interface ScreenPt {
  x: number;
  y: number;
}

/** Bone positions in window CSS px (y down). Missing bones are null / left out. */
export interface TouchPoints {
  /** between the eyes (or an estimate from the head bone) */
  face: ScreenPt;
  neck: ScreenPt | null;
  hands: ScreenPt[];
  shoulders: ScreenPt[];
  /** 下半身 (the waist) */
  hips: ScreenPt | null;
}

const dist = (a: ScreenPt, b: ScreenPt) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Size of the face on screen: eyes → neck, which scales with the window and zoom. Falls back to a share of
 * the window height for models without a neck bone.
 */
export function faceUnit(pts: TouchPoints, viewHeight: number): number {
  const u = pts.neck ? dist(pts.face, pts.neck) : 0;
  return u > 4 ? u : viewHeight * 0.05;
}

/** The click (already known to be on the model) → the part touched. Hands win over everything they overlap. */
export function classifyTouch(p: ScreenPt, pts: TouchPoints, unit: number): TouchPart {
  if (pts.hands.some((h) => dist(p, h) < unit * 0.8)) return 'hand';
  if (dist(p, pts.face) < unit * 1.6) return p.y < pts.face.y - unit * 0.2 ? 'head' : 'cheek';
  if (p.y < pts.face.y) return 'head'; // hair above the face, further out
  if (pts.shoulders.some((s) => dist(p, s) < unit * 0.8)) return 'shoulder';
  if (pts.hips && p.y > pts.hips.y + unit * 0.6) return 'legs';
  return 'body';
}

/** Which side of the body the point is on, as the character's side (her right is the viewer's left). */
export function sideOf(p: ScreenPt, pts: TouchPoints): 1 | -1 {
  return p.x < pts.face.x ? 1 : -1;
}

/**
 * Stroking detection: the cursor moving back and forth over the head (no click). Reversals of the
 * horizontal direction within a short window count as strokes.
 */
export class PatDetector {
  private lastX: number | null = null;
  private dir = 0;
  private travel = 0;
  private reversals: number[] = [];
  private lastStroke = Number.NEGATIVE_INFINITY;
  active = false;

  constructor(
    /** minimum movement (px) in one direction to count as a stroke */
    private readonly minTravel = 12,
    private readonly needed = 3,
    private readonly windowSec = 1.6,
    private readonly releaseSec = 0.9,
  ) {}

  /** Feed a cursor sample over the head. Returns 'start' when stroking begins. */
  move(x: number, t: number): 'start' | null {
    if (this.lastX !== null) {
      const dx = x - this.lastX;
      const d = Math.sign(dx);
      if (d !== 0) {
        if (d === this.dir) this.travel += Math.abs(dx);
        else {
          if (this.dir !== 0 && this.travel >= this.minTravel) {
            this.reversals.push(t);
            this.lastStroke = t;
          }
          this.dir = d;
          this.travel = Math.abs(dx);
        }
      }
    }
    this.lastX = x;
    this.reversals = this.reversals.filter((r) => t - r < this.windowSec);
    if (!this.active && this.reversals.length >= this.needed) {
      this.active = true;
      return 'start';
    }
    return null;
  }

  /** The cursor left the head (or the model). */
  leave(): void {
    this.lastX = null;
    this.dir = 0;
    this.travel = 0;
  }

  /** Call every so often: true when stroking just stopped. */
  tick(t: number): boolean {
    if (this.active && t - this.lastStroke > this.releaseSec) {
      this.active = false;
      this.reversals = [];
      return true;
    }
    return false;
  }
}
