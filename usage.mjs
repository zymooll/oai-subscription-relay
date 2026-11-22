const retentionDays = 30;
const tokenFields = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'totalTokens'];
const metricFields = ['requests', 'tokenReports', ...tokenFields];

export function usageDays(query) {
  const days = Number(query.get('days') ?? retentionDays);
  return Number.isInteger(days) && days > 0 && days <= retentionDays ? days : null;
}

function dayKey(time, daysAgo = 0) {
  const date = new Date(time);
  date.setDate(date.getDate() - daysAgo);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return date.getFullYear() + '-' + month + '-' + day;
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function emptyMetrics() {
  return Object.fromEntries(metricFields.map(field => [field, 0]));
}

function hasTokenReport(usage) {
  return usage && ['input_tokens', 'output_tokens', 'total_tokens']
    .some(field => Number.isSafeInteger(usage[field]) && usage[field] >= 0);
}

export function createUsageStore({ initial, write, now = Date.now } = {}) {
  if (initial && (initial.version !== 1 || !initial.accounts ||
      typeof initial.accounts !== 'object' || Array.isArray(initial.accounts) ||
      Object.values(initial.accounts).some(account => !account?.days || typeof account.days !== 'object'))) {
    throw new Error('Unrecognized relay usage file.');
  }
  const accounts = new Map(Object.entries(initial?.accounts ?? {}));
  let persistent = Boolean(write);
  let pending = Promise.resolve();

  function persist() {
    if (!write) return;
    pending = pending.then(async () => {
      await write(JSON.stringify({ version: 1, accounts: Object.fromEntries(accounts) }));
      persistent = true;
    }).catch(() => { persistent = false; });
  }

  function getAccount(id) {
    if (!accounts.has(id)) accounts.set(id, { days: {} });
    return accounts.get(id);
  }

  function record(id, terminal, usage) {
    if (!id || !['response.completed', 'response.incomplete', 'response.failed'].includes(terminal)) return;
    const reported = hasTokenReport(usage);
    if (terminal === 'response.failed' && !reported) return;
    const time = now();
    const account = getAccount(id);
    const day = dayKey(time);
    const first = dayKey(time, retentionDays - 1);
    for (const [key, value] of accounts) {
      for (const date of Object.keys(value.days)) if (date < first) delete value.days[date];
      if (!Object.keys(value.days).length && !(value.lastLimitAt >= time - retentionDays * 86400000)) {
        if (key !== id) accounts.delete(key);
      }
    }
    const item = account.days[day] ??= emptyMetrics();
    item.requests++;
    account.lastRecordedAt = time;
    if (reported) {
      item.tokenReports++;
      const input = count(usage.input_tokens);
      const output = count(usage.output_tokens);
      item.inputTokens += input;
      item.cachedInputTokens += count(usage.input_tokens_details?.cached_tokens);
      item.outputTokens += output;
      item.totalTokens += usage.total_tokens == null ? input + output : count(usage.total_tokens);
    }
    persist();
  }

  function noteLimit(id) {
    if (!id) return;
    getAccount(id).lastLimitAt = now();
    persist();
  }

  function snapshot(id, days = retentionDays) {
    const time = now();
    const account = id ? accounts.get(id) : null;
    const daily = Array.from({ length: days }, (_, index) => {
      const date = dayKey(time, days - 1 - index);
      return { date, ...emptyMetrics(), ...account?.days[date] };
    });
    const totals = emptyMetrics();
    for (const day of daily) {
      for (const field of metricFields) totals[field] += day[field];
    }
    return {
      scope: 'local_relay',
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      days, totals, daily, persistent,
      lastRecordedAt: account?.lastRecordedAt ?? null,
      lastLimitAt: account?.lastLimitAt ?? null,
      planUsageUrl: 'https://chatgpt.com/settings/usage',
    };
  }

  return { record, noteLimit, snapshot, flush: () => pending };
}
