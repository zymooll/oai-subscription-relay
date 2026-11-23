import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { AppError, createSseParser, inferenceError, isResponsesStream, streamEvents } from './openai.mjs';
import { usageDays } from './usage.mjs';
import { estimateNanoDollars } from './pricing.mjs';

const unsupportedFields = [
  'background', 'conversation', 'max_tool_calls', 'metadata',
  'moderation', 'multi_agent', 'prompt', 'prompt_cache_retention', 'safety_identifier',
  'temperature', 'top_logprobs', 'top_p', 'truncation', 'user', 'previous_response_id',
];
const upstreamHeaderNames = ['x-request-id', 'retry-after'];
const overloadCodes = new Set(['overloaded', 'overloaded_error', 'server_overloaded',
  'server_is_overloaded', 'model_overloaded', 'engine_overloaded']);
const preludeEvents = new Set(['response.queued', 'response.created', 'response.in_progress']);
const maxOverloadRetries = 2;
const maxPreludeBytes = 256 * 1024;

class RelayError extends AppError {
  constructor(status, message, code, param = null) {
    super(status, message);
    this.code = code;
    this.param = param;
  }
}

function invalid(param, message, code = 'invalid_value') {
  return new RelayError(400, message, code, param);
}

function normalizePayload(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw invalid(null, 'Expected a JSON object.');
  }
  const { stream, store, ...payload } = data;
  if (stream != null && typeof stream !== 'boolean') {
    throw invalid('stream', 'stream must be a boolean.');
  }
  if (store != null && store !== false) {
    throw invalid('store', 'ChatGPT plan requests require store: false.', 'unsupported_parameter');
  }
  if (typeof payload.model !== 'string' || !payload.model.trim()) {
    throw invalid('model', 'Pass an available model ID from GET /v1/models.');
  }
  if (typeof payload.input === 'string') {
    payload.input = [{ role: 'user', content: payload.input }];
  }
  if (!Array.isArray(payload.input)) {
    throw invalid('input', 'input must be a string or a Responses input array.');
  }
  // Some clients always send this limit. The ChatGPT plan route uses its own output limits.
  delete payload.max_output_tokens;
  for (const field of unsupportedFields) {
    if (payload[field] != null && !(field === 'background' && payload[field] === false)) {
      const message = field === 'previous_response_id'
        ? 'Send the conversation history in input when using a ChatGPT plan.'
        : 'This parameter is unavailable for ChatGPT plan requests: ' + field + '.';
      throw invalid(field, message, 'unsupported_parameter');
    }
    delete payload[field];
  }
  return { payload, stream: stream === true };
}

function errorType(status) {
  if (status === 429) return 'rate_limit_error';
  if (status === 401) return 'authentication_error';
  if (status >= 500) return 'server_error';
  return 'invalid_request_error';
}

function localError(error) {
  if (!(error instanceof AppError)) {
    return new RelayError(502, 'The local relay could not complete the upstream response.', 'upstream_error');
  }
  const code = error.code ?? (error.status === 401 ? 'chatgpt_reauthorization_required' : 'relay_error');
  return new RelayError(error.status, error.message, code, error.param);
}

function responseError(error) {
  return {
    error: {
      message: error.message, type: errorType(error.status), param: error.param, code: error.code,
    },
  };
}

function upstreamHeaders(response) {
  const headers = {};
  for (const name of upstreamHeaderNames) {
    const value = response.headers.get(name);
    if (value) headers[name] = value;
  }
  return headers;
}

function isOverload(error, status) {
  if (status === 401 || status === 403 || error?.code === 'subscription_sharing_usage_limit_exceeded') return false;
  return overloadCodes.has(error?.code) || overloadCodes.has(error?.type) ||
    (typeof error?.message === 'string' && /\boverloaded\b/i.test(error.message)) ||
    (status === 503 && (!error?.code || ['server_error', 'service_unavailable'].includes(error.code)));
}

function retryDelay(attempt, retryAfter, deadline) {
  if (attempt >= maxOverloadRetries) return null;
  const now = Date.now();
  let serverWait = 0;
  if (retryAfter) {
    serverWait = /^\d+$/.test(retryAfter)
      ? Number(retryAfter) * 1000
      : (Date.parse(retryAfter) || now) - now;
  }
  const wait = Math.max(500 * 2 ** attempt, serverWait);
  return now + wait < deadline ? wait : null;
}

function providerError(error, status) {
  const code = typeof error?.code === 'string' ? error.code : null;
  const summary = inferenceError(code, status);
  if (status === 401 || summary.status === 401) {
    return new RelayError(401, 'The ChatGPT plan authorization was rejected. Reauthorize it in the local window.',
      code ?? 'chatgpt_reauthorization_required');
  }
  const overloaded = isOverload(error, status);
  const failure = new RelayError(status || (overloaded ? 503 : summary.status),
    typeof error?.message === 'string' && error.message ? error.message : summary.message,
    code ?? 'upstream_error', typeof error?.param === 'string' ? error.param : null);
  failure.overloaded = overloaded;
  return failure;
}

