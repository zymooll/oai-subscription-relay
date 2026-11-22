import { createPublicKey, randomBytes, createHash, verify } from 'node:crypto';

const issuer = 'https://auth.openai.com';
const resource = 'https://api.openai.com/v1';
const tokenEndpoint = issuer + '/api/accounts/oauth/token';
const directScope = 'chatgpt.tokens.use.direct';
const appName = 'Local Plan Chat';
const modelsTtl = 5 * 60 * 1000;

export class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function nonce() {
  return randomBytes(32).toString('base64url');
}

async function bodyOf(response) {
  return response.json().catch(() => ({}));
}

export function inferenceError(code, status) {
  if (code === 'subscription_sharing_user_not_eligible' || status === 403 && !code) {
    return new AppError(403, '当前 ChatGPT 账号、工作区或服务地区没有开放套餐调用。请在登录时选择符合条件的账号和工作区。');
  }
  if (code === 'subscription_sharing_usage_limit_exceeded' || status === 429) {
    return new AppError(429, '已达到当前用量限制。可前往 ChatGPT 设置 → 用量查看。');
  }
  if (code === 'subscription_sharing_usage_unavailable' || status >= 500) {
    return new AppError(503, 'OpenAI 暂时无法完成请求，请稍后重试。');
  }
  if (code === 'subscription_sharing_unsupported_capability' || status === 400) {
    return new AppError(400, '当前模型或请求参数不适用于套餐调用。请更换模型，或开启新对话后重试。');
  }
  if (status === 401) return new AppError(401, '套餐授权已失效。请重新授权后再发送。');
  return new AppError(502, 'OpenAI 未能完成这次请求。请刷新模型列表或稍后重试。');
}

export function isResponsesStream(response) {
  // The Responses endpoint can omit Content-Type on a successful SSE response.
  const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  return Boolean(response.body) && (!mime || mime === 'text/event-stream');
}

function accountId(profile) {
  if (!profile?.accessToken) return null;
  return createHash('sha256').update(JSON.stringify([issuer, profile.clientId, profile.subject])).digest('hex');
}

