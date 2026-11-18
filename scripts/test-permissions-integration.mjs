/**
 * Интеграционный тест PolicyEngine (ADR 0027).
 *
 * Проверяет связку «режим → runToolCall → реальный инструмент → файл на диске»
 * для всех источников: встроенные инструменты, MCP и плагины. Важен факт на
 * диске, а не ответ decide(): раньше MCP-инструменты обходили проверку целиком.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fsTools } from '../electron/lib/tools/fs.js';
import { shellTools } from '../electron/lib/tools/shell.js';
import { runToolCall, toolEntry } from '../electron/lib/tool-runner.js';
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
const reset = (text = 'исходный текст') => fs.writeFileSync(target, text, 'utf8');
const read = () => fs.readFileSync(target, 'utf8');
reset();

const builtin = Object.fromEntries(
  [...fsTools, ...shellTools].map((t) => [
    t.schema.function.name,
    toolEntry(t.schema, { source: 'builtin', run: t.run, precheck: t.precheck }),
  ]),
);

/** MCP-сервер файловой системы: пишет файл. Без аннотаций — класс external. */
const mcpWrite = toolEntry(
  { type: 'function', function: { name: 'mcp__fs__write_file', parameters: { type: 'object' } } },
  {
    source: 'mcp',
    annotations: {},
    run: (_ctx, args) => {
      fs.writeFileSync(target, String(args.content), 'utf8');
      return 'mcp: записано';
    },
  },
);
const mcpRead = toolEntry(
  { type: 'function', function: { name: 'mcp__fs__read_file', parameters: { type: 'object' } } },
  { source: 'mcp', annotations: { readOnlyHint: true }, run: () => read() },
);
/** Плагин старого формата: сам ничего не спрашивает. */
const pluginWrite = toolEntry(
  { type: 'function', function: { name: 'plugin_touch', parameters: { type: 'object' } } },
  {
    source: 'plugin',
    run: (_ctx, args) => {
      fs.writeFileSync(target, String(args.content), 'utf8');
      return 'plugin: записано';
    },
  },
);
const pluginRead = toolEntry(
  { type: 'function', function: { name: 'plugin_stats', parameters: { type: 'object' } } },
  { source: 'plugin', kind: 'read', run: () => 'plugin: статистика' },
);

const ctx = { projectDir: project, allowOutsideProject: false, guardrails: DEFAULT_GUARDRAILS };

function harness(mode, { answer = true, rules = {}, role = 'admin' } = {}) {
  const prompts = [];
  const audit = [];
  return {
    prompts,
    audit,
    run: (entry, args) =>
      runToolCall({
        entry,
        args,
        ctx,
        policy: { getMode: () => mode, getRules: () => rules, role },
        approve: async (request) => {
          prompts.push(request);
          return typeof answer === 'function' ? answer(request) : answer;
        },
        audit: (r) => audit.push(r),
      }),
  };
}

console.log('\n[1] Матрица: изменение файла по режимам и источникам');
const writers = [
  ['write_file', builtin.write_file, { path: 'note.txt', content: 'ИЗМЕНЕНО' }],
  ['mcp external', mcpWrite, { content: 'ИЗМЕНЕНО' }],
  ['plugin external', pluginWrite, { content: 'ИЗМЕНЕНО' }],
];
// ожидание: changed (файл изменён) и asked (спросили пользователя), ответ пользователя — «нет»
const expectations = {
  plan: { write_file: [false, false], 'mcp external': [false, false], 'plugin external': [false, false] },
  manual: { write_file: [false, true], 'mcp external': [false, true], 'plugin external': [false, true] },
  acceptEdits: { write_file: [true, false], 'mcp external': [false, true], 'plugin external': [false, true] },
  dontAsk: { write_file: [false, false], 'mcp external': [false, false], 'plugin external': [false, false] },
  bypass: { write_file: [true, false], 'mcp external': [true, false], 'plugin external': [true, false] },
};
for (const [mode, byTool] of Object.entries(expectations)) {
  for (const [label, entry, args] of writers) {
    reset();
    const h = harness(mode, { answer: false });
    const out = await h.run(entry, args);
    const [changed, asked] = byTool[label];
    check(`${mode} × ${label}: файл ${changed ? 'изменён' : 'не изменён'}`, (read() === 'ИЗМЕНЕНО') === changed, out.content);
    check(`${mode} × ${label}: ${asked ? 'спросили' : 'не спрашивали'}`, (h.prompts.length > 0) === asked);
    check(`${mode} × ${label}: решение в журнале`, h.audit.length === 1 && h.audit[0].tool === entry.name);
  }
}

console.log('\n[2] Чтение проходит во всех режимах, включая read-only MCP и плагин kind:read');
for (const mode of ['plan', 'manual', 'dontAsk']) {
  const h = harness(mode, { answer: false });
  const a = await h.run(builtin.read_file, { path: 'note.txt' });
  const b = await h.run(mcpRead, {});
  const c = await h.run(pluginRead, {});
  check(`${mode}: read_file прошёл`, a.ok, a.content);
  check(`${mode}: MCP readOnlyHint прошёл`, b.ok, b.content);
  check(`${mode}: плагин kind:read прошёл`, c.ok, c.content);
  check(`${mode}: вопросов не было`, h.prompts.length === 0);
}

