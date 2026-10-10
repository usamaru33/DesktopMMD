// Prints median / p90 latencies from %APPDATA%\mmd-assistant\assistant.db (NFR-01/02).
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'mmd-assistant', 'assistant.db'), { readOnly: true });
const rows = db.prepare('SELECT * FROM latency ORDER BY id DESC LIMIT 500').all() as Record<string, string | number | null>[];

function stats(name: string, values: (string | number | null)[]) {
  const v = values.filter((x): x is number => typeof x === 'number' && x >= 0).sort((a, b) => a - b);
  if (!v.length) return console.log(`${name.padEnd(28)} (no data)`);
  const q = (p: number) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
  console.log(`${name.padEnd(28)} n=${String(v.length).padStart(4)}  median=${String(q(0.5)).padStart(5)}ms  p90=${String(q(0.9)).padStart(5)}ms`);
}

const turns = rows.filter((r) => r.source !== 'audio');
const audio = rows.filter((r) => String(r.source).startsWith('audio'));
stats('text: send → first token', turns.filter((r) => r.source === 'text').map((r) => r.first_token_ms));
stats('text: send → first sentence', turns.filter((r) => r.source === 'text').map((r) => r.first_sentence_ms));
stats('voice: speech end → transcript', turns.filter((r) => r.source === 'voice').map((r) => r.transcript_ms));
stats('voice: speech end → first audio', audio.filter((r) => r.source === 'audio:voice').map((r) => r.first_audio_ms));
stats('text: send → first audio', audio.filter((r) => r.source === 'audio:text').map((r) => r.first_audio_ms));
console.log('\nTargets: speech end → first audio ≤ 2500 ms (NFR-01), text → first text ≤ 1500 ms (NFR-02)');
