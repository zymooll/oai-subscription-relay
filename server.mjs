import { createServer } from 'node:http';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AppError, createOpenAI, nonce } from './openai.mjs';
import { createKeyStore } from './keys.mjs';
import { createPricing } from './pricing.mjs';
import { createRelay } from './relay.mjs';
import { createUsageStore, usageDays } from './usage.mjs';

const port = 41875;
const host = '127.0.0.1';
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/dashboard.css', ['dashboard.css', 'text/css; charset=utf-8']],
  ['/dashboard.js', ['dashboard.js', 'text/javascript; charset=utf-8']],
]);
const protections = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};

function dpapi(mode, bytes) {
  const action = mode === 'seal' ? 'Protect' : 'Unprotect';
  const command = [
    "$ErrorActionPreference='Stop'",
    "Add-Type -AssemblyName System.Security",
    '$data = [Convert]::FromBase64String([Console]::In.ReadToEnd())',
    '$out = [System.Security.Cryptography.ProtectedData]::' + action +
      '($data, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Console]::Out.Write([Convert]::ToBase64String($out))',
  ].join('; ');
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
    });
    let output = '';
    child.stdout.setEncoding('ascii').on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.stdin.on('error', reject);
    child.on('close', status => {
      if (status === 0 && output) resolve(Buffer.from(output, 'base64'));
      else reject(new Error('Windows DPAPI credential storage failed.'));
    });
    child.stdin.end(bytes.toString('base64'));
  });
}

async function atomicWrite(path, bytes) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, bytes, { flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function createWindowsVault(directory) {
  await mkdir(directory, { recursive: true });
  const hostPath = join(directory, 'host-id.txt');
  const vaultPath = join(directory, 'account.dpapi');
  let hostId;
  let profile = null;
  try {
    hostId = (await readFile(hostPath, 'utf8')).trim();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    hostId = 'urn:uuid:' + randomUUID();
    await atomicWrite(hostPath, hostId);
  }
  const sealed = await readFile(vaultPath).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (sealed) profile = JSON.parse(await dpapi('unseal', sealed));
  return {
    hostId, profile,
    async save(data) {
      const bytes = Buffer.from(JSON.stringify(data), 'utf8');
      await atomicWrite(vaultPath, await dpapi('seal', bytes));
    },
  };
}

async function legacyRelayKey(directory) {
  const sealed = await readFile(join(directory, 'relay-key.dpapi')).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (sealed) {
    const key = (await dpapi('unseal', sealed)).toString('ascii');
    if (!/^lrk_[A-Za-z0-9_-]{43}$/.test(key)) throw new Error('Invalid local relay key.');
    return key;
  }
  return null;
}

async function loadKeys(directory, initialize = false) {
  const path = join(directory, 'keys.json');
  const raw = await readFile(path, 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  const keys = createKeyStore({
    initial: raw === null ? null : JSON.parse(raw),
    write: data => atomicWrite(path, data),
    encrypt: async key => (await dpapi('seal', Buffer.from(key, 'ascii'))).toString('base64'),
    decrypt: async sealed => (await dpapi('unseal', Buffer.from(sealed, 'base64'))).toString('ascii'),
  });
  if (initialize && raw === null) {
    const previous = await legacyRelayKey(directory);
    await keys.create({ name: '默认密钥' }, previous ?? undefined);
  }
  if (initialize) await keys.recover();
  return keys;
}

async function loadUsageStore(directory) {
  const path = join(directory, 'usage.json');
  try {
    const raw = await readFile(path, 'utf8').catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    return createUsageStore({
      initial: raw === null ? null : JSON.parse(raw),
      write: data => atomicWrite(path, data),
    });
  } catch {
    console.error('The relay usage file could not be read. Usage will be kept in memory.');
    return createUsageStore();
  }
}

function response(res, status, body, mime = 'application/json; charset=utf-8', extraHeaders = {}) {
  res.writeHead(status, { ...protections, 'Content-Type': mime, ...extraHeaders });
  res.end(mime.startsWith('application/json') ? JSON.stringify(body) : body);
}

function hasSession(req, session) {
  const supplied = req.headers['x-local-session'];
  return typeof supplied === 'string' && supplied.length === session.length &&
    timingSafeEqual(Buffer.from(supplied, 'ascii'), Buffer.from(session, 'ascii'));
}

function instanceProof(session, challenge) {
  return createHmac('sha256', session).update(challenge).digest('base64url');
}

function newLaunchUrl(address, session) {
  const ticket = Date.now() + '.' + nonce();
  return address + '/open?ticket=' + ticket + '.' + instanceProof(session, 'open:' + ticket);
}

async function readJson(req, maxBytes = 1024 * 1024) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new AppError(415, '请输入 JSON 请求。');
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new AppError(413, '请求超过大小上限。');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AppError(400, '请求格式无效。');
  }
}

