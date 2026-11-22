const source = 'https://models.dev/api.json';
const ttl = 6 * 60 * 60 * 1000;
const retryDelay = 60 * 1000;

function rate(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function rates(cost) {
  const price = {
    input: rate(cost?.input),
    output: rate(cost?.output),
    cacheRead: rate(cost?.cache_read),
    cacheWrite: rate(cost?.cache_write),
  };
  return price.input === null || price.output === null ? null : price;
}

function normalizePrices(data) {
  const models = data?.openai?.models;
  if (!models || typeof models !== 'object') throw new Error('OpenAI models were missing from models.dev.');
  const quotes = Object.create(null);
  for (const [id, model] of Object.entries(models)) {
    const base = rates(model?.cost);
    if (!base) continue;
    const tiers = (Array.isArray(model.cost.tiers) ? model.cost.tiers : [])
      .filter(tier => tier?.tier?.type === 'context' && Number.isSafeInteger(tier.tier.size) && tier.tier.size > 0)
      .flatMap(tier => {
        const price = rates(tier);
        return price ? [{ aboveInputTokens: tier.tier.size, ...price }] : [];
      }).sort((a, b) => a.aboveInputTokens - b.aboveInputTokens);
    quotes[id] = { ...base, tiers };
  }
  return quotes;
}

export function createPricing({ fetchImpl = fetch, now = Date.now } = {}) {
  let snapshot = { quotes: Object.create(null), fetchedAt: null, expiresAt: null, unavailable: false };
  let retryAt = 0;
  let inFlight;

  async function refresh() {
    try {
      const result = await fetchImpl(source, { redirect: 'error', signal: AbortSignal.timeout(10000) });
      if (!result.ok) throw new Error('Unexpected pricing HTTP status.');
      const quotes = normalizePrices(await result.json());
      const fetchedAt = now();
      snapshot = { quotes, fetchedAt, expiresAt: fetchedAt + ttl, unavailable: false };
      retryAt = 0;
    } catch {
      snapshot = { ...snapshot, unavailable: true };
      retryAt = now() + retryDelay;
    }
    return snapshot;
  }

  function get({ force = false } = {}) {
    if (!force && now() < Math.max(snapshot.expiresAt ?? 0, retryAt)) return Promise.resolve(snapshot);
    inFlight ??= refresh().finally(() => { inFlight = null; });
    return inFlight;
  }

  return { get };
}

export function estimateNanoDollars(quote, usage) {
  if (!quote || !Number.isSafeInteger(usage?.input_tokens) || usage.input_tokens < 0 ||
      !Number.isSafeInteger(usage?.output_tokens) || usage.output_tokens < 0) return null;
  const input = usage.input_tokens;
  const detail = usage.input_tokens_details;
  const cacheRead = Math.min(input, Math.max(0, Number.isSafeInteger(detail?.cached_tokens) ? detail.cached_tokens : 0));
  const cacheWrite = Math.min(input - cacheRead,
    Math.max(0, Number.isSafeInteger(detail?.cache_write_tokens) ? detail.cache_write_tokens : 0));
  const price = quote.tiers.findLast(tier => input > tier.aboveInputTokens) ?? quote;
  const nano = Math.round(1000 * (
    (input - cacheRead - cacheWrite) * price.input +
    cacheRead * (price.cacheRead ?? price.input) +
    cacheWrite * (price.cacheWrite ?? price.input) +
    usage.output_tokens * price.output
  ));
  return Number.isSafeInteger(nano) ? nano : null;
}
