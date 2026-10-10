// Small UI kit for the admin window.
import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';

export function Card(p: { title?: string; desc?: string; actions?: ComponentChildren; children: ComponentChildren; id?: string }) {
  return (
    <section class="card" id={p.id}>
      {(p.title || p.actions) && (
        <header class="card-head">
          <div>
            {p.title && <h2>{p.title}</h2>}
            {p.desc && <p class="muted">{p.desc}</p>}
          </div>
          {p.actions && <div class="row gap">{p.actions}</div>}
        </header>
      )}
      <div class="card-body">{p.children}</div>
    </section>
  );
}

export function Field(p: { label: string; hint?: string; children: ComponentChildren; wide?: boolean }) {
  return (
    <label class={`field ${p.wide ? 'wide' : ''}`}>
      <span class="field-label">{p.label}</span>
      <div class="field-control">{p.children}</div>
      {p.hint && <span class="field-hint">{p.hint}</span>}
    </label>
  );
}

export function Toggle(p: { checked: boolean; onChange(v: boolean): void; label?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      class={`toggle ${p.checked ? 'on' : ''}`}
      role="switch"
      aria-checked={p.checked}
      disabled={p.disabled}
      onClick={() => p.onChange(!p.checked)}
    >
      <span class="knob" />
      {p.label && <span class="toggle-label">{p.label}</span>}
    </button>
  );
}

export function Slider(p: { value: number; min: number; max: number; step: number; onInput(v: number): void; disabled?: boolean; digits?: number; unit?: string }) {
  const digits = p.digits ?? (p.step < 0.1 ? 2 : p.step < 1 ? 1 : 0);
  return (
    <div class="slider">
      <input
        type="range"
        min={p.min}
        max={p.max}
        step={p.step}
        value={p.value}
        disabled={p.disabled}
        onInput={(e) => p.onInput(Number((e.target as HTMLInputElement).value))}
      />
      <input
        type="number"
        class="num"
        min={p.min}
        max={p.max}
        step={p.step}
        value={Number(p.value).toFixed(digits)}
        disabled={p.disabled}
        onChange={(e) => {
          const v = Number((e.target as HTMLInputElement).value);
          if (Number.isFinite(v)) p.onInput(Math.min(p.max, Math.max(p.min, v)));
        }}
      />
      {p.unit && <span class="muted small">{p.unit}</span>}
    </div>
  );
}

export function Select<T extends string | number>(p: { value: T; options: { value: T; label: string }[]; onChange(v: T): void; disabled?: boolean }) {
  return (
    <select
      value={String(p.value)}
      disabled={p.disabled}
      onChange={(e) => {
        const raw = (e.target as HTMLSelectElement).value;
        const opt = p.options.find((o) => String(o.value) === raw);
        if (opt) p.onChange(opt.value);
      }}
    >
      {p.options.map((o) => (
        <option value={String(o.value)}>{o.label}</option>
      ))}
    </select>
  );
}

export function Button(p: JSX.IntrinsicElements['button'] & { variant?: 'primary' | 'danger' | 'ghost' | 'default'; small?: boolean }) {
  const { variant = 'default', small, class: cls, ...rest } = p;
  return <button type="button" class={`btn ${variant} ${small ? 'small' : ''} ${cls ?? ''}`} {...rest} />;
}

export function Tabs<T extends string>(p: { value: T; tabs: { id: T; label: string; badge?: string }[]; onChange(v: T): void }) {
  return (
    <div class="tabs" role="tablist">
      {p.tabs.map((t) => (
        <button type="button" role="tab" aria-selected={p.value === t.id} class={`tab ${p.value === t.id ? 'active' : ''}`} onClick={() => p.onChange(t.id)}>
          {t.label}
          {t.badge && <span class="badge">{t.badge}</span>}
        </button>
      ))}
    </div>
  );
}

export function Pill(p: { kind?: 'ok' | 'warn' | 'error' | 'info'; children: ComponentChildren }) {
  return <span class={`pill ${p.kind ?? 'info'}`}>{p.children}</span>;
}

export function Empty(p: { children: ComponentChildren }) {
  return <div class="empty">{p.children}</div>;
}

/** Flash messages at the bottom right. */
let pushFlash: ((m: { text: string; kind: 'ok' | 'error' }) => void) | null = null;
export function flash(text: string, kind: 'ok' | 'error' = 'ok') {
  pushFlash?.({ text, kind });
}
export function FlashHost() {
  const [items, setItems] = useState<{ id: number; text: string; kind: 'ok' | 'error' }[]>([]);
  useEffect(() => {
    let n = 0;
    pushFlash = (m) => {
      const id = ++n;
      setItems((x) => [...x, { id, ...m }]);
      setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), 3200);
    };
    return () => (pushFlash = null);
  }, []);
  return (
    <div class="flash-host">
      {items.map((i) => (
        <div class={`flash ${i.kind}`}>{i.text}</div>
      ))}
    </div>
  );
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []): [T | null, () => void, boolean] {
  const [v, setV] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    fn()
      .then((r) => alive && setV(r))
      .catch((e) => {
        console.error(e);
        flash(String((e as Error).message ?? e), 'error');
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return [v, () => setTick((t) => t + 1), loading];
}

export const KIND_LABELS: Record<string, string> = {
  profile: 'プロフィール',
  preference: '好み',
  fact: '事実',
  episode: '出来事',
  schedule: '予定',
};