export function createApp({
  session, getOpenAI, getKeys, pricing = createPricing(),
  usage = createUsageStore(), onShutdown = () => {},
}) {
  let signingOut = false;
  const redeemed = new Map();
  const relay = createRelay({ getKeys, pricing, getOpenAI, isSigningOut: () => signingOut, usage, readJson, reply: response });
  const server = createServer(async (req, res) => {
    const authority = host + ':' + server.address().port;
    const origin = 'http://' + authority;
    if (req.headers.host !== authority || !req.url?.startsWith('/') || req.url.startsWith('//')) {
      return response(res, 403, { error: '请使用本机地址访问。' });
    }
    const url = new URL(req.url, origin);
    try {
      if (url.pathname === '/v1' || url.pathname.startsWith('/v1/')) {
        return await relay.handle(req, res, url);
      }
      const file = files.get(url.pathname);
      if (req.method === 'GET' && file) {
        return response(res, 200, await readFile(new URL(file[0], import.meta.url)), file[1]);
      }
      if (req.method === 'GET' && url.pathname === '/api/instance') {
        const challenge = url.searchParams.get('challenge');
        if (!/^[A-Za-z0-9_-]{43}$/.test(challenge ?? '')) {
          return response(res, 400, { error: '无效的启动校验。' });
        }
        return response(res, 200, { proof: instanceProof(session, challenge) });
      }
      if (req.method === 'GET' && url.pathname === '/open') {
        const match = /^(\d{13})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/.exec(url.searchParams.get('ticket') ?? '');
        const now = Date.now();
        for (const [key, expires] of redeemed) if (expires < now) redeemed.delete(key);
        const expires = match ? Number(match[1]) + 180000 : 0;
        if (!match || now > expires || expires > now + 180000 || redeemed.has(match[2]) ||
            !timingSafeEqual(Buffer.from(match[3]), Buffer.from(instanceProof(session, 'open:' + match[1] + '.' + match[2])))) {
          return response(res, 403, '启动链接已失效，请重新运行 start-relay.cmd。', 'text/plain; charset=utf-8');
        }
        redeemed.set(match[2], expires);
        res.writeHead(303, { ...protections, Location: '/#session=' + session });
        return res.end();
      }
      const openai = getOpenAI();
      if (req.method === 'GET' && url.pathname === '/auth/callback') {
        let result = 'success';
        try {
          await openai.complete(url.searchParams);
          relay.stop();
        } catch (error) {
          result = error instanceof AppError ? error.message : '无法保存授权，请返回中继管理台重试。';
        }
        res.writeHead(303, { ...protections, Location: '/#oauth=' + encodeURIComponent(result) });
        return res.end();
      }
      if (!hasSession(req, session) || (req.method === 'POST' && req.headers.origin !== origin)) {
        return response(res, 403, { error: '当前标签页未获得本机访问权限，请从启动程序打开。' });
      }
      if (req.method === 'GET' && url.pathname === '/api/status') {
        return response(res, 200, openai.status());
      }
      const keyAction = /^\/api\/keys\/([a-f0-9-]{36})\/(secret|edit|rotate|revoke)$/.exec(url.pathname);
      if (req.method === 'GET' && url.pathname === '/api/keys') {
        return response(res, 200, { keys: getKeys().list() });
      }
      if (req.method === 'GET' && keyAction?.[2] === 'secret') {
        return response(res, 200, { key: await getKeys().secret(keyAction[1]) });
      }
      if (req.method === 'GET' && url.pathname === '/api/prices') {
        return response(res, 200, await pricing.get());
      }
      if (signingOut) throw new AppError(409, '正在退出，请稍候。');
      if (req.method === 'GET' && url.pathname === '/api/models') {
        return response(res, 200, await openai.models());
      }
      if (req.method === 'GET' && url.pathname === '/api/usage') {
        const days = usageDays(url.searchParams);
        if (!days) throw new AppError(400, '天数需为 1 到 30 的整数。');
        return response(res, 200, usage.snapshot(openai.currentAccountId(), days));
      }
      if (req.method !== 'POST') return response(res, 404, { error: '找不到这个页面。' });
      const data = await readJson(req);
      if (url.pathname === '/api/login') {
        return response(res, 200, { url: openai.login(origin + '/auth/callback', data?.newAccount === true) });
      }
      if (url.pathname === '/api/models/refresh') {
        return response(res, 200, await openai.models({ refresh: true }));
      }
      if (url.pathname === '/api/prices/refresh') {
        return response(res, 200, await pricing.get({ force: true }));
      }
      if (url.pathname === '/api/keys') {
        return response(res, 201, await getKeys().create(data));
      }
      if (keyAction && keyAction[2] !== 'secret') {
        const [, id, action] = keyAction;
        return response(res, 200, await getKeys()[action](id, data));
      }
      if (url.pathname === '/api/logout') {
        signingOut = true;
        relay.stop();
        try {
          return response(res, 200, await openai.logout());
        } finally {
          signingOut = false;
        }
      }
      if (url.pathname === '/api/shutdown') {
        signingOut = true;
        relay.stop();
        res.once('finish', onShutdown);
        return response(res, 200, { closed: true });
      }
      return response(res, 404, { error: '找不到这个页面。' });
    } catch (error) {
      if (res.destroyed) return;
      const message = error instanceof AppError ? error.message :
        '请求未能完成。请重试；如果持续失败，请重新启动本机程序。';
      const status = error instanceof AppError ? error.status : 500;
      if (res.headersSent) res.destroy();
      else response(res, status, { error: message }, undefined, status === 413 ? { Connection: 'close' } : {});
    }
  });
  return server;
}

