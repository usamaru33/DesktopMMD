// 声の特徴量（サンプル音声からの自動調声用）。I/O なしの純粋関数だけを置く。
//   - 声の高さ: YIN で基本周波数（F0）を出し、有声フレームの中央値
//   - 抑揚: ln F0 の標準偏差（VOICEVOX の intonationScale は ln F0 の平均からのずれを何倍にするか、なので同じ尺度）
//   - 話す速さ: 音量のしきい値を超えている時間（無音・息継ぎを除いた発話の長さ）。同じ文で比べる
//   - 声色: MFCC（c1〜c12）の平均。声道の形（大人/子ども、性別、こもり具合）をおおまかに表す

export const ANALYSIS_SR = 16_000;
const FRAME = 400; // 25ms
const HOP = 160; // 10ms
const NFFT = 512;
const NMEL = 26;
const NCEP = 12;

export interface VoiceFeatures {
  /** 有声フレームの F0 の中央値（Hz）。有声が無ければ 0 */
  f0Hz: number;
  /** ln F0 の標準偏差（抑揚の大きさ） */
  logF0Std: number;
  /** 発話している時間（秒） */
  activeSec: number;
  /** 全体の長さ（秒） */
  totalSec: number;
  voicedFrames: number;
  /** MFCC c1..c12 の平均（有声フレーム） */
  mfcc: number[];
  /** この音声の雑音と声の大きさ（合成音の解析に渡して条件をそろえる） */
  noise: NoiseRef;
}

// ---------------------------------------------------------------- WAV / resample

/** 16bit PCM / 32bit float の WAV をモノラルの Float32Array にする（VOICEVOX の出力用） */
export function decodeWav(buf: ArrayBuffer): { samples: Float32Array; sr: number } {
  const v = new DataView(buf);
  if (buf.byteLength < 44 || v.getUint32(0, false) !== 0x52494646 || v.getUint32(8, false) !== 0x57415645) throw new Error('WAVではありません');
  let off = 12;
  let fmt: { format: number; channels: number; sr: number; bits: number } | null = null;
  while (off + 8 <= buf.byteLength) {
    const id = v.getUint32(off, false);
    const size = v.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 0x666d7420) {
      fmt = { format: v.getUint16(body, true), channels: v.getUint16(body + 2, true), sr: v.getUint32(body + 4, true), bits: v.getUint16(body + 14, true) };
    } else if (id === 0x64617461) {
      if (!fmt) throw new Error('WAVの形式情報がありません');
      const bytes = fmt.bits / 8;
      const len = Math.min(size, buf.byteLength - body);
      const frames = Math.floor(len / (bytes * fmt.channels));
      const out = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let s = 0;
        for (let c = 0; c < fmt.channels; c++) {
          const p = body + (i * fmt.channels + c) * bytes;
          if (fmt.format === 3 && fmt.bits === 32) s += v.getFloat32(p, true);
          else if (fmt.bits === 16) s += v.getInt16(p, true) / 32768;
          else throw new Error(`未対応のWAV形式です（${fmt.bits}bit）`);
        }
        out[i] = s / fmt.channels;
      }
      return { samples: out, sr: fmt.sr };
    }
    off = body + size + (size % 2);
  }
  throw new Error('WAVのデータが見つかりません');
}

/** 線形補間のリサンプル。下げるときは先に移動平均で高域を落とす */
export function resample(x: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return x;
  let src = x;
  if (to < from) {
    const k = Math.max(1, Math.round(from / to));
    if (k > 1) {
      src = new Float32Array(x.length);
      let acc = 0;
      for (let i = 0; i < x.length; i++) {
        acc += x[i];
        if (i >= k) acc -= x[i - k];
        src[i] = acc / Math.min(i + 1, k);
      }
    }
  }
  const n = Math.floor((src.length * to) / from);
  const out = new Float32Array(n);
  const r = from / to;
  for (let i = 0; i < n; i++) {
    const p = i * r;
    const j = Math.floor(p);
    const f = p - j;
    out[i] = (src[j] ?? 0) * (1 - f) + (src[j + 1] ?? src[j] ?? 0) * f;
  }
  return out;
}

// ---------------------------------------------------------------- pitch (YIN)

