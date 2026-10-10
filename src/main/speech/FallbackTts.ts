// Windows built-in voice via System.Speech (spec 5.6: VOICEVOXに接続できないとき). Produces a WAV buffer.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class FallbackTts {
  private voiceName: string | null = null;

  /** rate: VOICEVOX-like speed (1.0 normal) → SAPI rate -10..10 */
  async synthesize(text: string, opts: { speed: number; volume: number }, signal?: AbortSignal): Promise<ArrayBuffer> {
    const file = path.join(os.tmpdir(), `mmd-tts-${randomUUID()}.wav`);
    const rate = Math.max(-10, Math.min(10, Math.round((opts.speed - 1) * 10)));
    const vol = Math.max(0, Math.min(100, Math.round(opts.volume * 100)));
    const script = [
      'Add-Type -AssemblyName System.Speech',
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
      // prefer a Japanese voice (Haruka / Ayumi / Ichiro)
      "$v = $s.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -eq 'ja-JP' } | Select-Object -First 1",
      'if ($v) { $s.SelectVoice($v.VoiceInfo.Name) }',
      `$s.Rate = ${rate}`,
      `$s.Volume = ${vol}`,
      `$s.SetOutputToWaveFile('${file.replace(/'/g, "''")}')`,
      `$t = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${Buffer.from(text, 'utf8').toString('base64')}'))`,
      '$s.Speak($t)',
      '$s.Dispose()',
    ].join('; ');
    await new Promise<void>((resolve, reject) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
      const kill = () => child.kill();
      signal?.addEventListener('abort', kill, { once: true });
      let err = '';
      child.stderr.on('data', (d) => (err += d.toString()));
      child.on('close', (code) => {
        signal?.removeEventListener('abort', kill);
        if (code === 0) resolve();
        else reject(new Error(`System.Speech failed (${code}): ${err.slice(0, 200)}`));
      });
      child.on('error', reject);
    });
    try {
      const buf = fs.readFileSync(file);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    } finally {
      fs.rmSync(file, { force: true });
    }
  }

  get name(): string | null {
    return this.voiceName;
  }
}
