import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { createOAuthProvider, startCallbackServer, DEFAULT_CALLBACK_PORT, NeedsLoginError } from './mcp-oauth.js';

/**
 * Держит подключения к MCP-серверам из настроек.
 * Транспорты: локальный процесс (stdio), streamable HTTP и SSE для старых
 * серверов (CC9.6, ADR 0071): `transport: "sse"` — сразу SSE; без указания —
 * streamable HTTP, а если сервер его не понимает (не ошибка входа) — SSE.
 * Кроме инструментов — ресурсы (CC9.3) и промпты (CC9.4), если сервер их даёт.
 * Для HTTP — OAuth (ADR 0041): вход только по кнопке «Войти», токены в
 * зашифрованном хранилище, обновление токена — в SDK.
 */
function withTimeout(promise, ms, message, signal) {
  let timer = null;
  let onAbort = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(message), { mcpTimeout: true })), ms);
    }),
    // Остановка пользователем рвёт ожидание сразу, а не через 120 с.
    ...(signal
      ? [
          new Promise((_, reject) => {
            onAbort = () => reject(new Error('Остановлено пользователем'));
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
          }),
        ]
      : []),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  });
}

/** Явно заданный транспорт: `transport` или `type` из .mcp.json Claude Code. '' — не задан. */
export function declaredTransport(config = {}) {
  const raw = String(config.transport || config.type || '').toLowerCase();
  if (raw === 'sse') return 'sse';
  if (raw === 'http' || raw === 'streamable-http' || raw === 'streamablehttp') return 'http';
  return '';
}

function isAuthError(err) {
  return err instanceof UnauthorizedError || err instanceof NeedsLoginError || err?.needsLogin || err?.code === 401 || /\b401\b|unauthori[sz]ed|invalid_token/i.test(err?.message || '');
}

export class McpManager {
  /**
   * @param {object} [options]
   * @param {object} [options.oauth] { store, openBrowser(url), callbackPort }
   */
  constructor({ oauth = null } = {}) {
    this.servers = new Map(); // name -> { status, error, client, tools }
    this.oauth = oauth;
    // Перезапуски зависших stdio-серверов (F13): переживают переподключение.
    this.health = new Map(); // name -> { restarts, lastRestartAt, lastTimeout }
  }

  redirectUrl() {
    return `http://127.0.0.1:${this.oauth?.callbackPort || DEFAULT_CALLBACK_PORT}/callback`;
  }

  /** OAuth-провайдер для HTTP-сервера; null — OAuth выключен для сервера или нет хранилища. */
  authProviderFor(name, config, { onAuthorize = null, redirectUrl = this.redirectUrl() } = {}) {
    if (!this.oauth?.store || !config.url || config.oauth === false) return null;
    const saved = this.oauth.store.get(name);
    // Другой адрес сервера — старые токены не отправляем.
    if (saved.url && saved.url !== config.url) this.oauth.store.clear(name);
    if (saved.url !== config.url) this.oauth.store.update(name, { url: config.url });
    return createOAuthProvider({ server: name, store: this.oauth.store, redirectUrl, onAuthorize });
  }

  transportFor(name, config, authProvider, kind = declaredTransport(config) || 'http') {
    const options = {
      requestInit: config.headers ? { headers: config.headers } : undefined,
      ...(authProvider ? { authProvider } : {}),
    };
    return kind === 'sse' ? new SSEClientTransport(new URL(config.url), options) : new StreamableHTTPClientTransport(new URL(config.url), options);
  }

  status() {
    return [...this.servers.entries()].map(([name, s]) => ({
      name,
      status: s.status,
      error: s.error || '',
      tools: (s.tools || []).map((t) => t.name),
      resources: (s.resources || []).length,
      prompts: (s.prompts || []).length,
      transport: s.transport || '',
      loggedIn: Boolean(this.oauth?.store?.has(name)),
      restarts: this.health.get(name)?.restarts || 0,
      lastRestartAt: this.health.get(name)?.lastRestartAt || '',
      lastTimeout: this.health.get(name)?.lastTimeout || '',
    }));
  }

  async disconnect(name) {
    const entry = this.servers.get(name);
    if (!entry) return;
    try {
      await entry.client?.close();
    } catch {
      /* уже закрыт */
    }
    this.servers.delete(name);
  }

