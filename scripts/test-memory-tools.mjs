import { runToolCall, toolEntry } from '../electron/lib/tool-runner.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { memoryTools } from '../electron/lib/tools/memory.js';
import { readMemoryState } from '../electron/lib/memory.js';
import { decide, hiddenToolsForMode, isReadTool, isWriteTool } from '../electron/lib/permissions.js';

/**
 * Тест инструментов памяти агента: memory_read и memory_append.
 * Проверяет чтение, дописывание, версии, дубли, лимиты и режимы разрешений.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-mem-'));
const project = path.join(tmp, 'project');
fs.mkdirSync(path.join(project, '.mai-code'), { recursive: true });

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

const readTool = memoryTools.find((t) => t.schema.function.name === 'memory_read');
const appendTool = memoryTools.find((t) => t.schema.function.name === 'memory_append');

function ctx(approveResult = true) {
  const calls = [];
  return {
    calls,
    projectDir: project,
    approve: async (tool, reason) => {
      calls.push({ tool, reason });
      return approveResult;
    },
  };
}

console.log('[1] Схемы инструментов');
check('memory_read объявлен', Boolean(readTool));
check('memory_append объявлен', Boolean(appendTool));
check('memory_read без обязательных полей', !readTool.schema.function.parameters.required);
check(
  'memory_append требует text',
  JSON.stringify(appendTool.schema.function.parameters.required) === '["text"]',
  JSON.stringify(appendTool.schema.function.parameters.required),
);
check(
  'scope ограничен project и global',
  JSON.stringify(appendTool.schema.function.parameters.properties.scope.enum) === '["project","global"]',
  JSON.stringify(appendTool.schema.function.parameters.properties.scope.enum),
);

console.log('\n[2] memory_read на пустой памяти');
const emptyRead = await readTool.run(ctx(), {});
check('пустая память читается без ошибки', typeof emptyRead === 'string' && emptyRead.length > 0);
check('видно, что пусто', emptyRead.includes('(пусто)'), emptyRead.slice(0, 200));
check('указан файл проекта', emptyRead.includes('.mai-code'), emptyRead.slice(0, 300));
check('версий 0', emptyRead.includes('версий: 0'), emptyRead.slice(0, 300));

console.log('\n[3] memory_append дописывает и создаёт версию');
const appendCtx = ctx(true);
const first = await appendTool.run(appendCtx, { text: '- Урок: edit_file не находит CRLF-фрагмент.' });
check('запись выполнена', first.includes('Память обновлена'), first);
check('указана версия v1', first.includes('v1'), first);
// ADR 0027: инструмент сам не спрашивает — это делает runToolCall.
check('инструмент сам подтверждение не запрашивает', appendCtx.calls.length === 0, JSON.stringify(appendCtx.calls));
{
  const asked = [];
  await runToolCall({
    entry: toolEntry(appendTool.schema, { source: 'builtin', run: appendTool.run }),
    args: { text: '- Проверка сводки: CRLF.' },
    ctx: { projectDir: project },
    policy: { getMode: () => 'manual', getRules: () => ({}) },
    approve: async (request) => {
      asked.push(request);
      return false;
    },
  });
  check('запрос через runToolCall с именем инструмента', asked[0]?.tool === 'memory_append', JSON.stringify(asked));
  check('в сводке запроса виден текст', /CRLF/.test(asked[0]?.summary || ''), asked[0]?.summary);
}

const file = path.join(project, '.mai-code', 'memory.md');
check('файл памяти создан', fs.existsSync(file));
check('текст в файле', fs.readFileSync(file, 'utf8').includes('CRLF-фрагмент'));

console.log('\n[4] Повторная запись того же текста не создаёт версию');
const dupCtx = ctx(true);
const dup = await appendTool.run(dupCtx, { text: '- Урок: edit_file не находит CRLF-фрагмент.' });
check('дубль обнаружен', dup.includes('уже есть в памяти'), dup);
check('подтверждение не запрашивалось', dupCtx.calls.length === 0, JSON.stringify(dupCtx.calls));
const stateAfterDup = readMemoryState(project);
check('версий по-прежнему 1', stateAfterDup.versions.project.length === 1, String(stateAfterDup.versions.project.length));

console.log('\n[5] Вторая запись создаёт версию v2');
const second = await appendTool.run(ctx(true), { text: '- Решение: BACKLOG.md — единственный источник статусов.' });
check('вторая запись выполнена', second.includes('v2'), second);
const state2 = readMemoryState(project);
check('версий 2', state2.versions.project.length === 2, String(state2.versions.project.length));
check('оба текста в файле', state2.project.includes('CRLF') && state2.project.includes('BACKLOG.md'));

console.log('\n[6] Отказ пользователя не меняет память');
const before = fs.readFileSync(file, 'utf8');
// С ADR 0027 разрешение спрашивает цикл агента (runToolCall), а не инструмент.
const deniedOutcome = await runToolCall({
  entry: toolEntry(appendTool.schema, { source: 'builtin', run: appendTool.run }),
  args: { text: '- Не должно попасть в файл.' },
  ctx: { projectDir: project },
  policy: { getMode: () => 'acceptEdits', getRules: () => ({}) },
  approve: async () => ({ allow: false }),
});
const denied = deniedOutcome.content;
check('отказ возвращён текстом', denied.includes('отклонил'), denied);
check('в «Принимать правки» память спрашивает (F3)', deniedOutcome.decision.action === 'ask');
check('файл не изменился', fs.readFileSync(file, 'utf8') === before);
check('версий по-прежнему 2', readMemoryState(project).versions.project.length === 2);

console.log('\n[7] Пустой текст и лимит');
const emptyText = await appendTool.run(ctx(true), { text: '   ' });
check('пустой текст отклонён', emptyText.includes('Пустой текст'), emptyText);
let tooLong = '';
try {
  await appendTool.run(ctx(true), { text: 'x'.repeat(20_001) });
} catch (err) {
  tooLong = err.message;
}
check('слишком длинный блок отклонён', /Слишком длинный блок/.test(tooLong), tooLong);

console.log('\n[8] Неизвестный уровень памяти');
let badScope = '';
try {
  await appendTool.run(ctx(true), { text: '- текст', scope: 'чужой' });
} catch (err) {
  badScope = err.message;
}
check('неизвестный scope отклонён', /Неизвестный уровень памяти/.test(badScope), badScope);

console.log('\n[9] memory_read видит версии и уровни');
const readAfter = await readTool.run(ctx(), {});
check('версий 2 в выводе', readAfter.includes('версий: 2'), readAfter.slice(0, 400));
check('текущая версия v2', readAfter.includes('текущая: v2'), readAfter.slice(0, 400));
check('оба уровня в выводе', readAfter.includes('Память проекта') && readAfter.includes('Глобальная память'));
const onlyGlobal = await readTool.run(ctx(), { scope: 'global' });
check('фильтр по уровню работает', !onlyGlobal.includes('Память проекта') && onlyGlobal.includes('Глобальная память'), onlyGlobal.slice(0, 200));

console.log('\n[10] Режимы разрешений');
check('memory_read — чтение', isReadTool('memory_read') === true);
check('memory_append — запись', isWriteTool('memory_append') === true);
check('в режиме plan memory_append скрыт', hiddenToolsForMode('plan').has('memory_append') === true);
check('в режиме plan memory_read виден', hiddenToolsForMode('plan').has('memory_read') === false);
check(
  'в режиме plan запись отклоняется',
  decide({ mode: 'plan', tool: 'memory_append' }).action === 'deny',
  JSON.stringify(decide({ mode: 'plan', tool: 'memory_append' })),
);
check(
  'в режиме manual запись спрашивает',
  decide({ mode: 'manual', tool: 'memory_append' }).action === 'ask',
  JSON.stringify(decide({ mode: 'manual', tool: 'memory_append' })),
);
check(
  'в режиме auto запись разрешена',
  decide({ mode: 'auto', tool: 'memory_append' }).action === 'allow',
  JSON.stringify(decide({ mode: 'auto', tool: 'memory_append' })),
);
check(
  'чтение памяти не спрашивает',
  decide({ mode: 'manual', tool: 'memory_read' }).action === 'allow',
  JSON.stringify(decide({ mode: 'manual', tool: 'memory_read' })),
);

try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* временная папка останется, это не влияет на результат */
}

console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
