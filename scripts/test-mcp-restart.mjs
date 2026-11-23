/**
 * Перезапуск зависшего stdio MCP-сервера (F13, ADR 0088): таймаут вызова →
 * перезапуск процесса, повтор только для чтения; ping; счётчик в status().
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpManager } from '../electron/lib/mcp.js';
import { mcpConfig } from '../electron/lib/repowise.js';

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

const here = path.dirname(fileURLToPath(import.meta.url));
const serverScript = path.join(here, 'mcp-hang-server.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-mcp-restart-'));
const cfg = (name, extra = {}) => ({ command: process.execPath, args: [serverScript, path.join(tmp, `${name}.count`), ...(extra.mode ? [extra.mode] : [])], callTimeoutMs: 1500, ...extra });
const mcp = new McpManager();

try {
  console.log('[1] чтение: таймаут → перезапуск → повтор');
  await mcp.connect('rw', cfg('rw'));
  const t0 = Date.now();
  const out = await mcp.call('mcp__rw__index', {});
  const st = mcp.status().find((s) => s.name === 'rw');
  check('ответ после перезапуска', out === 'ok from start 2', out);
  check('ждали callTimeoutMs, а не 120 с', Date.now() - t0 < 10_000, Date.now() - t0);
  check('status: перезапуск, время и причина', st.restarts === 1 && st.lastRestartAt && /таймаут index/.test(st.lastTimeout) && st.status === 'ready', JSON.stringify(st));

  console.log('[2] запись не повторяется');
  await mcp.connect('wr', cfg('wr'));
  let err = '';
  await mcp.call('mcp__wr__write', {}).catch((e) => (err = e.message));
  check('ошибка с «перезапущен — повторите»', /не ответил за 2 с; сервер перезапущен — повторите запрос/.test(err), err);
  check('после перезапуска запись работает', (await mcp.call('mcp__wr__write', {})) === 'written 2');
  check('процесс запущен дважды', fs.readFileSync(path.join(tmp, 'wr.count'), 'utf8') === '2');

  console.log('[3] retryOnTimeout и restartOnTimeout: false');
  await mcp.connect('rt', cfg('rt', { retryOnTimeout: true }));
  check('retryOnTimeout — повтор и для записи', (await mcp.call('mcp__rt__write', {})) === 'written 2');
  await mcp.connect('nr', cfg('nr', { restartOnTimeout: false }));
  err = '';
  await mcp.call('mcp__nr__index', {}).catch((e) => (err = e.message));
  check('без перезапуска — просто таймаут', /не ответил за 2 с$/.test(err) && (mcp.status().find((s) => s.name === 'nr').restarts || 0) === 0, err);

  console.log('[4] всегда зависает — одна попытка перезапуска');
  await mcp.connect('al', cfg('al', { mode: 'always' }));
  err = '';
  await mcp.call('mcp__al__index', {}).catch((e) => (err = e.message));
  check('после повтора — ошибка таймаута, без цикла', /не ответил/.test(err) && mcp.status().find((s) => s.name === 'al').restarts === 1, err);

  console.log('[5] ping и ручной перезапуск');
  check('живой сервер отвечает на ping', (await mcp.checkHealth('rw')).ok);
  await mcp.connect('fz', cfg('fz'));
  mcp.call('mcp__fz__freeze', {}).catch(() => {});
  await new Promise((r) => setTimeout(r, 200));
  const h = await mcp.checkHealth('fz', { timeoutMs: 800 });
  check('занятый процесс: ping не ответил → перезапуск', h.restarted && h.ok && mcp.status().find((s) => s.name === 'fz').restarts >= 1, JSON.stringify(h));
  const r = await mcp.restart('rw');
  check('ручной перезапуск: +1, без причины-таймаута', r.ok && mcp.status().find((s) => s.name === 'rw').restarts === 2 && /таймаут/.test(mcp.status().find((s) => s.name === 'rw').lastTimeout));
  check('нет сервера — понятная ошибка', /не настроен/.test((await mcp.restart('nope')).error));
  check('checkHealth неизвестного — missing', (await mcp.checkHealth('nope')).status === 'missing');

  console.log('[6] конфиг repowise');
  const rc = mcpConfig(tmp);
  check('serve --no-ui, 60 с, перезапуск и повтор', rc.args.join(' ') === 'serve --no-ui' && rc.callTimeoutMs === 60_000 && rc.restartOnTimeout && rc.retryOnTimeout && rc.cwd === tmp);
} catch (e) {
  fail += 1;
  console.log(`  FAIL исключение: ${e?.stack || e}`);
} finally {
  for (const name of [...mcp.servers.keys()]) await mcp.disconnect(name);
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
