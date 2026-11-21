/**
 * Фоновые команды (CC1.4, ADR 0055).
 */
import { shellTools, backgroundTools, listBackground, disposeBackground, MAX_BACKGROUND } from '../electron/lib/tools/shell.js';
import { classifyTool, summarize } from '../electron/lib/policy.js';
import os from 'node:os';

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
const run = shellTools[0].run;
const output = backgroundTools.find((t) => t.schema.function.name === 'shell_output').run;
const kill = backgroundTools.find((t) => t.schema.function.name === 'shell_kill').run;
const ctx = { projectDir: os.tmpdir() };
const win = process.platform === 'win32';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Команда, печатающая строки раз в 200 мс.
const ticker = win
  ? 'for /L %i in (1,1,50) do @(echo tick %i & ping -n 2 127.0.0.1 >nul)'
  : 'for i in $(seq 1 50); do echo tick $i; sleep 0.2; done';

console.log('[1] запуск и вывод');
check('классы: shell_output и shell_kill — чтение', classifyTool('shell_output') === 'read' && classifyTool('shell_kill') === 'read');
check('в запросе разрешения видно «в фоне»', /в фоне/.test(summarize({ tool: 'run_shell', cls: 'exec', args: { background: true }, subject: 'npm run dev' })));
const started = await run(ctx, { command: ticker, background: true });
const id = /bg\d+/.exec(started)?.[0];
check('сразу возвращает id', Boolean(id) && /Запущено в фоне/.test(started), started);
await sleep(1500);
const first = await output(ctx, { id });
check('новый вывод и «работает»', /tick 1/.test(first) && /работает/.test(first), first);
await sleep(win ? 2500 : 800);
const second = await output(ctx, { id });
check('второй вызов — только новое', !/tick 1\b/.test(second.replace(/tick 1\d/g, '')) && /tick/.test(second), second);
check('all — весь буфер', /tick 1\b/.test(await output(ctx, { id, all: true })));
check('список фоновых', /работает/.test(await output(ctx, {})) && listBackground().some((b) => b.id === id && b.running));

console.log('[2] остановка');
const killed = await kill(ctx, { id });
check('shell_kill останавливает', /остановлена/.test(killed) && !listBackground().find((b) => b.id === id).running, killed);
check('повторно — уже завершена', /уже/.test(await kill(ctx, { id })));
check('неизвестный id', /Нет фоновой команды/.test(await output(ctx, { id: 'bg999' })));

console.log('[3] завершение и лимит');
const quick = /bg\d+/.exec(await run(ctx, { command: 'echo done-quick', background: true }))[0];
await sleep(1500);
check('завершилась — код в состоянии', /завершена с кодом 0/.test(await output(ctx, { id: quick })) );
const ids = [];
for (let i = 0; i < MAX_BACKGROUND; i += 1) ids.push(/bg\d+/.exec(await run(ctx, { command: ticker, background: true }))?.[0]);
const over = await run(ctx, { command: ticker, background: true });
check(`не больше ${MAX_BACKGROUND} одновременно`, /Уже запущено 5/.test(over), over);
disposeBackground();
await sleep(1500);
check('disposeBackground останавливает все', listBackground().every((b) => !b.running), JSON.stringify(listBackground()));
const blocked = await run({ ...ctx, shellSandbox: { mode: 'docker' }, dockerAvailable: () => false }, { command: 'echo x', background: true });
check('песочница без Docker — тоже отказ', /Docker недоступен/.test(blocked));

console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
