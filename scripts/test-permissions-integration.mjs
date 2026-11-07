/**
 * Интеграционный тест режимов разрешений.
 *
 * Проверяет связку «режим → approve → реальный инструмент → файл на диске».
 * Модульные тесты в test-permissions.mjs проверяют только decide(). Здесь
 * важно убедиться, что отказ действительно останавливает запись, а не
 * проглатывается из-за нестрогой проверки `if (!allowed)`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fsTools } from '../electron/lib/tools/fs.js';
import { shellTools } from '../electron/lib/tools/shell.js';
import { decide } from '../electron/lib/permissions.js';
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

const project = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-perm-'));
const target = path.join(project, 'note.txt');
fs.writeFileSync(target, 'исходный текст', 'utf8');

const tool = (name) => {
  const found = [...fsTools, ...shellTools].find((t) => t.schema.function.name === name);
  if (!found) throw new Error(`нет инструмента ${name}`);
  return found;
};

/** Собирает ctx так же, как это делает agent.js. */
function makeCtx(mode, { answer = true } = {}) {
  const asked = []; // вызовы approve — инструмент зовёт его всегда
  const prompted = []; // только те, где пользователю реально показали диалог
  const ctx = {
    projectDir: project,
    allowOutsideProject: false,
    guardrails: DEFAULT_GUARDRAILS,
    approve: (name, summary) => {
      asked.push({ name, summary });
      const decision = decide({ mode, tool: name });
      if (decision.action === 'allow') return Promise.resolve(true);
      if (decision.action === 'deny') return Promise.resolve(decision.reason);
      prompted.push({ name, summary });
      return Promise.resolve(answer);
    },
  };
  return { ctx, asked, prompted };
}

console.log('\n[1] Режим «План»: файл не меняется');
{
  const { ctx, prompted } = makeCtx('plan');
  const result = await tool('write_file').run(ctx, { path: 'note.txt', content: 'ВЗЛОМ' });
  check('write_file вернул причину отказа', /План/.test(result), result);
  check('файл на диске не изменён', fs.readFileSync(target, 'utf8') === 'исходный текст');
  check('пользователя не спрашивали', prompted.length === 0, JSON.stringify(prompted));
}

console.log('\n[2] Режим «План»: edit_file не меняет файл');
{
  const { ctx } = makeCtx('plan');
  const result = await tool('edit_file').run(ctx, {
    path: 'note.txt',
    old_string: 'исходный',
    new_string: 'изменённый',
  });
  check('edit_file вернул причину отказа', /План/.test(result), result);
  check('файл на диске не изменён', fs.readFileSync(target, 'utf8') === 'исходный текст');
}

console.log('\n[3] Режим «План»: команда не выполняется');
{
  const { ctx } = makeCtx('plan');
  const result = await tool('run_shell').run(ctx, { command: 'echo should-not-run' });
  check('run_shell вернул причину отказа', /План/.test(result), result);
  check('вывода команды нет', !result.includes('should-not-run'), result);
}

console.log('\n[4] Режим «Авто»: запись проходит без вопроса');
{
  const { ctx, prompted } = makeCtx('auto');
  const result = await tool('write_file').run(ctx, { path: 'note.txt', content: 'авто' });
  check('write_file сообщил об успехе', /Записано/.test(result), result);
  check('файл изменён', fs.readFileSync(target, 'utf8') === 'авто');
  check('пользователя не спрашивали', prompted.length === 0, JSON.stringify(prompted));
}

console.log('\n[5] Режим «Вручную»: отказ пользователя останавливает запись');
{
  fs.writeFileSync(target, 'ручной', 'utf8');
  const { ctx, asked } = makeCtx('manual', { answer: false });
  const result = await tool('write_file').run(ctx, { path: 'note.txt', content: 'нельзя' });
  check('пользователя спросили', asked.length === 1, JSON.stringify(asked));
  check('write_file вернул отказ', /отклонил/.test(result), result);
  check('файл не изменён', fs.readFileSync(target, 'utf8') === 'ручной');
}

console.log('\n[6] Режим «Вручную»: согласие пользователя пропускает запись');
{
  const { ctx, asked } = makeCtx('manual', { answer: true });
  const result = await tool('write_file').run(ctx, { path: 'note.txt', content: 'согласовано' });
  check('пользователя спросили', asked.length === 1);
  check('write_file сообщил об успехе', /Записано/.test(result), result);
  check('файл изменён', fs.readFileSync(target, 'utf8') === 'согласовано');
}

console.log('\n[7] Режим «Принимать правки»: запись без вопроса, команда с вопросом');
{
  const { ctx, prompted } = makeCtx('acceptEdits', { answer: false });
  const write = await tool('write_file').run(ctx, { path: 'note.txt', content: 'правки' });
  check('write_file прошёл без вопроса', /Записано/.test(write), write);
  check('файл изменён', fs.readFileSync(target, 'utf8') === 'правки');
  check('про запись не спрашивали', prompted.length === 0, JSON.stringify(prompted));

  const shell = await tool('run_shell').run(ctx, { command: 'echo hello' });
  check('про команду спросили', prompted.length === 1, JSON.stringify(prompted));
  check('отказ остановил команду', /отклонил/.test(shell), shell);
}

console.log('\n[8] Guardrails сильнее режима «Авто»');
{
  const { ctx } = makeCtx('auto');
  const result = await tool('run_shell').run(ctx, { command: 'rm -rf /' });
  check('опасная команда заблокирована', /Guardrails/.test(result), result);
}

console.log('\n[9] Секретный файл не пишется даже в «Авто»');
{
  const { ctx } = makeCtx('auto');
  let error = '';
  try {
    await tool('write_file').run(ctx, { path: '.env', content: 'SECRET=1' });
  } catch (err) {
    error = err?.message || String(err);
  }
  check('запись .env отклонена', /секретн/i.test(error), error);
  check('.env не создан', !fs.existsSync(path.join(project, '.env')));
}

fs.rmSync(project, { recursive: true, force: true });

console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
