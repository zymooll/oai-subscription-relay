const el = id => document.getElementById(id);
const fragments = new URLSearchParams(location.hash.slice(1));
const authorizationResult = fragments.get('oauth');
if (fragments.has('session')) sessionStorage.setItem('local-session', fragments.get('session'));
if (location.hash) history.replaceState(null, '', location.pathname);

const session = sessionStorage.getItem('local-session');
const base = location.origin + '/v1';
const number = new Intl.NumberFormat('zh-CN');
const date = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const dateTime = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' });
const usd = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 9,
});
const editor = el('key-editor');
const confirmDialog = el('confirm-key-dialog');
const usageFields = ['inputTokens', 'outputTokens', 'totalTokens'];
let account = null;
let models = null;
let prices = {};
let keys = [];
let editedKey = null;
let confirmedAction = null;
let keyQuery = 0;
let modelQuery = 0;
let usageQuery = 0;
let loadingPrices = false;
let loadingModels = false;
let busy = false;
let stopped = false;

el('base-url').textContent = base;

function notice(message, error = false) {
  el('notice').textContent = message;
  el('notice').hidden = !message;
  el('notice').classList.toggle('error', error);
}

function pill(id, label, state = '') {
  const element = el(id);
  element.textContent = label;
  element.className = 'pill' + (state ? ' ' + state : '');
}