function eventError(event) {
  return event.response?.error ?? event.error ?? event;
}

function isFailureEvent(event) {
  return event?.type === 'response.failed' || event?.type === 'error';
}

async function aggregate(body, observe) {
  for await (const event of streamEvents(body)) {
    observe(event);
    if (isFailureEvent(event)) {
      throw providerError(eventError(event), 0);
    }
    if (event.type === 'response.completed' || event.type === 'response.incomplete') {
      if (event.response && typeof event.response.id === 'string') return event.response;
      break;
    }
  }
  throw new RelayError(502, 'OpenAI ended the stream without a final response.', 'incomplete_stream');
}

function isPreludeEvent(event) {
  return preludeEvents.has(event?.type) ||
    (event?.type === 'response.output_item.added' && event.item?.type === 'message' && event.item.content?.length === 0) ||
    (event?.type === 'response.content_part.added' && event.part?.type === 'output_text' && event.part.text === '');
}

async function streamPrelude(body) {
  const reader = body.getReader();
  const parse = createSseParser();
  const chunks = [];
  let bytes = 0;
  let failure = null;
  try {
    while (bytes < maxPreludeBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      bytes += value.byteLength;
      try {
        for (const event of parse(value)) {
          if (isPreludeEvent(event)) continue;
          if (isFailureEvent(event) && isOverload(eventError(event), 0)) failure = event;
          return { chunks, failure };
        }
      } catch {
        // Preserve unfamiliar frames and stop probing once delivery cannot be retried safely.
        break;
      }
    }
    return { chunks, failure };
  } finally {
    reader.releaseLock();
  }
}

async function* streamWithPrelude(body, chunks) {
  yield* chunks;
  yield* body;
}

function usageObserver(usage, accountId, keyId, recordMeter) {
  let recorded = false;
  let limited = false;
  const keyScope = 'key:' + keyId;
  return event => {
    const code = eventError(event).code;
    if (!limited && code === 'subscription_sharing_usage_limit_exceeded') {
      limited = true;
      usage.noteLimit(accountId);
      usage.noteLimit(keyScope);
    }
    if (!recorded && ['response.completed', 'response.incomplete', 'response.failed'].includes(event.type)) {
      recorded = true;
      const report = event.response?.usage;
      usage.record(accountId, event.type, report);
      usage.record(keyScope, event.type, report);
      recordMeter(report);
    }
  };
}

function inspectStream(observe) {
  let parse = createSseParser();
  return new Transform({
    transform(chunk, encoding, callback) {
      if (parse) {
        try {
          for (const event of parse(chunk)) observe(event);
        } catch {
          // Usage inspection must not interrupt a byte-for-byte SSE relay.
          parse = null;
        }
      }
      callback(null, chunk);
    },
  });
}

function tokensReported(usage) {
  const valid = value => Number.isSafeInteger(value) && value >= 0;
  if (valid(usage?.total_tokens)) return usage.total_tokens;
  if (valid(usage?.input_tokens) && valid(usage?.output_tokens)) return usage.input_tokens + usage.output_tokens;
  return null;
}