/** YIN で1フレームの F0。周期性が弱ければ 0 */
export function yinPitch(x: Float32Array, start: number, sr: number, w: number, fmin = 65, fmax = 700, threshold = 0.15): number {
  const tauMin = Math.max(2, Math.floor(sr / fmax));
  const tauMax = Math.ceil(sr / fmin);
  if (start + w + tauMax + 1 > x.length) return 0;
  const d = new Float64Array(tauMax + 2);
  for (let tau = 1; tau <= tauMax + 1; tau++) {
    let s = 0;
    for (let j = 0; j < w; j++) {
      const diff = x[start + j] - x[start + j + tau];
      s += diff * diff;
    }
    d[tau] = s;
  }
  // cumulative mean normalized difference
  const cm = new Float64Array(tauMax + 2);
  cm[0] = 1;
  let run = 0;
  for (let tau = 1; tau <= tauMax + 1; tau++) {
    run += d[tau];
    cm[tau] = run > 0 ? (d[tau] * tau) / run : 1;
  }
  let tau = -1;
  for (let t = tauMin; t <= tauMax; t++) {
    if (cm[t] < threshold) {
      while (t + 1 <= tauMax && cm[t + 1] < cm[t]) t++;
      tau = t;
      break;
    }
  }
  if (tau < 0) return 0;
  // parabolic interpolation
  const a = cm[tau - 1];
  const b = cm[tau];
  const c = cm[tau + 1];
  const den = a - 2 * b + c;
  const shift = den !== 0 ? (0.5 * (a - c)) / den : 0;
  const t = tau + (Math.abs(shift) < 1 ? shift : 0);
  return sr / t;
}

// ---------------------------------------------------------------- FFT / MFCC

function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const ai = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k + len / 2] = re[i + k] - ar;
        im[i + k + len / 2] = im[i + k] - ai;
        re[i + k] += ar;
        im[i + k] += ai;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

const hz2mel = (f: number) => 2595 * Math.log10(1 + f / 700);
const mel2hz = (m: number) => 700 * (10 ** (m / 2595) - 1);

let melBank: Float64Array[] | null = null;
let hamming: Float64Array | null = null;

function melFilters(): Float64Array[] {
  if (melBank) return melBank;
  const lo = hz2mel(80);
  const hi = hz2mel(7600);
  const pts = Array.from({ length: NMEL + 2 }, (_, i) => Math.floor(((NFFT + 1) * mel2hz(lo + ((hi - lo) * i) / (NMEL + 1))) / ANALYSIS_SR));
  melBank = [];
  for (let m = 1; m <= NMEL; m++) {
    const f = new Float64Array(NFFT / 2 + 1);
    for (let k = pts[m - 1]; k < pts[m]; k++) f[k] = (k - pts[m - 1]) / Math.max(1, pts[m] - pts[m - 1]);
    for (let k = pts[m]; k <= pts[m + 1]; k++) f[k] = (pts[m + 1] - k) / Math.max(1, pts[m + 1] - pts[m]);
    melBank.push(f);
  }
  return melBank;
}

function powerSpectrum(x: Float32Array, start: number): Float64Array {
  hamming ??= Float64Array.from({ length: FRAME }, (_, i) => 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (FRAME - 1)));
  const re = new Float64Array(NFFT);
  const im = new Float64Array(NFFT);
  for (let i = 0; i < FRAME; i++) re[i] = (x[start + i] - 0.97 * (x[start + i - 1] ?? 0)) * hamming[i]; // pre-emphasis
  fftInPlace(re, im);
  const pow = new Float64Array(NFFT / 2 + 1);
  for (let k = 0; k <= NFFT / 2; k++) pow[k] = re[k] * re[k] + im[k] * im[k];
  return pow;
}

function mfccOf(pow: ArrayLike<number>): number[] {
  const logMel = melFilters().map((f) => {
    let e = 0;
    for (let k = 0; k < f.length; k++) e += f[k] * pow[k];
    return Math.log(e + 1e-10);
  });
  const out: number[] = [];
  for (let c = 1; c <= NCEP; c++) {
    let s = 0;
    for (let m = 0; m < NMEL; m++) s += logMel[m] * Math.cos((Math.PI * c * (m + 0.5)) / NMEL);
    out.push(s * Math.sqrt(2 / NMEL));
  }
  return out;
}

const sumOf = (a: ArrayLike<number>) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return s;
};

// ---------------------------------------------------------------- features

