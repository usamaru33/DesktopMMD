// サンプル音声に近い VOICEVOX / AivisSpeech の声と調声（話速・音高・抑揚）を探す。
//   1. 候補のスタイルで短い文を既定値のまま合成し、声色（MFCC）と地声の高さの近さでふるい分ける
//   2. 上位のスタイルごとに、合成→測定→補正 を繰り返して 話速・音高・抑揚 を合わせる
//      （同じ解析器で合成音も測るので、解析のくせは両方に同じように乗って打ち消し合う）
import { clampBase } from './voiceTuning';
import { analyzeVoice, semitones, timbreDistance, type VoiceFeatures } from './voiceAnalysis';
import type { FitCandidate, FitParams, VoiceBase } from '@shared/types';

export type { FitCandidate, FitParams };


export interface FitStyle {
  id: number;
  label: string;
}


export interface FitProgress {
  phase: 'screen' | 'fit';
  done: number;
  total: number;
  label: string;
}

/** text をそのスタイル・調声で合成した音声（モノラル） */
export type FitSynth = (styleId: number, text: string, params: FitParams) => Promise<{ samples: Float32Array; sr: number }>;

/**
 * 自動調声で使う範囲。人の声は VOICEVOX より抑揚が大きく間も長いので、測った比のままだと
 * 抑揚 1.8・話速 0.65 のような値になり、高い音がかすれたり間延びしたりする。自然に聞こえる範囲で止める。
 */
export const FIT_LIMITS = {
  speed: [0.75, 1.5] as const,
  pitch: [-0.08, 0.08] as const,
  intonation: [0.6, 1.5] as const,
};

/** 声色の差に加える、地声の高さの差1半音あたりの罰点（大きく高さを変えると不自然になるため） */
const PITCH_PENALTY = 0.12;
/** score = 100·exp(-距離/SCORE_SCALE) */
const SCORE_SCALE = 6;

export const DEFAULT_FIT: FitParams = { speedScale: 1, pitchScale: 0, intonationScale: 1 };

const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : (lo + hi) / 2));
const round3 = (v: number) => Math.round(v * 1000) / 1000;

function clampFit(p: FitParams): FitParams {
  return {
    speedScale: round3(clamp(p.speedScale, FIT_LIMITS.speed)),
    pitchScale: round3(clamp(p.pitchScale, FIT_LIMITS.pitch)),
    intonationScale: round3(clamp(p.intonationScale, FIT_LIMITS.intonation)),
  };
}

/**
 * VOICEVOX は音高を「ln F0 × 2^pitchScale」で変える。その式で最初の見当を付ける（実際の値は測って直す）。
 */
export function guessPitchScale(fromHz: number, toHz: number): number {
  if (fromHz <= 1 || toHz <= 1) return 0;
  return Math.log2(Math.log(toHz) / Math.log(fromHz));
}

/** 合成音 a（既定値）と b（params で合成）の測定値から、目標に近づくように params を直す */
export function refine(target: VoiceFeatures, a: VoiceFeatures, b: VoiceFeatures, params: FitParams, matchSpeed: boolean): FitParams {
  // 音高: (0, ln a.f0) と (ps, ln b.f0) を通る直線で目標の ln F0 になる ps を求める
  let ps = params.pitchScale;
  const la = Math.log(a.f0Hz);
  const lb = Math.log(b.f0Hz);
  const lt = Math.log(target.f0Hz);
  if (Math.abs(ps) > 1e-4 && Math.abs(lb - la) > 1e-4) ps = (ps * (lt - la)) / (lb - la);
  else ps += guessPitchScale(b.f0Hz, target.f0Hz);
  const it = b.logF0Std > 1e-4 ? params.intonationScale * (target.logF0Std / b.logF0Std) : params.intonationScale;
  const sp = matchSpeed && target.activeSec > 0 ? params.speedScale * (b.activeSec / target.activeSec) : params.speedScale;
  return clampFit({ speedScale: sp, pitchScale: ps, intonationScale: it });
}