console.log('\n[3] Согласие пользователя пропускает, отказ с пояснением доходит до агента');
{
  reset();
  const yes = harness('manual', { answer: true });
  const ok = await yes.run(mcpWrite, { content: 'ИЗМЕНЕНО' });
  check('MCP после «да» выполнен', ok.ok && read() === 'ИЗМЕНЕНО', ok.content);
  check('в запросе есть риск и рекомендация', yes.prompts[0]?.risk && yes.prompts[0]?.recommended);
  check('для MCP предложено правило по имени', yes.prompts[0]?.suggestions?.[0] === 'mcp__fs__write_file');

  reset();
  const no = harness('manual', { answer: { allow: false, feedback: 'используй edit_file' } });
  const denied = await no.run(builtin.write_file, { path: 'note.txt', content: 'нельзя' });
  check('отказ остановил запись', read() === 'исходный текст');
  check('пояснение пользователя в ответе инструмента', /используй edit_file/.test(denied.content), denied.content);
}

console.log('\n[4] Правила: allow, deny, ask');
{
  reset();
  const allowed = harness('manual', { answer: false, rules: { allow: ['write_file(note.txt)'] } });
  await allowed.run(builtin.write_file, { path: 'note.txt', content: 'ИЗМЕНЕНО' });
  check('allow-правило: записано без вопроса', read() === 'ИЗМЕНЕНО' && allowed.prompts.length === 0);
  check('в журнале указано правило', allowed.audit[0]?.rule === 'write_file(note.txt)');

  reset();
  const denied = harness('bypass', { rules: { deny: ['mcp__fs__*'] } });
  const out = await denied.run(mcpWrite, { content: 'ИЗМЕНЕНО' });
  check('deny сильнее «Без вопросов»', read() === 'исходный текст' && /правилом/.test(out.content), out.content);

  reset();
  const asked = harness('bypass', { answer: false, rules: { ask: ['write_file(**)'] } });
  await asked.run(builtin.write_file, { path: 'note.txt', content: 'ИЗМЕНЕНО' });
  check('ask-правило спрашивает даже в «Без вопросов»', asked.prompts.length === 1 && read() === 'исходный текст');

  reset();
  const dontAsk = harness('dontAsk', { rules: { allow: ['plugin_touch'] } });
  await dontAsk.run(pluginWrite, { content: 'ИЗМЕНЕНО' });
  check('dontAsk выполняет разрешённое правилом', read() === 'ИЗМЕНЕНО');
}

console.log('\n[5] Команды: guardrails, составные команды, рабочая папка');
{
  const h = harness('bypass');
  const rm = await h.run(builtin.run_shell, { command: 'rm -rf /' });
  check('guardrails сильнее «Без вопросов»', /Guardrails/.test(rm.content), rm.content);

  const chained = harness('manual', { answer: false, rules: { allow: ['run_shell(echo*)'] } });
  await chained.run(builtin.run_shell, { command: 'echo ok' });
  check('echo по правилу — без вопроса', chained.prompts.length === 0);
  await chained.run(builtin.run_shell, { command: 'echo ok && node -e "1"' });
  check('составная команда вне правила — спросили', chained.prompts.length === 1);

  const outside = harness('bypass');
  const res = await outside.run(builtin.run_shell, { command: 'echo hi', cwd: '..' });
  check('cwd вне проекта отклонён', !res.ok && /вне проекта/.test(res.content), res.content);
}

console.log('\n[6] Гостю «Без вопросов» недоступен');
{
  reset();
  const guest = harness('bypass', { answer: false, role: 'guest' });
  await guest.run(builtin.write_file, { path: 'note.txt', content: 'ИЗМЕНЕНО' });
  check('гостя спросили (режим понижен до «Вручную»)', guest.prompts.length === 1);
  check('файл не изменён', read() === 'исходный текст');
}

console.log('\n[7] Предпроверка: пользователя не спрашивают зря');
{
  const h = harness('manual');
  const out = await h.run(builtin.edit_file, { path: 'note.txt', old_string: 'нет такого', new_string: 'x' });
  check('edit_file без фрагмента — ошибка до вопроса', h.prompts.length === 0 && /не найден/.test(out.content), out.content);
}

console.log('\n[8] edit_file не портит текст с $ в замене');
{
  reset('let a = X;');
  const h = harness('bypass');
  await h.run(builtin.edit_file, { path: 'note.txt', old_string: 'X', new_string: "'$&' + $1" });
  check('специальные шаблоны $ не раскрываются', read() === "let a = '$&' + $1;", read());
}

console.log('\n[9] Секретный файл не пишется даже в «Без вопросов»');
{
  const h = harness('bypass');
  const out = await h.run(builtin.write_file, { path: '.env', content: 'SECRET=1' });
  check('запись .env отклонена', !out.ok && /секретн/i.test(out.content), out.content);
  check('.env не создан', !fs.existsSync(path.join(project, '.env')));
}

fs.rmSync(project, { recursive: true, force: true });

console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
