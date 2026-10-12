import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TOUCH_LINES,
  sanitizeTouchLines,
  TOUCH_KEYS,
  TOUCH_MANY_TAPS,
  TOUCH_PAT_COOLDOWN_MS,
  TOUCH_TAP_COOLDOWN_MS,
  TouchLineLibrary,
  touchLinesKey,
  TouchReactor,
} from '../../src/main/character/touchLines';

const lines = DEFAULT_TOUCH_LINES;
const texts = (group: 'polite' | 'close', key: keyof typeof lines.polite) => lines[group][key].map((l) => l.text);

describe('TouchReactor', () => {
  it('picks a line for the part and the affinity stage', () => {
    const r = new TouchReactor(() => 0);
    expect(texts('polite', 'cheek')).toContain(r.react('cheek', 'tap', 0, lines, 0)!.text);
    expect(texts('close', 'legs')).toContain(r.react('legs', 'tap', 3, lines, 10_000)!.text);
    expect(texts('close', 'head_pat')).toContain(r.react('head', 'pat', 2, lines, 20_000)!.text);
  });

  it('stays quiet during the cooldown, longer for stroking', () => {
    const r = new TouchReactor(() => 0);
    expect(r.react('hand', 'tap', 0, lines, 0)).not.toBeNull();
    expect(r.react('hand', 'tap', 0, lines, TOUCH_TAP_COOLDOWN_MS - 1)).toBeNull();
    expect(r.react('hand', 'tap', 0, lines, TOUCH_TAP_COOLDOWN_MS * 3)).not.toBeNull();
    const p = new TouchReactor(() => 0);
    expect(p.react('head', 'pat', 0, lines, 0)).not.toBeNull();
    expect(p.react('head', 'pat', 0, lines, TOUCH_TAP_COOLDOWN_MS + 1)).toBeNull();
    expect(p.react('head', 'pat', 0, lines, TOUCH_PAT_COOLDOWN_MS + 1)).not.toBeNull();
  });

  it('a stroke right after a poke still gets its line (the long gap is only between stroke lines)', () => {
    const r = new TouchReactor(() => 0);
    expect(r.react('body', 'tap', 0, lines, 0)).not.toBeNull();
    expect(r.react('head', 'pat', 0, lines, TOUCH_TAP_COOLDOWN_MS + 1)).not.toBeNull();
  });

  it('answers repeated pokes with a "stop it" line, even during the cooldown', () => {
    const r = new TouchReactor(() => 0);
    let last = null;
    for (let i = 0; i < TOUCH_MANY_TAPS; i++) last = r.react('body', 'tap', 0, lines, i * 500);
    expect(texts('polite', 'many')).toContain(last!.text);
  });

  it('does not repeat the same line back to back', () => {
    const r = new TouchReactor(() => 0);
    const said = [0, 1, 2].map((i) => r.react('shoulder', 'tap', 0, lines, i * 10_000)!.text);
    expect(new Set(said).size).toBe(3);
  });
});

describe('generated touch lines', () => {
  const good = (n: number) => Array.from({ length: n }, (_, i) => ({ emotion: 'happy', text: `セリフ${i}です。` }));

  it('keeps usable lines and fills thin scenes with the defaults', () => {
    const raw = { polite: Object.fromEntries(TOUCH_KEYS.map((k) => [k, good(3)])), close: { head: good(1) } };
    const s = sanitizeTouchLines(raw)!;
    expect(s.polite.cheek.map((l) => l.text)).toEqual(['セリフ0です。', 'セリフ1です。', 'セリフ2です。']);
    expect(s.close.head).toBe(DEFAULT_TOUCH_LINES.close.head);
  });

  it('drops bad emotions, tags, overlong and duplicate lines', () => {
    const raw = {
      polite: {
        head: [
          { emotion: 'happy', text: '[happy:0.8]やったー' },
          { emotion: 'excited', text: 'だめな感情' },
          { emotion: 'shy', text: 'あ'.repeat(80) },
          { emotion: 'shy', text: 'やったー' },
          { emotion: 'shy', text: 'えへへ' },
        ],
      },
    };
    expect(sanitizeTouchLines(raw)!.polite.head.map((l) => l.text)).toEqual(['やったー', 'えへへ']);
    expect(sanitizeTouchLines({})).toBeNull();
    expect(sanitizeTouchLines('x')).toBeNull();
  });

  it('drops happy lines for the legs and for repeated pokes', () => {
    const raw = { polite: { legs: [{ emotion: 'happy', text: 'もっと触って' }, { emotion: 'shy', text: 'だめです' }, { emotion: 'troubled', text: 'やめてください' }] } };
    expect(sanitizeTouchLines(raw)!.polite.legs.map((l) => l.text)).toEqual(['だめです', 'やめてください']);
  });

  it('rejects a flat, all-alike answer (keeps the defaults instead)', () => {
    const flat = (k: string) => [0, 1, 2].map((i) => ({ emotion: 'neutral', text: `${k}を触られたの、少し困っています${i}。` }));
    const raw = Object.fromEntries((['polite', 'close'] as const).map((g) => [g, Object.fromEntries(TOUCH_KEYS.map((k) => [k, flat(k)]))]));
    expect(sanitizeTouchLines(raw)).toBeNull();
  });

  it('caches per persona and does not retry a failed generation', async () => {
    const saved: unknown[] = [];
    const generate = vi.fn(async () => ({ polite: { head: good(3) } }));
    const lib = new TouchLineLibrary({ load: () => undefined, save: (c) => saved.push(c), generate, log: { info() {}, warn() {} } });
    expect(lib.get('A')).toBe(DEFAULT_TOUCH_LINES); // defaults right away
    await vi.waitFor(() => expect(saved.length).toBe(1));
    expect(lib.get('A').polite.head[0].text).toBe('セリフ0です。');
    expect(Object.keys(saved[0] as object)).toEqual([touchLinesKey('A')]);

    const failing = vi.fn(async () => {
      throw new Error('down');
    });
    const lib2 = new TouchLineLibrary({ load: () => undefined, save: () => {}, generate: failing, log: { info() {}, warn() {} } });
    lib2.get('B');
    await vi.waitFor(() => expect(failing).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0));
    lib2.get('B');
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it('reads the saved cache and skips generation without an LLM', () => {
    const key = touchLinesKey('A');
    const lib = new TouchLineLibrary({ load: () => ({ [key]: { polite: { cheek: good(2) } } }), save: () => {}, generate: () => null, log: { info() {}, warn() {} } });
    expect(lib.get('A').polite.cheek).toHaveLength(2);
    expect(lib.get('other')).toBe(DEFAULT_TOUCH_LINES);
  });
});