/** 1スタイルについて 話速・音高・抑揚 を合わせる（合成3回） */
export async function fitStyle(
  synth: FitSynth,
  styleId: number,
  text: string,
  target: VoiceFeatures,
  matchSpeed: boolean,
  check: () => void = () => {},
  fixPitch = false,
): Promise<{ params: FitParams; base: VoiceFeatures; result: VoiceFeatures }> {
  const lock = (p: FitParams): FitParams => (fixPitch ? { ...p, pitchScale: 0 } : p);
  const measure = async (p: FitParams) => {
    check();
    const w = await synth(styleId, text, p);
    return analyzeVoice(w.samples, w.sr, target.noise);
  };
  const a = await measure(DEFAULT_FIT);
  if (a.voicedFrames < 10) throw new Error('有声音がほとんど無いスタイルです');
  const p1 = lock(clampFit({
    speedScale: matchSpeed && target.activeSec > 0 ? a.activeSec / target.activeSec : 1,
    pitchScale: guessPitchScale(a.f0Hz, target.f0Hz),
    intonationScale: a.logF0Std > 1e-4 ? target.logF0Std / a.logF0Std : 1,
  }));
  const b = await measure(p1);
  const p2 = lock(refine(target, a, b, p1, matchSpeed));
  const c = await measure(p2);
  return { params: p2, base: a, result: c };
}

export function scoreOf(target: VoiceFeatures, natural: VoiceFeatures, fitted: VoiceFeatures): { dist: number; score: number } {
  const dist = timbreDistance(target, fitted) + PITCH_PENALTY * Math.abs(semitones(natural.f0Hz, target.f0Hz));
  return { dist, score: Math.round(100 * Math.exp(-dist / SCORE_SCALE)) };
}

export interface AutoTuneOptions {
  synth: FitSynth;
  styles: FitStyle[];
  target: VoiceFeatures;
  /** サンプルで話している内容。空なら話速は合わせない */
  text: string;
  /** ふるい分けで残すスタイルの数 */
  topN?: number;
  onProgress?(p: FitProgress): void;
  signal?: AbortSignal;
  /** 音高は変えない（AivisSpeech は音高を変えると音質が落ちる） */
  fixPitch?: boolean;
}

const FALLBACK_TEXT = 'こんにちは。今日もよろしくお願いします。';

/** ふるい分け用の短い文（書き起こしの先頭40文字くらい、文の切れ目で切る） */
export function screenText(text: string): string {
  const t = text.trim();
  if (t.length < 8) return FALLBACK_TEXT;
  if (t.length <= 40) return t;
  const cut = t.slice(0, 48);
  const m = cut.match(/^.{8,}?[。！？!?]/);
  return m ? m[0] : t.slice(0, 40);
}

export async function autoTune(o: AutoTuneOptions): Promise<FitCandidate[]> {
  const check = () => {
    if (o.signal?.aborted) throw new DOMException('中止しました', 'AbortError');
  };
  if (o.target.voicedFrames < 20) throw new Error('サンプルから声の高さを読み取れませんでした。BGMや雑音の少ない、話し声だけの音声を使ってください');
  const st = screenText(o.text);
  const screened: { style: FitStyle; f: VoiceFeatures; dist: number }[] = [];
  for (const [i, style] of o.styles.entries()) {
    check();
    o.onProgress?.({ phase: 'screen', done: i, total: o.styles.length, label: style.label });
    try {
      const w = await o.synth(style.id, st, DEFAULT_FIT);
      const f = analyzeVoice(w.samples, w.sr, o.target.noise);
      if (f.voicedFrames < 10) continue; // ささやき等
      screened.push({ style, f, dist: timbreDistance(o.target, f) + PITCH_PENALTY * Math.abs(semitones(f.f0Hz, o.target.f0Hz)) });
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      /* 合成できないスタイルは飛ばす */
    }
  }
  screened.sort((a, b) => a.dist - b.dist);
  const top = screened.slice(0, o.topN ?? 3);
  const text = o.text.trim() || FALLBACK_TEXT;
  const matchSpeed = !!o.text.trim();
  const out: FitCandidate[] = [];
  for (const [i, s] of top.entries()) {
    o.onProgress?.({ phase: 'fit', done: i, total: top.length, label: s.style.label });
    try {
      const r = await fitStyle(o.synth, s.style.id, text, o.target, matchSpeed, check, o.fixPitch);
      const { score } = scoreOf(o.target, r.base, r.result);
      out.push({
        styleId: s.style.id,
        label: s.style.label,
        params: r.params,
        score,
        result: { f0Hz: r.result.f0Hz, logF0Std: r.result.logF0Std, activeSec: r.result.activeSec },
      });
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
    }
  }
  check();
  o.onProgress?.({ phase: 'fit', done: top.length, total: top.length, label: '' });
  return out.sort((a, b) => b.score - a.score);
}

/** 候補を調声の基本値に反映した値（音量・間などは今の値のまま） */
export function applyFit(base: VoiceBase, p: FitParams): VoiceBase {
  return clampBase({ ...base, ...p });
}