function openBrowser(address, session) {
  const browser = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', newLaunchUrl(address, session)], {
    detached: true, windowsHide: true, stdio: 'ignore',
  });
  browser.on('error', () => console.error('Could not open the default browser.'));
  browser.unref();
}

async function main() {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) {
    throw new Error('This MVP requires Windows and Node.js 22 or later.');
  }
  const session = nonce();
  const address = 'http://' + host + ':' + port;
  const directory = join(process.env.LOCALAPPDATA, 'ChatGPT-Chat-MVP');
  const instancePath = join(directory, 'instance.dpapi');
  async function existingSession() {
    const existing = (await dpapi('unseal', await readFile(instancePath))).toString('ascii');
    if (!/^[A-Za-z0-9_-]{43}$/.test(existing)) throw new Error('Invalid local session.');
    const challenge = nonce();
    const check = await fetch(address + '/api/instance?challenge=' + challenge, {
      redirect: 'error', signal: AbortSignal.timeout(2500),
    });
    if (!check.ok || (await check.json()).proof !== instanceProof(existing, challenge)) {
      throw new Error('The local relay is not running.');
    }
    return existing;
  }
  if (process.argv.includes('--launch-url')) {
    console.log(newLaunchUrl(address, await existingSession()));
    return;
  }
  const keyArgument = process.argv.indexOf('--relay-key');
  if (keyArgument !== -1) {
    const keys = await loadKeys(directory);
    const id = process.argv[keyArgument + 1] ?? keys.list().find(key => key.state === 'active')?.id;
    const key = id ? await keys.secret(id) : !keys.list().length ? await legacyRelayKey(directory) : null;
    if (!key) throw new Error('Start the relay and create an active key in the dashboard.');
    console.log(key);
    return;
  }
  let openai;
  let keys;
  const usage = await loadUsageStore(directory);
  const server = createApp({
    session, usage,
    getKeys: () => {
      if (!keys) throw new AppError(503, '本机密钥存储正在启动，请稍候。');
      return keys;
    },
    getOpenAI: () => {
      if (!openai) throw new AppError(503, '本机授权存储正在启动，请稍候。');
      return openai;
    },
    onShutdown: () => { server.close(); },
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
    openai = createOpenAI(await createWindowsVault(directory));
    keys = await loadKeys(directory, true);
    await atomicWrite(instancePath, await dpapi('seal', Buffer.from(session, 'ascii')));
    console.log('Relay dashboard: ' + address + '/');
    console.log('Responses relay: ' + address + '/v1');
    if (!process.argv.includes('--no-browser')) openBrowser(address, session);
  } catch (error) {
    server.close();
    if (error.code === 'EADDRINUSE') {
      try {
        openBrowser(address, await existingSession());
        return;
      } catch {
        throw new Error('Port 41875 is occupied or the relay is still starting. Try again in a moment.');
      }
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
