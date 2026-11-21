/**
 * OAuth для удалённых MCP-серверов (CC9.2, ADR 0041): полный вход против
 * локального MCP-сервера с сервером авторизации (DCR, PKCE, state).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { McpManager } from '../electron/lib/mcp.js';
import { createOAuthStore, createOAuthProvider, startCallbackServer, clientMetadata } from '../electron/lib/mcp-oauth.js';

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  OK   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name} ${extra}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-oauth-'));
// Поддельный шифр: проверяем, что на диск не попадает открытый токен.
const box = {
  seal: (t) => `enc:v1:${Buffer.from(t).toString('base64')}`,
  open: (t) => Buffer.from(String(t).slice(7), 'base64').toString('utf8'),
};

/* ---------- сервер MCP + сервер авторизации ---------- */
const issued = { codes: new Map(), tokens: new Set(), registrations: 0, tokenCalls: 0 };
let base = '';
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const readBody = (req) => new Promise((r) => {
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', () => r(data));
});
const json = (res, status, body) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, base);
  if (url.pathname === '/.well-known/oauth-protected-resource' || url.pathname === '/.well-known/oauth-protected-resource/mcp') {
    return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base] });
  }
  if (url.pathname === '/.well-known/oauth-authorization-server') {
    return json(res, 200, {
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
  }
  if (url.pathname === '/register' && req.method === 'POST') {
    issued.registrations += 1;
    const body = JSON.parse(await readBody(req));
    return json(res, 201, { ...body, client_id: `client-${issued.registrations}`, client_id_issued_at: Math.floor(Date.now() / 1000) });
  }
  if (url.pathname === '/authorize') {
    const code = crypto.randomBytes(8).toString('hex');
    issued.codes.set(code, { challenge: url.searchParams.get('code_challenge'), redirect: url.searchParams.get('redirect_uri'), client: url.searchParams.get('client_id') });
    const back = new URL(url.searchParams.get('redirect_uri'));
    back.searchParams.set('code', code);
    back.searchParams.set('state', url.searchParams.get('state') || '');
    return res.writeHead(302, { Location: back.toString() }).end();
  }
  if (url.pathname === '/token' && req.method === 'POST') {
    issued.tokenCalls += 1;
    const form = new URLSearchParams(await readBody(req));
    const grant = issued.codes.get(form.get('code'));
    if (!grant) return json(res, 400, { error: 'invalid_grant' });
    const challenge = b64url(crypto.createHash('sha256').update(form.get('code_verifier') || '').digest());
    if (challenge !== grant.challenge || form.get('redirect_uri') !== grant.redirect) return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE' });
    issued.codes.delete(form.get('code'));
    const token = `tok-${crypto.randomBytes(6).toString('hex')}`;
    issued.tokens.add(token);
    return json(res, 200, { access_token: token, token_type: 'Bearer', expires_in: 3600, refresh_token: 'refresh-1' });
  }
  if (url.pathname === '/mcp') {
    const auth = String(req.headers.authorization || '');
    if (!auth.startsWith('Bearer ') || !issued.tokens.has(auth.slice(7))) {
      return res
        .writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` })
        .end(JSON.stringify({ error: 'invalid_token' }));
    }
    const mcpServer = new McpServer({ name: 'oauth-test', version: '1.0.0' });
    mcpServer.registerTool('whoami', { description: 'Кто я' }, async () => ({ content: [{ type: 'text', text: 'вы вошли' }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => transport.close());
    await mcpServer.connect(transport);
    const body = req.method === 'POST' ? JSON.parse((await readBody(req)) || 'null') : undefined;
    return transport.handleRequest(req, res, body);
  }
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
base = `http://127.0.0.1:${server.address().port}`;
const config = { url: `${base}/mcp` };

/* «Браузер»: идёт по редиректу сервера авторизации на наш адрес возврата. */
const opened = [];
async function browser(url) {
  opened.push(url);
  const first = await fetch(url, { redirect: 'manual' });
  const location = first.headers.get('location');
  if (location) await fetch(location);
}

console.log('[1] хранилище и провайдер');
const storeFile = path.join(tmp, 'mcp-oauth.json');
const store = createOAuthStore(storeFile, box);
store.update('s', { tokens: { access_token: 'secret-token' } });
check('токен на диске зашифрован', !fs.readFileSync(storeFile, 'utf8').includes('secret-token'));
check('чтение расшифровывает', store.get('s').tokens.access_token === 'secret-token' && store.has('s'));
store.clear('s');
check('очистка', !store.has('s'));
check('публичный клиент с PKCE', clientMetadata('http://127.0.0.1:1/callback').token_endpoint_auth_method === 'none');
const silent = createOAuthProvider({ server: 'x', store, redirectUrl: 'http://127.0.0.1:1/callback' });
let silentErr = null;
await silent.redirectToAuthorization(new URL('https://a.example/authorize')).catch((e) => (silentErr = e));
check('без входа по кнопке браузер не открывается', silentErr?.needsLogin === true);
const loud = createOAuthProvider({ server: 'x', store, redirectUrl: 'http://127.0.0.1:1/callback', onAuthorize: () => {} });
let httpErr = null;
await loud.redirectToAuthorization(new URL('http://evil.example/authorize')).catch((e) => (httpErr = e));
check('страница входа не по HTTPS отклоняется', /HTTPS/.test(httpErr?.message || ''));

console.log('[2] приём кода: state');
let state = 'good';
const cb = await startCallbackServer({ port: 0, expectedState: () => state, timeoutMs: 5000 });
const wrong = await fetch(`${cb.redirectUrl}?code=1&state=bad`);
check('чужой state — 400', wrong.status === 400);
const other = await fetch(cb.redirectUrl.replace('/callback', '/other'));
check('другой путь — 404', other.status === 404);
const okResp = await fetch(`${cb.redirectUrl}?code=abc&state=good`);
check('верный state — код принят', okResp.status === 200 && (await cb.code) === 'abc');
cb.close();
check('слушает только 127.0.0.1', cb.redirectUrl.startsWith('http://127.0.0.1:'));

console.log('[3] полный вход');
const manager = new McpManager({ oauth: { store, openBrowser: browser, callbackPort: 0 } });
// callbackPort 0 — случайный порт для теста; в фоне redirectUrl не нужен.
const before = await manager.connect('remote', config);
check('без входа — «нужен вход», браузер не открыт', before.needsAuth === true && opened.length === 0, JSON.stringify(before));
check('статус needs_auth', manager.status().find((s) => s.name === 'remote')?.status === 'needs_auth');
const login = await manager.login('remote', config);
check('вход выполнен, инструменты получены', login.ok === true && login.tools?.includes('whoami'), JSON.stringify(login));
check('браузер открыт на сервере авторизации с PKCE и state', opened.length === 1 && /\/authorize\?/.test(opened[0]) && /code_challenge_method=S256/.test(opened[0]) && /state=/.test(opened[0]), opened[0]);
check('клиент зарегистрирован (DCR)', issued.registrations === 1);
check('статус ready, вход сохранён', manager.status().find((s) => s.name === 'remote')?.status === 'ready' && manager.status()[0].loggedIn === true);
const answer = await manager.call('mcp__remote__whoami', {});
check('инструмент вызывается с токеном', answer === 'вы вошли', answer);
const disk = fs.readFileSync(storeFile, 'utf8');
check('на диске нет токена и verifier', ![...issued.tokens].some((t) => disk.includes(t)) && !disk.includes('code_verifier'));

console.log('[4] после перезапуска');
await manager.disconnect('remote');
const again = new McpManager({ oauth: { store: createOAuthStore(storeFile, box), openBrowser: browser, callbackPort: 0 } });
const reconnect = await again.connect('remote', config);
check('подключение без повторного входа', reconnect.ok === true && opened.length === 1, JSON.stringify(reconnect));
await again.disconnect('remote');
const moved = await again.connect('remote', { url: `${base}/mcp?moved=1` });
check('другой адрес сервера — токены не отправляются', moved.needsAuth === true, JSON.stringify(moved));

console.log('[5] выход и oauth: false');
await again.login('remote', config);
await again.logout('remote');
check('выход удаляет вход', !again.oauth.store.has('remote'));
const off = await again.connect('remote', { ...config, oauth: false });
check('oauth: false — понятная ошибка, браузер не открыт', off.ok === false && !off.needsAuth && /headers/.test(off.error) && opened.length === 2, JSON.stringify(off) + ' opened=' + opened.length);
const offLogin = await again.login('remote', { ...config, oauth: false });
check('oauth: false — вход не начинается', offLogin.ok === false && /выключен/.test(offLogin.error));
const stdio = await again.login('local', { command: 'node' });
check('stdio-серверу вход не нужен', stdio.ok === false && /HTTP/.test(stdio.error));

await again.disconnect('remote');
server.closeAllConnections?.();
server.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