async function local(path, body) {
  const headers = { 'X-Local-Session': session };
  const options = { headers };
  if (body !== undefined) {
    options.method = 'POST';
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const response = await fetch('/api' + path, options).catch(() => {
    throw new Error('无法连接本机中继，请重新启动程序。');
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? '本机中继请求失败。');
  return data;
}

function renderAccount() {
  const active = account && !stopped;
  const connected = Boolean(active && account.signedIn);
  const locked = !active || busy;
  pill('service-status', stopped ? '服务已关闭' : active ? '服务在线' : '未连接', active ? 'online' : '');
  const expired = connected && account.expiresAt && account.expiresAt <= Date.now();
  pill('account-state', expired ? '等待续期' : connected ? '已授权' : '未授权', expired ? 'warning' : connected ? 'online' : '');
  el('account-email').textContent = connected ? account.email || 'ChatGPT 账号' : '—';
  el('account-expiry').textContent = connected && account.expiresAt ? date.format(account.expiresAt) : '—';
  el('login').textContent = connected ? '重新授权' : '使用 ChatGPT 登录';
  el('switch-account').hidden = !active || !account.known;
  el('logout').hidden = !connected;
  for (const id of ['login', 'switch-account', 'logout', 'shutdown']) el(id).disabled = locked;
  for (const id of ['new-key', 'refresh-keys']) el(id).disabled = locked;
  for (const button of el('key-rows').querySelectorAll('button')) button.disabled = locked;
  for (const id of ['usage-period', 'refresh-usage', 'model-filter']) el(id).disabled = locked || !connected;
  el('refresh-models').disabled = locked || !connected || loadingModels;
  el('refresh-prices').disabled = locked || loadingPrices;
}

async function readStatus() {
  account = await local('/status');
  renderAccount();
}

function row(values, codeIndex = -1) {
  const tr = document.createElement('tr');
  for (const [index, value] of values.entries()) {
    const cell = document.createElement('td');
    if (value instanceof Node) {
      cell.append(value);
    } else if (index === codeIndex) {
      const code = document.createElement('code');
      code.textContent = value;
      cell.append(code);
    } else {
      cell.textContent = value;
    }
    tr.append(cell);
  }
  return tr;
}

function renderModels() {
  const filter = el('model-filter').value.trim().toLowerCase();
  const visible = models?.filter(model => (model.name + ' ' + model.id).toLowerCase().includes(filter)) ?? [];
  const fields = ['input', 'output', 'cacheRead', 'cacheWrite'];
  el('model-rows').replaceChildren(...visible.map(model => {
    const quote = Object.hasOwn(prices, model.id) ? prices[model.id] : null;
    const amounts = fields.map(field => {
      const value = document.createElement('span');
      value.className = 'price-number';
      value.textContent = quote?.[field] == null ? '—' : usd.format(quote[field]);
      if (quote?.tiers?.length) {
        value.title = quote.tiers.filter(tier => tier[field] !== null)
          .map(tier => '输入超过 ' + number.format(tier.aboveInputTokens) + ' tokens：' + usd.format(tier[field]))
          .join('\n');
      }
      return value;
    });
    return row([model.name, model.id, ...amounts], 1);
  }));
  el('model-table').hidden = visible.length === 0;
  el('model-empty').hidden = !models || visible.length > 0;
  el('model-empty').textContent = models?.length ? '没有匹配的模型。' : '当前账号没有可用的套餐模型。';
}

async function loadPrices(force = false) {
  if (loadingPrices || stopped) return;
  loadingPrices = true;
  renderAccount();
  const message = el('price-status');
  message.textContent = ' 正在查询价格…';
  try {
    const result = force ? await local('/prices/refresh', {}) : await local('/prices');
    prices = result.quotes;
    const updated = result.fetchedAt ? ' 更新于 ' + date.format(result.fetchedAt) + '。' : '';
    message.textContent = result.unavailable
      ? (updated ? ' 刷新失败，显示缓存。' + updated : ' 暂时无法获取报价。')
      : updated;
    renderModels();
  } catch (error) {
    message.textContent = ' ' + error.message;
  } finally {
    loadingPrices = false;
    renderAccount();
  }
}

async function loadModels(refresh = false) {
  const query = ++modelQuery;
  if (!account?.signedIn || stopped) {
    models = null;
    loadingModels = false;
    el('model-cache').textContent = '连接 ChatGPT 后查询模型列表。';
    renderModels();
    renderAccount();
    return;
  }
  loadingModels = true;
  renderAccount();
  el('model-cache').textContent = '正在查询模型列表…';
  try {
    const result = refresh ? await local('/models/refresh', {}) : await local('/models');
    if (query !== modelQuery) return;
    models = result.models;
    const source = result.cacheHit ? '缓存命中' : '已从 OpenAI 更新';
    el('model-cache').textContent = models.length + ' 个模型 · ' + source + ' · 缓存有效至 ' + date.format(result.expiresAt);
    renderModels();
  } catch (error) {
    if (query !== modelQuery) return;
    el('model-cache').textContent = models ? '刷新失败，当前显示上次列表。' + error.message : error.message;
  } finally {
    if (query === modelQuery) {
      loadingModels = false;
      await readStatus().catch(() => { renderAccount(); });
      if (!account?.signedIn) {
        loadModels();
        loadUsage();
      }
    }
  }
}

function tokenValues(metrics) {
  return usageFields.map(field => metrics.requests > 0 && metrics.tokenReports === 0
    ? '—' : number.format(metrics[field]));
}

function renderUsage(result) {
  const cells = ['usage-requests', 'usage-input', 'usage-output', 'usage-total'];
  const values = result ? [number.format(result.totals.requests), ...tokenValues(result.totals)] : cells.map(() => '—');
  cells.forEach((id, index) => { el(id).textContent = values[index]; });
  const daily = result?.daily?.filter(day => day.requests).reverse() ?? [];
  el('usage-rows').replaceChildren(...daily.map(day => row([day.date, number.format(day.requests), ...tokenValues(day)])));
  el('usage-days').hidden = !daily.length;
}

async function loadUsage() {
  const query = ++usageQuery;
  const detail = el('usage-detail');
  if (!account?.signedIn || stopped) {
    detail.textContent = '连接 ChatGPT 后查看本机用量。';
    renderUsage(null);
    return;
  }
  detail.textContent = '正在读取本机用量…';
  try {
    const result = await local('/usage?days=' + el('usage-period').value);
    if (query !== usageQuery) return;
    renderUsage(result);
    const summary = [result.totals.requests
      ? '其中 ' + number.format(result.totals.tokenReports) + ' 次返回了 token 用量。'
      : '所选期间暂无记录。'];
    if (result.lastLimitAt) summary.push('最近一次上游限流 ' + date.format(result.lastLimitAt) + '。');
    if (!result.persistent) summary.push('本机用量暂时无法写入磁盘。');
    detail.textContent = summary.join(' ');
  } catch (error) {
    if (query !== usageQuery) return;
    renderUsage(null);
    detail.textContent = error.message;
  }
}

async function control(action) {
  if (busy || stopped || !account) return;
  busy = true;
  notice('');
  renderAccount();
  try {
    await action();
  } catch (error) {
    notice(error.message, true);
  } finally {
    busy = false;
    renderAccount();
  }
}

function authorize(newAccount) {
  return control(async () => {
    const result = await local('/login', { newAccount });
    location.assign(result.url);
  });
}

async function copy(value, label) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    throw new Error('浏览器无法写入剪贴板。');
  }
  notice(label + '已复制。');
}

