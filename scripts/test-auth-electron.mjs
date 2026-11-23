/**
 * Корпоративный режим и refresh токена с поддельным Keycloak (F21, ADR 0093).
 * Запуск: npx electron scripts/test-auth-electron.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { app, safeStorage } from 'electron';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-auth-'));
app.setPath('userData', sandbox);

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  OK   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name} ${String(extra).slice(0, 300)}`);
  }
}
const jwt = (payload) => `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`;

// Поддельный Keycloak: device flow, token (device_code и refresh_token), logout.
const kc = { roles: ['admin'], refresh: 'ok', expiresIn: 1, calls: [] };
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const params = Object.fromEntries(new URLSearchParams(body));
    kc.calls.push({ url: req.url, params });
    const send = (code, data) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (req.url.endsWith('/auth/device')) return send(200, { device_code: 'dc', user_code: 'ABCD', expires_in: 60, interval: 1 });
    if (req.url.endsWith('/logout')) return send(204, {});
    if (req.url.endsWith('/token')) {
      if (params.grant_type === 'refresh_token') {
        if (kc.refresh === 'revoked') return send(400, { error: 'invalid_grant', error_description: 'Token is not active' });
        if (kc.refresh === 'down') return send(503, { error: 'temporarily_unavailable' });
      }
      return send(200, { access_token: jwt({ realm_access: { roles: kc.roles }, name: 'Иван' }), refresh_token: `rt-${kc.calls.length}`, expires_in: kc.expiresIn, refresh_expires_in: 1800 });
    }
    send(404, {});
  });
});

app.whenReady().then(async () => {
  try {
    if (!safeStorage.isEncryptionAvailable() && process.platform === 'linux') safeStorage.setUsePlainTextEncryption(true);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const issuer = `http://127.0.0.1:${server.address().port}/realms/mai`;
    process.env.MAI_TEST_AUTH_POLICY = JSON.stringify({ required: true, issuer, clientId: 'mai-code-desktop' });
    const auth = await import('../electron/lib/auth.js');

    console.log('[1] до входа');
    let st = auth.authStatus();
    check('корпоративный режим: вход нужен, роли нет', st.required && !st.loggedIn && st.role === 'none' && st.issuer === issuer, JSON.stringify(st));
    let err = '';
    try {
      auth.requireAdmin();
    } catch (e) {
      err = e.message;
    }
    check('admin-вызовы — «Нужен вход»', /Нужен вход/.test(err), err);
    check('гейт: настройки закрыты, вход открыт', /Нужен вход/.test(auth.sessionGateFor('settings:get')) && auth.sessionGateFor('auth:login') === '');
    err = '';
    try {
      auth.setLocalRole('admin');
    } catch (e) {
      err = e.message;
    }
    check('локальную роль не выбрать', /Корпоративный режим/.test(err), err);
    err = '';
    try {
      auth.configureAuth({ issuer: 'http://evil' });
    } catch (e) {
      err = e.message;
    }
    check('адрес Keycloak не переопределить', /задан организацией/.test(err), err);

    console.log('[2] вход и роль из токена');
    st = await auth.loginKeycloak();
    check('вход: admin, Иван, гейт открыт', st.loggedIn && st.role === 'admin' && st.user?.name === 'Иван' && auth.sessionGateFor('settings:get') === '', JSON.stringify(st));
    check('PKCE и client_id из политики', kc.calls.some((c) => c.url.endsWith('/auth/device') && c.params.code_challenge_method === 'S256' && c.params.client_id === 'mai-code-desktop'));
    check('токены на диске зашифрованы', !fs.readFileSync(path.join(sandbox, 'auth.json'), 'utf8').includes('access_token'));

    console.log('[3] refresh');
    kc.roles = ['user'];
    kc.expiresIn = 300;
    st = await auth.ensureSession();
    const refreshCall = kc.calls.filter((c) => c.params.grant_type === 'refresh_token').at(-1);
    check('истёкший access — refresh, роль пересчитана (guest)', st.refreshed && st.loggedIn && st.role === 'guest' && refreshCall?.params.refresh_token, JSON.stringify(st));
    const before = kc.calls.length;
    st = await auth.ensureSession();
    check('действующий токен — без запроса', kc.calls.length === before && st.session === 'valid');

    console.log('[4] сбой и отзыв refresh');
    kc.roles = ['admin'];
    kc.expiresIn = 1;
    await auth.loginKeycloak();
    kc.refresh = 'down';
    st = await auth.ensureSession();
    check('Keycloak недоступен (503) — сессия остаётся, ошибка в статусе', st.loggedIn && /temporarily_unavailable|HTTP 503/.test(st.refreshError || ''), JSON.stringify(st));
    kc.refresh = 'revoked';
    st = await auth.ensureSession();
    check('refresh отозван — сессия закрыта, снова экран входа', st.expired && !st.loggedIn && st.role === 'none' && /Нужен вход/.test(auth.sessionGateFor('chat:start')), JSON.stringify(st));

    console.log('[5] выход');
    kc.refresh = 'ok';
    await auth.loginKeycloak();
    st = auth.logout();
    await new Promise((r) => setTimeout(r, 300));
    check('выход — не в локального admin, а на экран входа', st.required && !st.loggedIn && st.role === 'none', JSON.stringify(st));
    check('сессия на сервере закрыта (logout с refresh_token)', kc.calls.some((c) => c.url.endsWith('/logout') && c.params.refresh_token));
  } catch (e) {
    fail += 1;
    console.log(`  FAIL исключение: ${e?.stack || e}`);
  }
  server.close();
  console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
  try {
    fs.rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* временная папка */
  }
  app.exit(fail ? 1 : 0);
});
