import { createHash, randomUUID } from 'node:crypto';
import { AppError, nonce } from './openai.mjs';

export class KeyError extends AppError {
  constructor(status, message, code, param = null) {
    super(status, message);
    this.code = code;
    this.param = param;
  }
}

const keyPattern = /^lrk_[A-Za-z0-9_-]{43}$/;
const budgetScale = 1e9;
const rpmWindowMs = 60000;
const digest = key => createHash('sha256').update(key).digest('hex');

function invalid(field, message) {
  return new KeyError(400, message, 'invalid_key_policy', field);
}

function integerLimit(value, field) {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value <= 0) throw invalid(field, '用量上限须为正整数。');
  return value;
}

function policy(data) {
  const name = typeof data?.name === 'string' ? data.name.trim() : '';
  if (!name || name.length > 80) throw invalid('name', '请输入 1 到 80 个字符的密钥名称。');
  const expiresAt = data.expiresAt ?? null;
  if (expiresAt !== null && (!Number.isSafeInteger(expiresAt) || expiresAt <= 0 || expiresAt > 8640000000000000)) {
    throw invalid('expiresAt', '密钥到期时间无效。');
  }
  const models = data.allowedModels ?? null;
  if (models !== null && (!Array.isArray(models) || !models.length || models.length > 200 ||
      models.some(model => typeof model !== 'string' || !/^[\w.:\-/]{1,200}$/.test(model)))) {
    throw invalid('allowedModels', '请至少选择一个有效的模型。');
  }
  const cost = data.limits?.estimatedUsd ?? null;
  const estimatedNanoDollars = cost === null ? null : Math.round(cost * budgetScale);
  if (cost !== null && (typeof cost !== 'number' || !Number.isSafeInteger(estimatedNanoDollars) || estimatedNanoDollars <= 0)) {
    throw invalid('estimatedUsd', '估算费用上限须为有效的正数 USD 金额。');
  }
  return {
    name, expiresAt, allowedModels: models === null ? null : [...new Set(models)],
    limits: {
      requests: integerLimit(data.limits?.requests, 'requests'),
      rpm: integerLimit(data.limits?.rpm, 'rpm'),
      tokens: integerLimit(data.limits?.tokens, 'tokens'),
      estimatedNanoDollars,
    },
  };
}

function emptyUsage() {
  return { requests: 0, tokens: 0, estimatedNanoDollars: 0, unreported: 0, unpriced: 0, inFlight: 0 };
}

function recentRequests(record, time) {
  return (record.recentRequests ?? []).filter(timestamp => timestamp > time - rpmWindowMs);
}

