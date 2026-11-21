/**
 * OAuth для удалённых MCP-серверов (бэклог CC9.2, ADR 0041).
 *
 * Сервер по HTTP отвечает 401 — SDK находит сервер авторизации, регистрирует
 * клиента (Dynamic Client Registration) и просит открыть страницу входа.
 * Мы открываем её в браузере и ждём возврата на `http://127.0.0.1:<порт>/callback`,
 * проверяем `state`, передаём код в SDK. PKCE — в SDK.
 *
 * Токены и данные клиента — в `<данные>/mcp-oauth.json`, зашифрованные
 * хранилищем ОС (тот же secretBox, что и ключи провайдеров, ADR 0031).
 *
 * Модуль не зависит от Electron: шифр, открытие браузера и путь передаются.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEFAULT_CALLBACK_PORT = 33418;
const AUTH_TIMEOUT_MS = 5 * 60_000;

/** Хранилище: { [server]: { client, tokens, verifier, url } } — значения зашифрованы целиком. */
export function createOAuthStore(file, box) {
  const read = () => {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      return raw && typeof raw === 'object' ? raw : {};
    } catch {
      return {};
    }
  };
  const write = (data) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, file);
  };
  const get = (server) => {
    const sealed = read()[server];
    if (!sealed) return {};
    const text = box ? box.open(sealed) : sealed;
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      return {};
    }
  };
  const set = (server, value) => {
    const data = read();
    if (value) data[server] = box ? box.seal(JSON.stringify(value)) : JSON.stringify(value);
    else delete data[server];
    write(data);
  };
  return {
    get,
    update(server, patch) {
      set(server, { ...get(server), ...patch });
    },
    clear(server) {
      set(server, null);
    },
    /** Есть ли сохранённый вход (без расшифровки токенов в ответ). */
    has(server) {
      return Boolean(get(server).tokens?.access_token);
    },
  };
}

/** Данные приложения как OAuth-клиента: публичный клиент с PKCE, без секрета. */
export function clientMetadata(redirectUrl) {
  return {
    client_name: 'MAI Code',
    redirect_uris: [redirectUrl],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
}

/**
 * OAuthClientProvider для SDK. `onAuthorize(url)` вызывается, когда нужен вход;
 * без него (фоновое подключение) вход не начинается — сервер получит статус
 * «нужен вход», и браузер не откроется сам при запуске приложения.
 */
export function createOAuthProvider({ server, store, redirectUrl, onAuthorize = null }) {
  let state = null;
  return {
    get redirectUrl() {
      return redirectUrl;
    },
    get clientMetadata() {
      return clientMetadata(redirectUrl);
    },
    state() {
      state = crypto.randomBytes(16).toString('hex');
      return state;
    },
    expectedState: () => state,
    clientInformation: () => store.get(server).client,
    saveClientInformation: (client) => store.update(server, { client }),
    tokens: () => store.get(server).tokens,
    saveTokens: (tokens) => store.update(server, { tokens, savedAt: Date.now() }),
    saveCodeVerifier: (verifier) => store.update(server, { verifier }),
    codeVerifier: () => {
      const verifier = store.get(server).verifier;
      if (!verifier) throw new Error('Нет PKCE verifier — начните вход заново');
      return verifier;
    },
    invalidateCredentials: (scope) => {
      const current = store.get(server);
      if (scope === 'all') store.clear(server);
      else if (scope === 'tokens') store.update(server, { tokens: undefined });
      else if (scope === 'client') store.update(server, { client: undefined });
      else if (scope === 'verifier') store.update(server, { verifier: undefined });
      return current;
    },
    async redirectToAuthorization(url) {
      if (!onAuthorize) throw new NeedsLoginError(server);
      const target = new URL(String(url));
      if (target.protocol !== 'https:' && !(target.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(target.hostname))) {
        throw new Error(`Страница входа не по HTTPS: ${target.origin}`);
      }
      await onAuthorize(target);
    },
  };
}

export class NeedsLoginError extends Error {
  constructor(server) {
    super(`MCP ${server}: нужен вход — откройте «MCP» и нажмите «Войти»`);
    this.needsLogin = true;
  }
}

const PAGE = (title, text) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;margin:48px"><h2>${title}</h2><p>${text}</p></body>`;

/**
 * Ждёт возврата из браузера. Принимает один запрос `/callback` с верным `state`;
 * остальные — 404/400. Слушает только 127.0.0.1.
 * @returns {Promise<{ redirectUrl: string, code: Promise<string>, close(): void }>}
 */
export function startCallbackServer({ port = DEFAULT_CALLBACK_PORT, expectedState, timeoutMs = AUTH_TIMEOUT_MS } = {}) {
  return new Promise((resolveStart, rejectStart) => {
    let settle;
    let fail;
    const code = new Promise((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    code.catch(() => {});
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get('error');
      const state = url.searchParams.get('state');
      const value = url.searchParams.get('code');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (expectedState() && state !== expectedState()) {
        res.writeHead(400).end(PAGE('Вход не выполнен', 'Неверный параметр state. Начните вход заново из MAI Code.'));
        return;
      }
      if (error || !value) {
        res.writeHead(400).end(PAGE('Вход не выполнен', `Сервер авторизации ответил: ${String(error || 'нет кода').replace(/[<>&]/g, '')}.`));
        fail(new Error(`Вход отклонён: ${error || 'нет кода'}`));
        return;
      }
      res.writeHead(200).end(PAGE('Готово', 'Вход выполнен. Окно можно закрыть и вернуться в MAI Code.'));
      settle(value);
    });
    const timer = setTimeout(() => fail(new Error('Вход не завершён за 5 минут')), timeoutMs);
    const close = () => {
      clearTimeout(timer);
      server.close();
      fail(new Error('Вход отменён'));
    };
    code.finally(() => {
      clearTimeout(timer);
      setTimeout(() => server.close(), 100);
    }).catch(() => {});
    server.on('error', (err) =>
      rejectStart(err.code === 'EADDRINUSE' ? new Error(`Порт ${port} для возврата из браузера занят — задайте другой oauth.callbackPort`) : err),
    );
    server.listen(port, '127.0.0.1', () => {
      resolveStart({ redirectUrl: `http://127.0.0.1:${server.address().port}/callback`, code, close });
    });
  });
}