export function createOpenAI(vault, { fetchImpl = fetch, now = Date.now } = {}) {
  let profile = vault.profile ?? null;
  let pending = null;
  let refreshFlight = null;
  let jwks = [];
  let keysUntil = 0;
  let modelCatalog = null;
  let modelFlight = null;

  function clearModels() {
    modelCatalog = null;
    modelFlight = null;
  }

  async function request(url, options = {}) {
    try {
      return await fetchImpl(url, {
        ...options,
        redirect: 'error',
        signal: options.signal ?? AbortSignal.timeout(25000),
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new AppError(503, '连接 OpenAI 失败，请检查本机网络后重试。');
    }
  }

  async function exchange(form) {
    const response = await request(tokenEndpoint, {
      method: 'POST',
      body: new URLSearchParams({ ...form, resource }),
    });
    const body = await bodyOf(response);
    if (!response.ok) {
      const terminal = ['invalid_grant', 'invalid_client'].includes(body.error);
      const error = new AppError(terminal ? 401 : 502,
        terminal ? '授权已失效，请重新登录。' : 'OpenAI 未能完成令牌交换，请重试。');
      error.terminal = terminal;
      throw error;
    }
    return body;
  }

  async function validateIdentity(rawToken, clientId, expectedNonce) {
    try {
      const parts = rawToken.split('.');
      if (parts.length !== 3) throw new Error();
      const [head, payload, signature] = parts;
      const header = JSON.parse(Buffer.from(head, 'base64url'));
      if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error();
      if (Date.now() > keysUntil || !jwks.some(key => key.kid === header.kid)) {
        const response = await request(issuer + '/.well-known/jwks.json');
        if (!response.ok) throw new Error();
        jwks = (await bodyOf(response)).keys ?? [];
        keysUntil = Date.now() + 300000;
      }
      const key = jwks.find(key => key.kid === header.kid && key.kty === 'RSA');
      if (!key || !verify('RSA-SHA256', Buffer.from(head + '.' + payload),
        createPublicKey({ key, format: 'jwk' }), Buffer.from(signature, 'base64url'))) throw new Error();
      const id = JSON.parse(Buffer.from(payload, 'base64url'));
      const audience = Array.isArray(id.aud) ? id.aud : [id.aud];
      if (id.iss !== issuer || !audience.includes(clientId) ||
          (audience.length > 1 && id.azp !== clientId) ||
          !Number.isFinite(id.exp) || id.exp * 1000 <= Date.now() ||
          id.nonce !== expectedNonce || typeof id.sub !== 'string' || !id.sub) throw new Error();
      return id;
    } catch {
      throw new AppError(401, '无法验证 OpenAI 返回的账号身份，请重新授权。');
    }
  }

  function credentials(token, previous) {
    const scopes = typeof token.scope === 'string' ? token.scope.split(/\s+/) : previous?.scopes ?? [];
    if (!scopes.includes(directScope)) {
      throw new AppError(403, '未授予 ChatGPT 套餐使用权限。请重新登录并同意套餐调用。');
    }
    const refreshToken = token.refresh_token ?? previous?.refreshToken;
    if (typeof token.access_token !== 'string' || !token.access_token ||
        typeof refreshToken !== 'string' || !refreshToken ||
        !Number.isFinite(token.expires_in) || token.expires_in <= 0) {
      throw new AppError(502, 'OpenAI 返回的授权信息不完整，请重新登录。');
    }
    return {
      accessToken: token.access_token,
      refreshToken,
      idToken: token.id_token ?? previous?.idToken,
      scopes,
      expiresAt: Date.now() + token.expires_in * 1000,
    };
  }

  function login(redirectUri, newAccount) {
    if (pending?.busy) throw new AppError(409, '登录正在完成，请稍候。');
    const returning = !newAccount && profile?.clientId ? profile : null;
    const intent = { redirectUri, state: nonce(), nonce: nonce(), verifier: nonce(), returning, time: Date.now() };
    pending = intent;
    const query = new URLSearchParams({
      client_id: returning?.clientId ?? 'dynamic_agent_client',
      ext_agent_host_id: vault.hostId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: 'openid profile email offline_access resource.invoke ' + directScope,
      resource,
      state: intent.state,
      nonce: intent.nonce,
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(intent.verifier).digest('base64url'),
    });
    if (!returning) query.set('agent_name_hint', appName);
    if (returning?.idToken) query.set('id_token_hint', returning.idToken);
    return issuer + '/api/accounts/authorize?' + query;
  }

  async function complete(query) {
    const intent = pending;
    if (!intent || intent.busy || Date.now() - intent.time > 600000 ||
        query.getAll('state').length !== 1 || query.get('state') !== intent.state) {
      throw new AppError(400, '登录请求已过期或无法验证，请从中继管理台重新发起。');
    }
    intent.busy = true;
    try {
      if (query.has('error')) {
        throw new AppError(403, '授权被取消或暂时无法完成。请确认你的套餐和工作区后重试。');
      }
      const callbackClient = query.get('client_id');
      const clientId = intent.returning?.clientId ?? callbackClient;
      if (!clientId?.startsWith('oaiapp_') || query.getAll('client_id').length > 1 ||
          (callbackClient && callbackClient !== clientId) ||
          query.getAll('code').length !== 1 || !query.get('code')) {
        throw new AppError(400, 'OpenAI 回调缺少有效的客户端或授权码。');
      }
      const token = await exchange({
        grant_type: 'authorization_code',
        client_id: clientId,
        code: query.get('code'),
        code_verifier: intent.verifier,
        redirect_uri: intent.redirectUri,
      });
      const id = await validateIdentity(token.id_token, clientId, intent.nonce);
      if (intent.returning && id.sub !== intent.returning.subject) {
        throw new AppError(401, '授权账号与当前账号不一致。请用「切换账号」重新发起。');
      }
      const updated = {
        clientId, subject: id.sub,
        email: typeof id.email === 'string' ? id.email : '',
        ...credentials(token),
      };
      // Finish any active rotation before replacing the stored account.
      await refreshFlight?.catch(() => {});
      await vault.save(updated);
      profile = updated;
      clearModels();
    } finally {
      pending = null;
    }
  }

  async function refresh(current) {
    try {
      const token = await exchange({
        grant_type: 'refresh_token',
        client_id: current.clientId,
        refresh_token: current.refreshToken,
      });
      const updated = { ...current, ...credentials(token, current) };
      // Preserve the previously verified ID token for the same OAuth registration.
      updated.idToken = current.idToken;
      profile = updated;
      await vault.save(updated);
      return updated;
    } catch (error) {
      if (error.terminal) {
        const { clientId, subject, email } = current;
        profile = { clientId, subject, email };
        clearModels();
        await vault.save(profile);
      }
      throw error;
    }
  }

  async function authorized() {
    if (pending?.busy) throw new AppError(409, '登录正在完成，请稍候。');
    if (!profile?.accessToken) throw new AppError(401, '请先使用 ChatGPT 登录。');
    if (profile.expiresAt > Date.now() + 90000) return profile;
    refreshFlight ??= refresh(profile).finally(() => { refreshFlight = null; });
    return refreshFlight;
  }

  async function logout() {
    if (pending?.busy) throw new AppError(409, '登录正在完成，请稍候。');
    pending = null;
    clearModels();
    await refreshFlight?.catch(() => {});
    const current = profile;
    if (!current) return { confirmed: true };
    let confirmed = !current.refreshToken;
    if (current.refreshToken) {
      try {
        const response = await request(issuer + '/api/accounts/oauth/revoke', {
          method: 'POST',
          body: new URLSearchParams({
            token: current.refreshToken, token_type_hint: 'refresh_token', client_id: current.clientId,
          }),
          signal: AbortSignal.timeout(8000),
        });
        confirmed = response.ok;
      } catch {}
    }
    const { clientId, subject, email } = current;
    await vault.save({ clientId, subject, email });
    profile = { clientId, subject, email };
    return { confirmed };
  }

  async function fetchModels(account) {
    const response = await request(resource + '/models', {
      headers: { Authorization: 'Bearer ' + account.accessToken, Accept: 'application/json' },
    });
    const data = await bodyOf(response);
    if (!response.ok) throw inferenceError(data.error?.code, response.status);
    if (!Array.isArray(data.models)) throw new AppError(502, 'OpenAI 返回的套餐模型列表格式异常。');
    return data.models.filter(model => model?.visibility === 'list' && typeof model.slug === 'string')
      .map(model => ({ id: model.slug, name: typeof model.display_name === 'string' ? model.display_name : model.slug }));
  }

  async function models({ refresh = false } = {}) {
    const account = await authorized();
    const key = accountId(account);
    if (!refresh && modelCatalog?.key === key && modelCatalog.data.expiresAt > now()) {
      return { ...modelCatalog.data, cacheHit: true };
    }
    if (modelFlight?.key === key) return modelFlight.promise;

    const flight = { key, promise: null };
    flight.promise = fetchModels(account).then(models => {
      if (modelFlight !== flight || accountId(profile) !== key) {
        throw new AppError(409, '账号授权已更改，请重新查询模型列表。');
      }
      const fetchedAt = now();
      const data = { models, fetchedAt, expiresAt: fetchedAt + modelsTtl };
      modelCatalog = { key, data };
      return { ...data, cacheHit: false };
    }).finally(() => {
      if (modelFlight === flight) modelFlight = null;
    });
    modelFlight = flight;
    return flight.promise;
  }

  function sendResponses(account, payload, signal) {
    signal?.throwIfAborted();
    return request(resource + '/responses', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + account.accessToken,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({ ...payload, store: false, stream: true }),
      signal,
    });
  }

  async function relayResponses(payload, signal, beforeSend) {
    const account = await authorized();
    signal?.throwIfAborted();
    await beforeSend();
    return { accountId: accountId(account), response: await sendResponses(account, payload, signal) };
  }

  return {
    login, complete, logout, models, relayResponses,
    currentAccountId: () => accountId(profile),
    status: () => ({
      signedIn: Boolean(profile?.accessToken),
      email: profile?.accessToken ? profile.email : '',
      known: Boolean(profile),
      expiresAt: profile?.expiresAt ?? null,
    }),
  };
}

export function createSseParser() {
  const decoder = new TextDecoder();
  let buffer = '';
  return function* parse(chunk) {
    buffer += decoder.decode(chunk, { stream: chunk !== undefined });
    let delimiter;
    while ((delimiter = /\r?\n\r?\n/.exec(buffer))) {
      const block = buffer.slice(0, delimiter.index);
      buffer = buffer.slice(delimiter.index + delimiter[0].length);
      const data = block.split(/\r?\n/).filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart()).join('\n');
      if (data && data !== '[DONE]') yield JSON.parse(data);
    }
    if (buffer.length > 4 * 1024 * 1024) throw new AppError(502, 'OpenAI 返回了过大的流事件。');
  };
}

export async function* streamEvents(body) {
  const reader = body.getReader();
  const parse = createSseParser();
  try {
    while (true) {
      const { value, done } = await reader.read();
      yield* parse(value);
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
