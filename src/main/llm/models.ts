// Per-model API capabilities and prices (claude-api skill, cached 2026-09-25). USD per million tokens.

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number; // 5-minute TTL write (1.25x input)
  cacheWrite1h: number; // 1-hour TTL write (2x input)
}

const PRICES: Record<string, ModelPrice> = {
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, cacheWrite1h: 4 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25, cacheWrite1h: 2 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, cacheWrite1h: 4 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 },
};

export const WEB_SEARCH_USD = 0.01; // $10 per 1,000 searches

export function priceOf(model: string): ModelPrice {
  return PRICES[model] ?? PRICES['claude-sonnet-5-5'];
}

export interface UsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  /** split of cache_creation_input_tokens by TTL (absent on older responses) */
  cache_creation?: { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null;
  server_tool_use?: { web_search_requests?: number | null } | null;
}

export function costUsd(model: string, u: UsageLike): number {
  const p = priceOf(model);
  const c1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const c5m = u.cache_creation ? (u.cache_creation.ephemeral_5m_input_tokens ?? 0) : (u.cache_creation_input_tokens ?? 0);
  return (
    ((u.input_tokens ?? 0) * p.input +
      (u.output_tokens ?? 0) * p.output +
      (u.cache_read_input_tokens ?? 0) * p.cacheRead +
      c5m * p.cacheWrite +
      c1h * p.cacheWrite1h) /
      1_000_000 +
    (u.server_tool_use?.web_search_requests ?? 0) * WEB_SEARCH_USD
  );
}

export interface ModelCaps {
  /** accepts thinking: {type: 'adaptive'} and output_config.effort */
  adaptive: boolean;
  /** accepts role: 'system' entries inside messages */
  midConversationSystem: boolean;
  /** accepts fallbacks: 'default' (beta server-side-fallback-2026-07-01) */
  serverFallback: boolean;
  webSearchType: 'web_search_20260209' | 'web_search_20250305';
}

export function capsOf(model: string): ModelCaps {
  const haiku = model.startsWith('claude-haiku');
  const sonnet5 = model === 'claude-sonnet-5';
  return {
    adaptive: !haiku,
    midConversationSystem: !haiku && !sonnet5,
    serverFallback: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1'].includes(model),
    webSearchType: haiku ? 'web_search_20250305' : 'web_search_20260209',
  };
}