function keyButton(label, action) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'button compact';
  button.textContent = label;
  button.addEventListener('click', action);
  return button;
}

function stack(heading, ...details) {
  const item = document.createElement('div');
  item.className = 'key-stack';
  if (heading) {
    const title = document.createElement('strong');
    title.textContent = heading;
    item.append(title);
  }
  for (const text of details) {
    if (!text) continue;
    const detail = document.createElement('small');
    detail.textContent = text;
    item.append(detail);
  }
  return item;
}

function limitDisplay(name, used, limit, format) {
  return name + ' ' + format(used) + (limit === null ? '' : ' / ' + format(limit));
}

function renderKeys() {
  const rows = keys.map(key => {
    const { usage, limits } = key;
    const reached = ['requests', 'tokens', 'estimatedUsd'].some(field => limits[field] !== null && usage[field] >= limits[field]);
    const state = { active: reached ? '已达上限' : '有效', expired: '已到期', revoked: '已撤销' }[key.state];
    const actions = document.createElement('div');
    actions.className = 'key-actions';
    if (key.state !== 'revoked') {
      actions.append(
        keyButton('复制', () => control(async () => {
          const { key: value } = await local('/keys/' + key.id + '/secret');
          try {
            await copy(value, '中继 API Key');
          } catch {
            throw new Error('浏览器无法写入剪贴板。可运行 node server.mjs --relay-key ' + key.id + ' 读取密钥。');
          }
        })),
        keyButton('编辑', () => editKey(key)),
        keyButton('换新', () => confirmKey(key, 'rotate')),
        keyButton('撤销', () => confirmKey(key, 'revoke')),
      );
    }
    return row([
      stack(key.name, '••••••••' + key.suffix + ' · ' + state),
      stack(null, key.allowedModels?.join('、') ?? '全部模型',
        key.expiresAt === null ? '永不过期' : '到期 ' + dateTime.format(key.expiresAt)),
      stack(null,
        limitDisplay('请求', usage.requests, limits.requests, number.format),
        limitDisplay('RPM', usage.rpm, limits.rpm, number.format),
        limitDisplay('Tokens', usage.tokens, limits.tokens, number.format),
        limitDisplay('估算', usage.estimatedUsd, limits.estimatedUsd, usd.format),
        usage.inFlight ? '进行中 ' + number.format(usage.inFlight) : '',
        usage.unreported ? '缺少 token 用量 ' + number.format(usage.unreported) + ' 次' : '',
        usage.unpriced ? '缺少价格估算 ' + number.format(usage.unpriced) + ' 次' : ''),
      actions,
    ]);
  });
  el('key-rows').replaceChildren(...rows);
  el('key-table').hidden = !rows.length;
  const active = keys.filter(key => key.state === 'active').length;
  el('key-count').textContent = rows.length ? keys.length + ' 把密钥 · ' + active + ' 把有效' : '尚未创建密钥。';
  renderAccount();
}

async function loadKeys() {
  const query = ++keyQuery;
  try {
    const result = await local('/keys');
    if (query !== keyQuery) return;
    keys = result.keys;
    renderKeys();
  } catch (error) {
    if (query === keyQuery) el('key-count').textContent = error.message;
  }
}