const median = (a: number[]) => {
  if (!a.length) return 0;
  const s = [...a].sort((p, q) => p - q);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * 解析の条件をそろえるための、サンプル側の雑音と声の大きさ。
 * 合成音を解析するときにこれを渡すと、声の大きさをサンプルにそろえてから同じ雑音を足して MFCC を取る
 * （雑音は声色の特徴を大きく変えるので、比べる両方に同じだけ乗せる）。
 */
export interface NoiseRef {
  /** 無音区間の平均パワースペクトル（雑音が無ければ0） */
  noisePow: number[];
  /** 有声フレームの平均パワー */
  speechPow: number;
  /** 発話とみなした音量のしきい値が、ピークから何dB下だったか（話す速さを同じ基準で測るため） */
  gateBelowPeak: number;
}

export function analyzeVoice(samples: Float32Array, sr: number, ref?: NoiseRef): VoiceFeatures {
  const x = resample(samples, sr, ANALYSIS_SR);
  const nFrames = Math.max(0, Math.floor((x.length - FRAME) / HOP) + 1);
  const db = new Float64Array(nFrames);
  for (let f = 0; f < nFrames; f++) {
    let s = 0;
    for (let i = 0; i < FRAME; i++) s += x[f * HOP + i] ** 2;
    db[f] = 10 * Math.log10(s / FRAME + 1e-12);
  }
  const sorted = [...db].sort((a, b) => a - b);
  const peak = sorted[Math.floor(sorted.length * 0.95)] ?? -120;
  const floor = sorted[Math.floor(sorted.length * 0.05)] ?? -120;
  // 発話とみなす音量: ピークから35dB下まで。ただし雑音があればその少し上から
  const gate = ref ? peak - ref.gateBelowPeak : Math.min(peak - 12, Math.max(peak - 35, floor + 8, -65));

  // pitch on an 8 kHz copy (4x cheaper; F0 < 700 Hz)
  const x8 = resample(x, ANALYSIS_SR, 8000);
  const logs: number[] = [];
  const voicedIdx: number[] = [];
  const silentIdx: number[] = [];
  let active = 0;
  for (let f = 0; f < nFrames; f++) {
    if (db[f] <= gate) {
      silentIdx.push(f);
      continue;
    }
    active++;
    const f0 = yinPitch(x8, (f * HOP) >> 1, 8000, FRAME >> 1);
    if (f0 > 0) {
      logs.push(Math.log(f0));
      voicedIdx.push(f);
    }
  }
  // drop octave errors: keep frames within ±0.85 octave of the median
  const med0 = median(logs);
  const keep = logs.map((l, i) => [l, voicedIdx[i]] as const).filter(([l]) => Math.abs(l - med0) < 0.6);
  const kl = keep.map(([l]) => l);
  const mean = kl.reduce((a, b) => a + b, 0) / (kl.length || 1);
  const std = kl.length > 1 ? Math.sqrt(kl.reduce((a, b) => a + (b - mean) ** 2, 0) / (kl.length - 1)) : 0;

  const spectra = keep.map(([, f]) => powerSpectrum(x, f * HOP));
  const speechPow = spectra.length ? spectra.reduce((a, p) => a + sumOf(p), 0) / spectra.length : 0;
  const noisePow = new Array<number>(NFFT / 2 + 1).fill(0);
  if (silentIdx.length >= 5) {
    for (const f of silentIdx) {
      const p = powerSpectrum(x, f * HOP);
      for (let k = 0; k < p.length; k++) noisePow[k] += p[k] / silentIdx.length;
    }
  }
  const scale = ref && speechPow > 0 ? ref.speechPow / speechPow : 1;
  const mf = new Array<number>(NCEP).fill(0);
  for (const pow of spectra) {
    if (ref) for (let k = 0; k < pow.length; k++) pow[k] = pow[k] * scale + (ref.noisePow[k] ?? 0);
    const c = mfccOf(pow);
    for (let i = 0; i < NCEP; i++) mf[i] += c[i];
  }
  return {
    f0Hz: kl.length ? Math.exp(median(kl)) : 0,
    logF0Std: std,
    activeSec: (active * HOP) / ANALYSIS_SR,
    totalSec: x.length / ANALYSIS_SR,
    voicedFrames: kl.length,
    mfcc: mf.map((v) => v / (spectra.length || 1)),
    noise: { noisePow, speechPow, gateBelowPeak: peak - gate },
  };
}

/** 半音での差（a が b より何半音高いか） */
export const semitones = (a: number, b: number) => (a > 0 && b > 0 ? 12 * Math.log2(a / b) : 0);

/** 声色の距離（MFCC 平均のユークリッド距離） */
export function timbreDistance(a: VoiceFeatures, b: VoiceFeatures): number {
  let s = 0;
  for (let i = 0; i < NCEP; i++) s += ((a.mfcc[i] ?? 0) - (b.mfcc[i] ?? 0)) ** 2;
  return Math.sqrt(s);
}