  async connect(name, config) {
    await this.disconnect(name);
    const entry = { status: 'connecting', error: '', client: null, tools: [], resources: [], prompts: [], transport: '', config };
    this.servers.set(name, entry);
    try {
      let client = new Client({ name: 'mai-code', version: '0.1.0' }, { capabilities: {} });
      let transport;
      if (config.url) {
        const declared = declaredTransport(config);
        const kind = declared || 'http';
        transport = this.transportFor(name, config, this.authProviderFor(name, config), kind);
        entry.transport = kind;
        try {
          await withTimeout(client.connect(transport), 30_000, 'MCP: нет ответа на initialize за 30 с');
        } catch (err) {
          // Старый сервер только с SSE (CC9.6): пробуем его, если транспорт не задан явно.
          if (declared || isAuthError(err)) throw err;
          try {
            await client.close();
          } catch {
            /* не открылся */
          }
          client = new Client({ name: 'mai-code', version: '0.1.0' }, { capabilities: {} });
          transport = this.transportFor(name, config, this.authProviderFor(name, config), 'sse');
          entry.transport = 'sse';
          await withTimeout(client.connect(transport), 30_000, `MCP: ни streamable HTTP, ни SSE (${err?.message || err})`);
        }
      } else {
        if (!config.command) throw new Error('Нужен command или url');
        transport = new StdioClientTransport({
          command: config.command,
          args: config.args || [],
          env: { ...process.env, ...(config.env || {}) },
          cwd: config.cwd || undefined,
          stderr: 'pipe',
        });
        entry.transport = 'stdio';
        await withTimeout(client.connect(transport), 30_000, 'MCP: нет ответа на initialize за 30 с');
      }
      const caps = client.getServerCapabilities?.() || {};
      const { tools } = caps.tools === undefined && (caps.resources || caps.prompts) ? { tools: [] } : await withTimeout(client.listTools(), 15_000, 'MCP: нет списка инструментов за 15 с');
      entry.client = client;
      entry.tools = tools || [];
      // Ресурсы и промпты (CC9.3, CC9.4): сбой списка не ломает подключение.
      if (caps.resources) entry.resources = await withTimeout(client.listResources(), 15_000, 'MCP: нет списка ресурсов').then((r) => r.resources || [], () => []);
      if (caps.prompts) entry.prompts = await withTimeout(client.listPrompts(), 15_000, 'MCP: нет списка промптов').then((r) => r.prompts || [], () => []);
      entry.status = 'ready';
      return { ok: true, tools: entry.tools.map((t) => t.name) };
    } catch (err) {
      if (config.url && config.oauth === false && isAuthError(err)) {
        entry.status = 'error';
        entry.error = 'сервер требует авторизацию: задайте заголовок Authorization в headers или уберите oauth: false';
        return { ok: false, error: `MCP ${name}: ${entry.error}` };
      }
      if (config.url && isAuthError(err)) {
        entry.status = 'needs_auth';
        entry.error = 'нужен вход';
        return { ok: false, needsAuth: true, error: `MCP ${name}: нужен вход — нажмите «Войти»` };
      }
      entry.status = 'error';
      entry.error = err?.message || String(err);
      return { ok: false, error: entry.error };
    }
  }

  /**
   * Вход через браузер (ADR 0041): поднимает приём кода на 127.0.0.1, открывает
   * страницу входа, ждёт код, обменивает его на токены и подключается заново.
   */
  async login(name, config) {
    if (!config?.url) return { ok: false, error: 'Вход нужен только HTTP-серверам' };
    if (!this.oauth?.store || typeof this.oauth.openBrowser !== 'function') return { ok: false, error: 'OAuth недоступен' };
    if (config.oauth === false) return { ok: false, error: 'OAuth для сервера выключен (oauth: false)' };
    await this.disconnect(name);
    let provider = null;
    const callback = await startCallbackServer({
      port: this.oauth.callbackPort || DEFAULT_CALLBACK_PORT,
      expectedState: () => provider?.expectedState(),
      timeoutMs: this.oauth.timeoutMs,
    });
    let opened = false;
    try {
      // Клиент зарегистрирован на другой адрес возврата — регистрируемся заново.
      const saved = this.oauth.store.get(name);
      if (saved.client && !(saved.client.redirect_uris || []).includes(callback.redirectUrl)) this.oauth.store.update(name, { client: undefined });
      provider = this.authProviderFor(name, config, {
        redirectUrl: callback.redirectUrl,
        onAuthorize: async (url) => {
          opened = true;
          await this.oauth.openBrowser(url.toString());
        },
      });
      const transport = this.transportFor(name, config, provider);
      const client = new Client({ name: 'mai-code', version: '0.1.0' }, { capabilities: {} });
      try {
        await withTimeout(client.connect(transport), 30_000, 'MCP: нет ответа на initialize за 30 с');
        // Токен уже был и подошёл — вход не понадобился.
        await client.close().catch(() => {});
      } catch (err) {
        if (!opened || !isAuthError(err)) throw err;
        const code = await callback.code;
        await transport.finishAuth(code);
        await client.close().catch(() => {});
      }
      return await this.connect(name, config);
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    } finally {
      callback.close();
    }
  }