function editKey(key = null) {
  editedKey = key;
  el('key-editor-title').textContent = key ? '编辑密钥' : '创建密钥';
  el('key-form').reset();
  el('key-error').hidden = true;
  const selected = new Set(key?.allowedModels ?? []);
  const catalog = new Map((models ?? []).map(model => [model.id, model.name]));
  for (const id of selected) if (!catalog.has(id)) catalog.set(id, id);
  const choices = [...catalog].map(([id, name]) => {
    const label = document.createElement('label');
    label.className = 'check';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = id;
    checkbox.checked = selected.has(id);
    label.append(checkbox, name);
    return label;
  });
  el('model-options').replaceChildren(...(choices.length ? choices : ['刷新模型列表后即可选择。']));
  el('allow-all-models').checked = !key || key.allowedModels === null;
  el('model-options').hidden = el('allow-all-models').checked;
  el('key-name').value = key?.name ?? '';
  if (key?.expiresAt) {
    const time = new Date(key.expiresAt);
    el('key-expiry').value = new Date(time.getTime() - time.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }
  el('key-limit-requests').value = key?.limits.requests ?? '';
  el('key-limit-rpm').value = key?.limits.rpm ?? '';
  el('key-limit-tokens').value = key?.limits.tokens ?? '';
  el('key-limit-cost').value = key?.limits.estimatedUsd ?? '';
  editor.showModal();
}

function confirmKey(key, action) {
  confirmedAction = { id: key.id, action };
  const rotate = action === 'rotate';
  el('confirm-key-title').textContent = rotate ? '换发密钥？' : '撤销密钥？';
  el('confirm-key-message').textContent = rotate
    ? '当前密钥将立即失效。此密钥的模型权限和已用额度将继续保留。'
    : '撤销后，该密钥无法发起新请求。';
  el('confirm-key-button').textContent = rotate ? '换发密钥' : '撤销密钥';
  confirmDialog.returnValue = 'cancel';
  confirmDialog.showModal();
}

async function saveKey(event) {
  event.preventDefault();
  if (busy || stopped) return;
  const nullableNumber = id => el(id).value === '' ? null : el(id).valueAsNumber;
  const expiry = el('key-expiry').value;
  const body = {
    name: el('key-name').value,
    expiresAt: expiry ? new Date(expiry).getTime() : null,
    allowedModels: el('allow-all-models').checked ? null
      : [...el('model-options').querySelectorAll('input:checked')].map(input => input.value),
    limits: {
      requests: nullableNumber('key-limit-requests'), rpm: nullableNumber('key-limit-rpm'),
      tokens: nullableNumber('key-limit-tokens'),
      estimatedUsd: nullableNumber('key-limit-cost'),
    },
  };
  const errorBox = el('key-error');
  busy = true;
  errorBox.hidden = true;
  el('save-key').disabled = true;
  renderAccount();
  try {
    await local(editedKey ? '/keys/' + editedKey.id + '/edit' : '/keys', body);
    editor.close();
    await loadKeys();
    notice(editedKey ? '密钥策略已更新。' : '密钥已创建。');
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  } finally {
    el('save-key').disabled = false;
    busy = false;
    renderAccount();
  }
}

el('login').addEventListener('click', () => authorize(false));
el('switch-account').addEventListener('click', () => authorize(true));
el('logout').addEventListener('click', () => control(async () => {
  const result = await local('/logout', {});
  await readStatus();
  await Promise.all([loadModels(), loadUsage()]);
  notice(result.confirmed ? '已退出 ChatGPT 授权。' : '本机授权已清除。可在 ChatGPT 设置中检查远端连接。');
}));
el('shutdown').addEventListener('click', () => control(async () => {
  await local('/shutdown', {});
  stopped = true;
  ++keyQuery;
  ++modelQuery;
  ++usageQuery;
  notice('本机中继已关闭。重新运行启动程序可以恢复服务。');
}));
el('copy-url').addEventListener('click', () => copy(base, 'Base URL').catch(error => notice(error.message, true)));
el('new-key').addEventListener('click', () => editKey());
el('refresh-keys').addEventListener('click', loadKeys);
el('allow-all-models').addEventListener('change', () => {
  el('model-options').hidden = el('allow-all-models').checked;
});
el('cancel-key-edit').addEventListener('click', () => editor.close());
el('key-form').addEventListener('submit', saveKey);
confirmDialog.addEventListener('close', () => {
  if (confirmDialog.returnValue !== 'confirm' || !confirmedAction) return;
  const { id, action } = confirmedAction;
  control(async () => {
    await local('/keys/' + id + '/' + action, {});
    await loadKeys();
    notice(action === 'rotate' ? '新密钥已生成。复制它并更新客户端设置。' : '密钥已撤销。');
  });
});
el('refresh-models').addEventListener('click', () => loadModels(true));
el('refresh-prices').addEventListener('click', () => loadPrices(true));
el('model-filter').addEventListener('input', renderModels);
el('refresh-usage').addEventListener('click', loadUsage);
el('usage-period').addEventListener('change', loadUsage);

async function initialize() {
  if (!session) {
    renderAccount();
    notice('请运行 start-relay.cmd 打开本机中继管理台。', true);
    return;
  }
  try {
    await readStatus();
    if (authorizationResult) {
      notice(authorizationResult === 'success' ? 'ChatGPT 套餐授权已连接。' : authorizationResult,
        authorizationResult !== 'success');
    }
    await Promise.all([loadKeys(), loadModels(), loadPrices(), loadUsage()]);
  } catch (error) {
    renderAccount();
    notice(error.message, true);
  }
}

initialize();
