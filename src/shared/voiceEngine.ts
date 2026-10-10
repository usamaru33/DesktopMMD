// 読み上げエンジンの種類。AivisSpeech は VOICEVOX 互換の API だが、モーラの長さと高さを返さない（口パクは音量で動かす）。

export type EngineKind = 'voicevox' | 'aivis';

export const ENGINE_PRESETS: Record<EngineKind, { label: string; url: string; port: number; termsUrl: string }> = {
  voicevox: { label: 'VOICEVOX', url: 'http://127.0.0.1:50021', port: 50021, termsUrl: 'https://voicevox.hiroshiba.jp/term/' },
  aivis: { label: 'AivisSpeech', url: 'http://127.0.0.1:10101', port: 10101, termsUrl: 'https://aivis-project.com/' },
};

/** URL だけから推す（AivisSpeech の既定ポートなら aivis） */
export function engineKindFromUrl(url: string): EngineKind {
  try {
    return Number(new URL(url).port) === ENGINE_PRESETS.aivis.port ? 'aivis' : 'voicevox';
  } catch {
    return 'voicevox';
  }
}

/** engine_manifest の name（取れなければ空）と URL から決める */
export function engineKind(name: string, url: string): EngineKind {
  if (/aivis/i.test(name)) return 'aivis';
  if (name) return 'voicevox';
  return engineKindFromUrl(url);
}
