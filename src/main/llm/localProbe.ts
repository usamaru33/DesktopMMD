// "Which AI suits this PC?": hardware detection + a recommendation (pure, so it is unit-tested).
// Thresholds come from the Qwen3 measurements on a 12 GB GPU: 8B ran at ~76 tok/s, 14B spilled to CPU (~7 tok/s)
// once other apps held 3.6 GB of VRAM, so 12 GB is the ceiling for 8B-class models.
import { execFile } from 'node:child_process';
import os from 'node:os';
import type { LocalHardware, LocalRecommendation } from '@shared/types';

export function recommendLocal(hw: Pick<LocalHardware, 'vramGb' | 'ramGb'>): LocalRecommendation {
  const v = hw.vramGb;
  if (v === null) {
    return { level: 'api', model: null, message: 'NVIDIA GPU が見つかりません。ローカルのAIはCPUだと遅いので、Claude API をおすすめします。' };
  }
  if (v >= 10) return { level: 'good', model: 'qwen3:8b', message: `VRAM ${v}GB なら 8B 級が快適に動きます（実測 約76 tok/s）。` };
  if (v >= 7) return { level: 'ok', model: 'qwen3:8b', message: `VRAM ${v}GB だと 8B 級はぎりぎりです。VOICEVOX と同じGPUを使うと遅くなることがあります。` };
  if (v >= 5) return { level: 'light', model: 'qwen3:4b', message: `VRAM ${v}GB なら 4B 級までです（未検証）。返答の質は下がります。` };
  return { level: 'api', model: null, message: `VRAM ${v}GB ではローカルのAIは厳しいので、Claude API をおすすめします。` };
}

function nvidiaSmi(): Promise<{ name: string; vramGb: number } | null> {
  return new Promise((resolve) => {
    execFile('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], { timeout: 4000, windowsHide: true }, (err, out) => {
      if (err) return resolve(null);
      const [name, mib] = String(out).split('\n')[0].split(',').map((s) => s.trim());
      const gb = Number(mib) / 1024;
      resolve(name && Number.isFinite(gb) ? { name, vramGb: Math.round(gb * 10) / 10 } : null);
    });
  });
}

export async function detectHardware(): Promise<LocalHardware> {
  const gpu = await nvidiaSmi();
  return { ramGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10, gpuName: gpu?.name ?? null, vramGb: gpu?.vramGb ?? null };
}
