// 読み上げ音声の再生前にかける音質フィルター（キャラクター画面と調声画面の試聴で共通）。
//   soft: 耳障りな高域（3kHz 前後のギラつき・8kHz より上のザラつき）を少し削り、軽く圧縮して音量をそろえる
//   room: soft に、ごく短い残響を少しだけ足す（スピーカーから「部屋で話している」感じに近づける）
import type { VoiceFilter } from '@shared/types';

export interface VoiceChain {
  /** 音源はここにつなぐ */
  input: AudioNode;
  /** ここから先をスピーカーへ（口パク用の解析もここから取る） */
  output: AudioNode;
  set(mode: VoiceFilter): void;
}

/** 小さな部屋の残響（ノイズを指数で減衰させたもの） */
function roomImpulse(ctx: BaseAudioContext, seconds = 0.35): AudioBuffer {
  const len = Math.round(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  const pre = Math.round(ctx.sampleRate * 0.008);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = pre; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.exp((-6.9 * (i - pre)) / (len - pre));
  }
  return buf;
}

export function createVoiceChain(ctx: BaseAudioContext, mode: VoiceFilter = 'soft'): VoiceChain {
  const input = ctx.createGain();
  const harsh = ctx.createBiquadFilter();
  harsh.type = 'peaking';
  harsh.frequency.value = 3200;
  harsh.Q.value = 1.2;
  const air = ctx.createBiquadFilter();
  air.type = 'highshelf';
  air.frequency.value = 8000;
  const comp = ctx.createDynamicsCompressor();
  comp.knee.value = 12;
  comp.attack.value = 0.005;
  comp.release.value = 0.2;
  const trim = ctx.createGain();
  const wet = ctx.createGain();
  const verb = ctx.createConvolver();
  verb.buffer = roomImpulse(ctx);
  const output = ctx.createGain();

  input.connect(harsh).connect(air).connect(comp).connect(trim).connect(output);
  trim.connect(verb).connect(wet).connect(output);

  const set = (m: VoiceFilter) => {
    const on = m !== 'off';
    harsh.gain.value = on ? -2.5 : 0;
    air.gain.value = on ? -4 : 0;
    comp.threshold.value = on ? -20 : 0;
    comp.ratio.value = on ? 2.5 : 1;
    // 圧縮器は自動で音量を持ち上げるので、割れないように少し下げる
    trim.gain.value = on ? 0.8 : 1;
    wet.gain.value = m === 'room' ? 0.1 : 0;
  };
  set(mode);
  return { input, output, set };
}
