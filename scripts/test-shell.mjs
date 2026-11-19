/**
 * Проверяет, что run_shell не оборачивает команду в `repowise distill`,
 * когда repowise не установлен. Раньше префикс добавлялся всегда, и каждая
 * команда падала с «не является внутренней командой».
 */
import { shellTools, execute } from '../electron/lib/tools/shell.js';
import { DEFAULT_GUARDRAILS } from '../electron/lib/guardrails.js';

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

const ctx = {
  projectDir: process.cwd(),
  allowOutsideProject: false,
  guardrails: DEFAULT_GUARDRAILS,
  // distill включён — именно этот случай ломался.
  repowise: { enabled: true, distill: true },
  approve: () => Promise.resolve(true),
};

const runShell = shellTools.find((t) => t.schema.function.name === 'run_shell');

console.log('\n[1] Команда выполняется без префикса repowise');
const result = await runShell.run(ctx, { command: 'echo MAI_SHELL_OK' });
check('команда выполнена', result.includes('MAI_SHELL_OK'), result.slice(0, 200));
check('нет ошибки «не является внутренней командой»', !/не является внутренней/i.test(result), result.slice(0, 200));
check('нет упоминания repowise в выводе', !/repowise/i.test(result), result.slice(0, 200));

console.log('\n[2] Код возврата передаётся');
const failed = await runShell.run(ctx, { command: 'exit /b 3' });
check('ненулевой код виден в выводе', /3/.test(failed), failed.slice(0, 200));

console.log('\n[3] Живой вывод и «Стоп» (CC7.4)');
{
  const win = process.platform === 'win32';
  const chunks = [];
  const live = await execute(win ? 'echo one && echo two' : 'echo one; echo two', process.cwd(), { onData: (t) => chunks.push(t) });
  check('вывод приходит по мере работы', chunks.join('').includes('one') && chunks.join('').includes('two'), JSON.stringify(chunks));
  check('итог тот же, что и раньше', /\[код 0/.test(live), live.slice(-60));
  if (!win) {
    const ac = new AbortController();
    const started = Date.now();
    setTimeout(() => ac.abort(), 400);
    const marker = `mai-stop-${process.pid}`;
    const out = await execute(`echo start; sleep 7 & sleep 7; echo ${marker}`, process.cwd(), { signal: ac.signal });
    check('«Стоп» останавливает команду сразу', Date.now() - started < 3000, `${Date.now() - started} мс`);
    const body = out.split('\n').slice(1).join('\n'); // без строки «$ команда»
    check('в выводе отмечена остановка', /остановлено пользователем/.test(out) && !body.includes(marker), out.slice(0, 200));
    await new Promise((r) => setTimeout(r, 300));
    const { execSync } = await import('node:child_process');
    let left = '';
    try {
      // [p] — чтобы pgrep не нашёл собственную оболочку с этим же текстом.
      left = execSync('pgrep -f "slee[p] 7"', { encoding: 'utf8' }).trim();
    } catch {
      left = '';
    }
    check('дочерние процессы тоже остановлены', !left, left);
  }
  const pre = new AbortController();
  pre.abort();
  check('остановлено до запуска — процесс не стартует', /до запуска/.test(await execute('echo x', process.cwd(), { signal: pre.signal })));
}

console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
