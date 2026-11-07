/**
 * Проверяет, что run_shell не оборачивает команду в `repowise distill`,
 * когда repowise не установлен. Раньше префикс добавлялся всегда, и каждая
 * команда падала с «не является внутренней командой».
 */
import { shellTools } from '../electron/lib/tools/shell.js';
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

console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