  /** Выход: токены и регистрация клиента удаляются, сервер отключается. */
  async logout(name) {
    this.oauth?.store?.clear(name);
    await this.disconnect(name);
    return { ok: true };
  }

  async sync(configs = {}) {
    for (const name of [...this.servers.keys()]) {
      if (!configs[name]) await this.disconnect(name);
    }
    const results = {};
    for (const [name, config] of Object.entries(configs)) {
      if (config.disabled) {
        await this.disconnect(name);
        continue;
      }
      const current = this.servers.get(name);
      if (current?.status === 'ready') continue;
      results[name] = await this.connect(name, config);
    }
    return results;
  }

  /**
   * MCP-инструменты в формате OpenAI tools. Поле `annotations` (readOnlyHint,
   * destructiveHint) нужно PolicyEngine; в запрос к модели оно не уходит.
   */
  toolSchemas() {
    const schemas = [];
    for (const [server, entry] of this.servers) {
      if (entry.status !== 'ready') continue;
      for (const tool of entry.tools) {
        schemas.push({
          type: 'function',
          function: {
            name: `mcp__${server}__${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64),
            description: `[MCP ${server}] ${tool.description || tool.name}`,
            parameters: tool.inputSchema || { type: 'object', properties: {} },
          },
          annotations: tool.annotations || {},
        });
      }
    }
    return schemas;
  }

  async call(toolName, args, signal) {
    const match = /^mcp__(.+?)__(.+)$/.exec(toolName);
    if (!match) throw new Error(`Не MCP-инструмент: ${toolName}`);
    const [, serverKey, rawTool] = match;
    const entry = [...this.servers.entries()].find(
      ([name]) => name.replace(/[^a-zA-Z0-9_-]/g, '_') === serverKey,
    )?.[1];
    if (!entry || entry.status !== 'ready') throw new Error(`MCP-сервер ${serverKey} не подключён`);
    const tool = entry.tools.find((t) => t.name.replace(/[^a-zA-Z0-9_-]/g, '_') === rawTool);
    if (!tool) throw new Error(`Инструмент ${rawTool} не найден на ${serverKey}`);
    const name = [...this.servers.entries()].find(([, e]) => e === entry)[0];
    const timeoutMs = Number(entry.config?.callTimeoutMs) > 0 ? Number(entry.config.callTimeoutMs) : 120_000;
    const invoke = (e) =>
      withTimeout(
        e.client.callTool({ name: tool.name, arguments: args || {} }),
        timeoutMs,
        `MCP ${serverKey}: инструмент ${rawTool} не ответил за ${Math.round(timeoutMs / 1000)} с`,
        signal,
      );
    let result;
    try {
      result = await invoke(entry);
    } catch (err) {
      // Зависший локальный сервер (F13, ADR 0088): перезапуск процесса; повтор —
      // только для инструментов «только чтение» (readOnlyHint или retryOnTimeout).
      if (!err?.mcpTimeout || entry.transport !== 'stdio' || entry.config?.restartOnTimeout === false) throw err;
      const restarted = await this.restart(name, `таймаут ${rawTool}`);
      const canRetry = restarted.ok && (tool.annotations?.readOnlyHint === true || entry.config?.retryOnTimeout === true);
      if (!canRetry) throw new Error(`${err.message}; сервер ${restarted.ok ? 'перезапущен — повторите запрос' : `не перезапустился: ${restarted.error}`}`);
      const fresh = this.servers.get(name);
      const again = fresh?.tools.find((t) => t.name === tool.name);
      if (fresh?.status !== 'ready' || !again) throw new Error(`${err.message}; после перезапуска инструмента нет`);
      result = await invoke(fresh);
    }
    const parts = (result.content || []).map((c) =>
      c.type === 'text' ? c.text : c.type === 'resource' ? `[resource ${c.resource?.uri}]` : `[${c.type}]`,
    );
    return parts.join('\n') || '(пустой ответ)';
  }

  /**
   * Перезапуск сервера (F13): закрыть процесс и подключиться заново с той же
   * конфигурацией. Счётчик и время — в status().
   */
  async restart(name, reason = 'вручную') {
    const entry = this.servers.get(name);
    if (!entry?.config) return { ok: false, error: `MCP-сервер ${name} не настроен` };
    const h = this.health.get(name) || { restarts: 0, lastRestartAt: '', lastTimeout: '' };
    h.restarts += 1;
    h.lastRestartAt = new Date().toISOString();
    if (reason !== 'вручную') h.lastTimeout = `${h.lastRestartAt} · ${reason}`;
    this.health.set(name, h);
    return this.connect(name, entry.config);
  }

  /**
   * Проверка «жив ли» (F13): ping с таймаутом; нет ответа у stdio — перезапуск.
   */
  async checkHealth(name, { timeoutMs = 10_000 } = {}) {
    const entry = this.servers.get(name);
    if (!entry) return { ok: false, status: 'missing' };
    if (entry.status !== 'ready') return { ok: false, status: entry.status, error: entry.error };
    try {
      await withTimeout(entry.client.ping(), timeoutMs, `MCP ${name}: нет ответа на ping за ${Math.round(timeoutMs / 1000)} с`);
      return { ok: true, status: 'ready' };
    } catch (err) {
      if (entry.transport !== 'stdio' || entry.config?.restartOnTimeout === false) return { ok: false, status: 'unresponsive', error: err.message };
      const res = await this.restart(name, 'нет ответа на ping');
      return { ok: Boolean(res.ok), status: this.servers.get(name)?.status || 'error', restarted: true, error: res.ok ? '' : res.error };
    }
  }

  /* ---------- ресурсы и промпты (CC9.3, CC9.4, ADR 0071) ---------- */

  /** Сервер по имени или по безопасному ключу (как в mcp__ключ__…). */
  entryFor(server) {
    const key = String(server || '');
    const found = this.servers.get(key) || [...this.servers.entries()].find(([name]) => name.replace(/[^a-zA-Z0-9_-]/g, '_') === key)?.[1];
    if (!found || found.status !== 'ready') throw new Error(`MCP-сервер ${key} не подключён`);
    return found;
  }

  /** Ресурсы подключённых серверов: [{ server, uri, name, description, mimeType }]. */
  listResources() {
    const out = [];
    for (const [server, entry] of this.servers) {
      if (entry.status !== 'ready') continue;
      for (const r of entry.resources || []) out.push({ server, uri: r.uri, name: r.name || r.uri, description: r.description || '', mimeType: r.mimeType || '' });
    }
    return out;
  }

  /** Текст ресурса; двоичное — пометкой. Длинное обрезается. */
  async readResource(server, uri, { maxChars = 50_000, signal } = {}) {
    const entry = this.entryFor(server);
    const result = await withTimeout(entry.client.readResource({ uri }), 60_000, `MCP ${server}: ресурс ${uri} не прочитан за 60 с`, signal);
    const text = (result.contents || [])
      .map((c) => (typeof c.text === 'string' ? c.text : `[двоичные данные ${c.mimeType || ''}, ${Buffer.byteLength(String(c.blob || ''), 'base64')} байт]`))
      .join('\n');
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n… обрезано (${text.length} символов)` : text;
  }

  /** Промпты: [{ server, name, command, description, arguments: [{ name, description, required }] }]. */
  listPrompts() {
    const out = [];
    for (const [server, entry] of this.servers) {
      if (entry.status !== 'ready') continue;
      for (const p of entry.prompts || []) {
        out.push({
          server,
          name: p.name,
          command: `mcp__${server}__${p.name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64),
          description: p.description || '',
          arguments: (p.arguments || []).map((a) => ({ name: a.name, description: a.description || '', required: a.required === true })),
        });
      }
    }
    return out;
  }

  /** Промпт → текст запроса агенту. Сообщения сервера склеиваются по порядку. */
  async getPrompt(command, args = {}, { signal } = {}) {
    const prompt = this.listPrompts().find((p) => p.command === command);
    if (!prompt) throw new Error(`Промпт /${command} не найден`);
    const missing = prompt.arguments.filter((a) => a.required && !String(args[a.name] ?? '').trim()).map((a) => a.name);
    if (missing.length) throw new Error(`/${command}: нужны аргументы ${missing.join(', ')}`);
    const entry = this.entryFor(prompt.server);
    const result = await withTimeout(entry.client.getPrompt({ name: prompt.name, arguments: Object.fromEntries(Object.entries(args).map(([k, v]) => [k, String(v)])) }), 60_000, `MCP ${prompt.server}: промпт ${prompt.name} не ответил`, signal);
    return (result.messages || [])
      .map((m) => {
        const c = m.content || {};
        const text = c.type === 'text' ? c.text : c.type === 'resource' ? c.resource?.text || `[ресурс ${c.resource?.uri}]` : `[${c.type}]`;
        return result.messages.length > 1 && m.role === 'assistant' ? `(ассистент) ${text}` : text;
      })
      .join('\n\n');
  }
}
