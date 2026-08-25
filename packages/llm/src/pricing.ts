/**
 * Token pricing for cost governance. Prices are USD per million tokens and are
 * deliberately approximate — the gateway bills internally, but homeagent still
 * needs a local estimate for daily cost visibility and model-tier comparison.
 *
 * If a model id is unknown we fall back to the default tier's price rather than
 * throwing, so an unrecognized gateway model never blocks a request outright.
 */

export interface ModelPrice {
  /** USD per 1M input tokens */
  inPerM: number;
  /** USD per 1M output tokens */
  outPerM: number;
}

/** Keyed by a substring match against the model id (longest match wins). */
const PRICES: Array<{ match: string; price: ModelPrice }> = [
  { match: "haiku", price: { inPerM: 1.0, outPerM: 5.0 } },
  { match: "sonnet", price: { inPerM: 3.0, outPerM: 15.0 } },
  { match: "opus", price: { inPerM: 15.0, outPerM: 75.0 } },
  { match: "fable", price: { inPerM: 3.0, outPerM: 15.0 } },
];

const FALLBACK: ModelPrice = { inPerM: 3.0, outPerM: 15.0 };

export function priceFor(model: string): ModelPrice {
  let best: { len: number; price: ModelPrice } | undefined;
  for (const { match, price } of PRICES) {
    if (model.includes(match) && (!best || match.length > best.len)) {
      best = { len: match.length, price };
    }
  }
  return best?.price ?? FALLBACK;
}

/** Estimated USD cost of a call given token usage. */
export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const p = priceFor(model);
  return (inputTokens / 1_000_000) * p.inPerM + (outputTokens / 1_000_000) * p.outPerM;
}