export function createRelay({ getKeys, pricing, getOpenAI, isSigningOut, usage, readJson, reply }) {
  const active = new Set();

  async function handle(req, res, url) {
    const path = url.pathname;
    let headers = {};
    let controller;
    let timeout;
    let keyId;
    let keepalive;
    let streamCommitted = false;
    const settlement = { tokens: null, estimatedNanoDollars: null, upstreamAccepted: false };
    async function settle() {
      if (!keyId) return;
      await getKeys().settle(keyId, settlement);
      keyId = null;
    }
    try {
      const keys = getKeys();
      const authorization = req.headers.authorization;
      const match = typeof authorization === 'string' && /^Bearer ([A-Za-z0-9_-]+)$/i.exec(authorization);
      headers = { 'WWW-Authenticate': 'Bearer' };
      const access = keys.authenticate(match ? match[1] : '');
      headers = {};
      if (!['/v1/models', '/v1/responses', '/v1/usage'].includes(path)) {
        throw new RelayError(404, 'Available routes are GET /v1/models, GET /v1/usage, and POST /v1/responses.', 'not_found');
      }
      const expectedMethod = path === '/v1/responses' ? 'POST' : 'GET';
      if (req.method !== expectedMethod) {
        headers = { Allow: expectedMethod };
        throw new RelayError(405, 'Use ' + expectedMethod + ' for this route.', 'method_not_allowed');
      }
      const normalized = expectedMethod === 'POST' ? normalizePayload(await readJson(req, 20 * 1024 * 1024)) : null;
      if (isSigningOut()) throw new RelayError(409, 'The ChatGPT account is signing out.', 'account_signing_out');
      const openai = getOpenAI();
      if (path === '/v1/usage') {
        const days = usageDays(url.searchParams);
        if (!days) throw invalid('days', 'days must be an integer from 1 to 30.');
        const key = keys.check(access);
        return reply(res, 200, { ...usage.snapshot('key:' + key.id, days), scope: 'relay_key', key });
      }

      controller = new AbortController();
      active.add(controller);
      res.once('close', () => controller.abort());
      const timeoutMs = normalized ? 300000 : 25000;
      const deadline = Date.now() + timeoutMs;
      timeout = AbortSignal.timeout(timeoutMs);
      const signal = AbortSignal.any([controller.signal, timeout]);
      if (!normalized) {
        const { models, cacheHit } = await openai.models();
        signal.throwIfAborted();
        const { allowedModels } = keys.check(access);
        const data = models.filter(model => allowedModels === null || allowedModels.includes(model.id))
          .map(model => ({ id: model.id, object: 'model', created: 0, owned_by: 'openai' }));
        return reply(res, 200, { object: 'list', data }, undefined, { 'X-Relay-Cache': cacheHit ? 'HIT' : 'MISS' });
      }

      const model = normalized.payload.model;
      keys.permit(access, model);
      const { quotes } = await pricing.get();
      const quote = Object.hasOwn(quotes, model) ? quotes[model] : null;
      for (let attempt = 0; ; attempt++) {
        const { response, accountId } = await openai.relayResponses(normalized.payload, signal, async () => {
          if (keyId) keys.permit(access, model);
          else keyId = await keys.reserve(access, model, quote);
        });
        settlement.upstreamAccepted ||= response.ok;
        headers = upstreamHeaders(response);
        try {
          if (!response.ok) {
            if (response.status === 429) {
              usage.noteLimit(accountId);
              usage.noteLimit('key:' + keyId);
            }
            const body = await response.json().catch(() => ({}));
            throw providerError(body?.error ?? body, response.status);
          }
          if (!isResponsesStream(response)) {
            await response.body?.cancel().catch(() => {});
            throw new RelayError(502, 'OpenAI returned an unexpected response format.', 'invalid_upstream_stream');
          }
          const observe = usageObserver(usage, accountId, keyId, report => {
            const tokens = tokensReported(report);
            const price = estimateNanoDollars(quote, report);
            if (tokens !== null) settlement.tokens = (settlement.tokens ?? 0) + tokens;
            if (price !== null) settlement.estimatedNanoDollars = (settlement.estimatedNanoDollars ?? 0) + price;
          });
          if (!normalized.stream) {
            const result = await aggregate(response.body, observe);
            await settle();
            return reply(res, 200, result, undefined, headers);
          }

          if (!res.headersSent) {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream; charset=utf-8',
              'Cache-Control': 'no-store',
              'X-Content-Type-Options': 'nosniff',
              ...headers,
            });
            res.flushHeaders();
            keepalive = setInterval(() => {
              if (!res.destroyed && !res.writableNeedDrain) res.write(': relay waiting\n\n');
            }, 10000);
          }

          const { chunks, failure } = await streamPrelude(response.body);
          if (failure && retryDelay(attempt, headers['retry-after'], deadline) !== null) {
            observe(failure);
            await response.body.cancel().catch(() => {});
            throw providerError(eventError(failure), 0);
          }
          clearInterval(keepalive);
          streamCommitted = true;
          const source = Readable.from(streamWithPrelude(response.body, chunks), { objectMode: false });
          await pipeline(source, inspectStream(observe), res, { signal, end: false });
          await settle();
          return res.end();
        } catch (error) {
          const wait = !streamCommitted && error.overloaded
            ? retryDelay(attempt, headers['retry-after'], deadline) : null;
          if (wait === null) throw error;
          await delay(wait, undefined, { signal });
        }
      }
    } catch (error) {
      try {
        await settle();
      } catch (storageError) {
        error = storageError;
      }
      if (res.destroyed) return;
      const failure = timeout?.aborted
        ? new RelayError(504, 'The OpenAI request timed out.', 'upstream_timeout')
        : localError(error);
      if (res.headersSent) {
        if (streamCommitted) return res.destroy();
        const { code, message, param } = responseError(failure).error;
        return res.end('event: error\ndata: ' + JSON.stringify({ type: 'error', code, message, param }) + '\n\n');
      }
      if (Number.isInteger(error.retryAfter) && failure.status === 429) {
        headers = { ...headers, 'Retry-After': String(error.retryAfter) };
      }
      if (failure.status === 413) headers = { ...headers, Connection: 'close' };
      reply(res, failure.status, responseError(failure), undefined, headers);
    } finally {
      clearInterval(keepalive);
      active.delete(controller);
    }
  }

  return { handle, stop: () => { for (const controller of active) controller.abort(); } };
}