export function createKeyStore({ initial, write, encrypt, decrypt, now = Date.now }) {
  if (initial && (initial.version !== 1 || !Array.isArray(initial.keys))) {
    throw new Error('Unrecognized relay key store.');
  }
  let records = initial?.keys ?? [];
  let queue = Promise.resolve();

  function update(operation) {
    const task = queue.then(async () => {
      const draft = structuredClone(records);
      const result = await operation(draft);
      await write(JSON.stringify({ version: 1, keys: draft }));
      records = draft;
      return result;
    });
    queue = task.catch(() => {});
    return task;
  }

  function byId(rows, id) {
    const record = rows.find(item => item.id === id);
    if (!record) throw new KeyError(404, '未找到此中继密钥。', 'relay_key_not_found');
    return record;
  }

  function state(record) {
    if (record.revokedAt !== null) return 'revoked';
    if (record.expiresAt !== null && record.expiresAt <= now()) return 'expired';
    return 'active';
  }

  function summary(record) {
    const { id, name, suffix, allowedModels, expiresAt, createdAt, revokedAt, limits, usage } = record;
    return {
      id, name, suffix, allowedModels, expiresAt, createdAt, revokedAt, state: state(record),
      limits: {
        requests: limits.requests, rpm: limits.rpm ?? null, tokens: limits.tokens,
        estimatedUsd: limits.estimatedNanoDollars === null ? null : limits.estimatedNanoDollars / budgetScale,
      },
      usage: {
        requests: usage.requests, tokens: usage.tokens, estimatedUsd: usage.estimatedNanoDollars / budgetScale,
        rpm: recentRequests(record, now()).length,
        unreported: usage.unreported, unpriced: usage.unpriced, inFlight: usage.inFlight,
      },
    };
  }

  function active(record) {
    if (!record || record.revokedAt !== null) {
      throw new KeyError(401, 'Provide an active local relay API key.', 'invalid_api_key');
    }
    if (state(record) === 'expired') {
      throw new KeyError(401, 'This local relay API key has expired.', 'relay_key_expired');
    }
    return record;
  }

  function current(rows, access) {
    return active(rows.find(record => record.id === access.id && record.digest === access.digest));
  }

  function requireModel(record, model) {
    if (record.allowedModels !== null && !record.allowedModels.includes(model)) {
      throw new KeyError(403, 'This relay API key is not allowed to use the requested model.', 'model_not_allowed', 'model');
    }
  }

  function setSecret(record, key, sealed) {
    record.digest = digest(key);
    record.suffix = key.slice(-6);
    record.sealed = sealed;
  }

  async function create(data, existing) {
    const settings = policy(data);
    const key = existing ?? 'lrk_' + nonce();
    if (!keyPattern.test(key)) throw new Error('Invalid relay key material.');
    const sealed = await encrypt(key);
    return update(rows => {
      const record = {
        id: randomUUID(), ...settings, createdAt: now(), revokedAt: null, usage: emptyUsage(),
      };
      setSecret(record, key, sealed);
      rows.push(record);
      return summary(record);
    });
  }

  function edit(id, data) {
    const settings = policy(data);
    return update(rows => {
      const record = byId(rows, id);
      if (record.revokedAt !== null) throw new KeyError(410, '此密钥已撤销。', 'relay_key_revoked');
      Object.assign(record, settings);
      return summary(record);
    });
  }

  async function rotate(id) {
    const key = 'lrk_' + nonce();
    const sealed = await encrypt(key);
    return update(rows => {
      const record = byId(rows, id);
      if (record.revokedAt !== null) throw new KeyError(410, '此密钥已撤销。', 'relay_key_revoked');
      setSecret(record, key, sealed);
      return summary(record);
    });
  }

  function revoke(id) {
    return update(rows => {
      const record = byId(rows, id);
      record.revokedAt ??= now();
      record.digest = null;
      record.sealed = null;
      return summary(record);
    });
  }

  async function secret(id) {
    const record = byId(records, id);
    if (record.revokedAt !== null) throw new KeyError(410, '此密钥已撤销。', 'relay_key_revoked');
    const value = await decrypt(record.sealed);
    const latest = byId(records, id);
    if (latest.digest !== record.digest || !keyPattern.test(value) || digest(value) !== latest.digest) {
      throw new KeyError(409, '密钥已更新，请重新读取。', 'relay_key_changed');
    }
    return value;
  }

  function authenticate(key) {
    const record = active(keyPattern.test(key) ? records.find(item => item.digest === digest(key)) : null);
    return { id: record.id, digest: record.digest };
  }

  function permit(access, model) {
    requireModel(current(records, access), model);
  }

  function reserve(access, model, quote) {
    return update(rows => {
      const record = current(rows, access);
      requireModel(record, model);
      const { limits, usage } = record;
      if (limits.requests !== null && usage.requests >= limits.requests ||
          limits.tokens !== null && usage.tokens >= limits.tokens ||
          limits.estimatedNanoDollars !== null && usage.estimatedNanoDollars >= limits.estimatedNanoDollars) {
        throw new KeyError(429, 'This relay API key has reached its configured usage limit.', 'relay_key_quota_exceeded');
      }
      const time = now();
      const window = recentRequests(record, time);
      if (limits.rpm != null && window.length >= limits.rpm) {
        const next = window.sort((a, b) => a - b)[window.length - limits.rpm] + rpmWindowMs;
        const error = new KeyError(429, 'This relay API key has reached its requests-per-minute limit.', 'relay_key_rpm_exceeded');
        error.retryAfter = Math.ceil((next - time) / 1000);
        throw error;
      }
      if (limits.estimatedNanoDollars !== null && !quote) {
        throw new KeyError(503, 'A models.dev price is unavailable for this cost-limited request.', 'model_price_unavailable', 'model');
      }
      if ((limits.tokens !== null || limits.estimatedNanoDollars !== null) && usage.inFlight > 0) {
        throw new KeyError(429, 'A metered request is already running for this relay API key.', 'relay_key_metering_busy');
      }
      usage.requests++;
      usage.inFlight++;
      record.recentRequests = [...window, time];
      return record.id;
    });
  }

  function settle(id, { tokens, estimatedNanoDollars, upstreamAccepted }) {
    return update(rows => {
      const { usage } = byId(rows, id);
      usage.inFlight--;
      if (tokens !== null) {
        usage.tokens += tokens;
        if (estimatedNanoDollars !== null) usage.estimatedNanoDollars += estimatedNanoDollars;
        else usage.unpriced++;
      } else if (upstreamAccepted) {
        usage.unreported++;
      }
    });
  }

  function recover() {
    if (!records.some(record => record.usage.inFlight)) return Promise.resolve();
    return update(rows => {
      for (const row of rows) {
        row.usage.unreported += row.usage.inFlight;
        row.usage.inFlight = 0;
      }
    });
  }

  return {
    list: () => records.map(summary), get: id => summary(byId(records, id)),
    create, edit, rotate, revoke, secret, authenticate, permit, reserve, settle, recover,
    check: access => summary(current(records, access)),
  };
}
