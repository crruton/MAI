import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/**
 * Держит подключения к MCP-серверам из настроек.
 * Поддержаны два транспорта: локальный процесс (stdio) и HTTP (streamable http).
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

export class McpManager {
  constructor() {
    this.servers = new Map(); // name -> { status, error, client, tools }
  }

  status() {
    return [...this.servers.entries()].map(([name, s]) => ({
      name,
      status: s.status,
      error: s.error || '',
      tools: (s.tools || []).map((t) => t.name),
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
        transport = new StreamableHTTPClientTransport(new URL(config.url), {
          requestInit: config.headers ? { headers: config.headers } : undefined,
        });
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
      entry.status = 'error';
      entry.error = err?.message || String(err);
      return { ok: false, error: entry.error };
    }
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

  /** MCP-инструменты в формате OpenAI tools. */
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
