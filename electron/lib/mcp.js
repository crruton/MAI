import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { createOAuthProvider, startCallbackServer, DEFAULT_CALLBACK_PORT, NeedsLoginError } from './mcp-oauth.js';

/**
 * Держит подключения к MCP-серверам из настроек.
 * Поддержаны два транспорта: локальный процесс (stdio) и HTTP (streamable http).
 * Для HTTP — OAuth (ADR 0041): вход только по кнопке «Войти», токены в
 * зашифрованном хранилище, обновление токена — в SDK.
 */
function withTimeout(promise, ms, message) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
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

  transportFor(name, config, authProvider) {
    return new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: config.headers ? { headers: config.headers } : undefined,
      ...(authProvider ? { authProvider } : {}),
    });
  }

  status() {
    return [...this.servers.entries()].map(([name, s]) => ({
      name,
      status: s.status,
      error: s.error || '',
      tools: (s.tools || []).map((t) => t.name),
      loggedIn: Boolean(this.oauth?.store?.has(name)),
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
    const entry = { status: 'connecting', error: '', client: null, tools: [] };
    this.servers.set(name, entry);
    try {
      const client = new Client({ name: 'mai-code', version: '0.1.0' }, { capabilities: {} });
      let transport;
      if (config.url) {
        transport = this.transportFor(name, config, this.authProviderFor(name, config));
      } else {
        if (!config.command) throw new Error('Нужен command или url');
        transport = new StdioClientTransport({
          command: config.command,
          args: config.args || [],
          env: { ...process.env, ...(config.env || {}) },
          cwd: config.cwd || undefined,
          stderr: 'pipe',
        });
      }
      await withTimeout(client.connect(transport), 30_000, 'MCP: нет ответа на initialize за 30 с');
      const { tools } = await withTimeout(client.listTools(), 15_000, 'MCP: нет списка инструментов за 15 с');
      entry.client = client;
      entry.tools = tools || [];
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

  async call(toolName, args) {
    const match = /^mcp__(.+?)__(.+)$/.exec(toolName);
    if (!match) throw new Error(`Не MCP-инструмент: ${toolName}`);
    const [, serverKey, rawTool] = match;
    const entry = [...this.servers.entries()].find(
      ([name]) => name.replace(/[^a-zA-Z0-9_-]/g, '_') === serverKey,
    )?.[1];
    if (!entry || entry.status !== 'ready') throw new Error(`MCP-сервер ${serverKey} не подключён`);
    const tool = entry.tools.find((t) => t.name.replace(/[^a-zA-Z0-9_-]/g, '_') === rawTool);
    if (!tool) throw new Error(`Инструмент ${rawTool} не найден на ${serverKey}`);
    const result = await withTimeout(
      entry.client.callTool({ name: tool.name, arguments: args || {} }),
      120_000,
      `MCP ${serverKey}: инструмент ${rawTool} не ответил за 120 с`,
    );
    const parts = (result.content || []).map((c) =>
      c.type === 'text' ? c.text : c.type === 'resource' ? `[resource ${c.resource?.uri}]` : `[${c.type}]`,
    );
    return parts.join('\n') || '(пустой ответ)';
  }
}
