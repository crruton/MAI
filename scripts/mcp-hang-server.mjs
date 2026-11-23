/**
 * Тестовый stdio MCP-сервер для test-mcp-restart (F13): первый запуск «зависает»
 * на инструменте index (не отвечает), следующие — отвечают. Счётчик запусков —
 * в файле из аргумента.
 */
import fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const counter = process.argv[2];
const starts = (Number(fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8') : 0) || 0) + 1;
fs.writeFileSync(counter, String(starts));
const hang = starts === 1 || process.argv[3] === 'always';

const server = new McpServer({ name: 'hang', version: '1.0.0' });
server.registerTool('index', { description: 'чтение индекса', annotations: { readOnlyHint: true } }, async () => {
  if (hang) await new Promise(() => {});
  return { content: [{ type: 'text', text: `ok from start ${starts}` }] };
});
server.registerTool('write', { description: 'запись' }, async () => {
  if (hang) await new Promise(() => {});
  return { content: [{ type: 'text', text: `written ${starts}` }] };
});
server.registerTool('freeze', { description: 'блокирует процесс' }, async () => {
  for (;;) {
    /* event loop занят — ping не ответит */
  }
});
await server.connect(new StdioServerTransport());
