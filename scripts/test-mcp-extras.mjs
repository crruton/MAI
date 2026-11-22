/**
 * MCP: ресурсы (CC9.3), промпты (CC9.4), SSE для старых серверов (CC9.6), ADR 0071.
 */
import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import { McpManager } from '../electron/lib/mcp.js';
import { promptArgs, resolveResourceMentions } from '../electron/lib/commands.js';

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

function buildServer() {
  const s = new McpServer({ name: 'extras', version: '1.0.0' });
  s.registerTool('ping', { description: 'pong' }, async () => ({ content: [{ type: 'text', text: 'pong' }] }));
  s.registerResource('Схема БД', 'db://schema', { description: 'Таблицы', mimeType: 'text/plain' }, async (uri) => ({ contents: [{ uri: uri.href, text: 'users(id, name)\norders(id, user_id)' }] }));
  s.registerResource('Логотип', 'file:///logo.png', { mimeType: 'image/png' }, async (uri) => ({ contents: [{ uri: uri.href, blob: Buffer.from('PNGDATA').toString('base64'), mimeType: 'image/png' }] }));
  s.registerPrompt('review', { description: 'Ревью кода', argsSchema: { file: z.string(), focus: z.string().optional() } }, ({ file, focus }) => ({
    messages: [{ role: 'user', content: { type: 'text', text: `Проверь ${file}${focus ? ` с упором на ${focus}` : ''}` } }],
  }));
  return s;
}

const readBody = (req) =>
  new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });

// Современный сервер: streamable HTTP.
const modern = http.createServer(async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => transport.close());
  await server.connect(transport);
  const body = req.method === 'POST' ? JSON.parse((await readBody(req)) || 'null') : undefined;
  return transport.handleRequest(req, res, body);
});
// Старый сервер: только SSE (GET /sse + POST /messages).
const sseTransports = new Map();
let ssePosts = 0;
const legacy = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/sse') {
    const transport = new SSEServerTransport('/messages', res);
    sseTransports.set(transport.sessionId, transport);
    res.on('close', () => sseTransports.delete(transport.sessionId));
    await buildServer().connect(transport);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/messages') {
    ssePosts += 1;
    const transport = sseTransports.get(url.searchParams.get('sessionId'));
    if (!transport) return res.writeHead(404).end();
    return transport.handlePostMessage(req, res, JSON.parse(await readBody(req)));
  }
  res.writeHead(405).end('Method Not Allowed');
});
await new Promise((r) => modern.listen(0, '127.0.0.1', r));
await new Promise((r) => legacy.listen(0, '127.0.0.1', r));
const modernUrl = `http://127.0.0.1:${modern.address().port}/mcp`;
const legacyUrl = `http://127.0.0.1:${legacy.address().port}/sse`;

const mcp = new McpManager();
try {
  console.log('[1] разбор аргументов и упоминаний');
  const defs = [{ name: 'file' }, { name: 'focus' }];
  check('по порядку; лишнее — в последний', JSON.stringify(promptArgs(defs, 'src/a.js безопасность и тесты')) === JSON.stringify({ file: 'src/a.js', focus: 'безопасность и тесты' }));
  check('ключ=значение и кавычки', JSON.stringify(promptArgs(defs, 'focus=скорость "my file.js"')) === JSON.stringify({ focus: 'скорость', file: 'my file.js' }));
  const res = [{ server: 'db', uri: 'db://schema' }];
  check('известный ресурс находится, чужой — нет', resolveResourceMentions('глянь @db:db://schema, и @db:db://other и @file.js', res).length === 1);

  console.log('[2] streamable HTTP: ресурсы и промпты');
  const r1 = await mcp.connect('db', { url: modernUrl });
  check('подключён по streamable HTTP', r1.ok && mcp.status()[0].transport === 'http' && mcp.status()[0].resources === 2 && mcp.status()[0].prompts === 1, JSON.stringify(mcp.status()));
  const list = mcp.listResources();
  check('список ресурсов с именем и типом', list.some((r) => r.server === 'db' && r.uri === 'db://schema' && r.name === 'Схема БД' && r.mimeType === 'text/plain'), JSON.stringify(list));
  check('текст ресурса', (await mcp.readResource('db', 'db://schema')) === 'users(id, name)\norders(id, user_id)');
  check('двоичный ресурс — пометкой', /^\[двоичные данные image\/png, 7 байт\]$/.test(await mcp.readResource('db', 'file:///logo.png')));
  check('длинное обрезается', /обрезано/.test(await mcp.readResource('db', 'db://schema', { maxChars: 5 })));
  const prompts = mcp.listPrompts();
  check('промпт как команда с аргументами', prompts[0]?.command === 'mcp__db__review' && prompts[0].arguments.map((a) => `${a.name}:${a.required}`).join() === 'file:true,focus:false', JSON.stringify(prompts));
  check('промпт → текст запроса', (await mcp.getPrompt('mcp__db__review', promptArgs(prompts[0].arguments, 'app.js безопасность'))) === 'Проверь app.js с упором на безопасность');
  let err = '';
  await mcp.getPrompt('mcp__db__review', {}).catch((e) => (err = e.message));
  check('без обязательного аргумента — понятная ошибка', /нужны аргументы file/.test(err), err);
  check('инструменты на месте', mcp.toolSchemas().some((t) => t.function.name === 'mcp__db__ping'));

  console.log('[3] SSE для старых серверов');
  const r2 = await mcp.connect('old', { url: legacyUrl });
  check('без указания: streamable не вышел — подключился по SSE', r2.ok && mcp.status().find((s) => s.name === 'old')?.transport === 'sse', JSON.stringify(r2));
  check('инструмент по SSE работает', (await mcp.call('mcp__old__ping', {})) === 'pong' && ssePosts > 0);
  const r3 = await mcp.connect('old2', { url: legacyUrl, transport: 'sse' });
  check('transport: "sse" — сразу SSE', r3.ok && mcp.status().find((s) => s.name === 'old2')?.transport === 'sse');
  const r4 = await mcp.connect('strict', { url: legacyUrl, transport: 'http' });
  check('transport: "http" — без перехода на SSE', !r4.ok, JSON.stringify(r4));
  const r5 = await mcp.connect('cc', { url: legacyUrl, type: 'sse' });
  check('type: "sse" из .mcp.json Claude Code', r5.ok && mcp.status().find((s) => s.name === 'cc')?.transport === 'sse');
  check('ресурсы старого сервера тоже видны', mcp.listResources().some((r) => r.server === 'old'));
} catch (err) {
  fail += 1;
  console.log(`  FAIL исключение: ${err?.stack || err}`);
}
for (const name of ['db', 'old', 'old2', 'strict', 'cc']) await mcp.disconnect(name).catch(() => {});
modern.close();
legacy.closeAllConnections?.();
legacy.close();
console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
