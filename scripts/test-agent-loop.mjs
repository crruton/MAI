/**
 * Агентный цикл на фейковом провайдере (ADR 0027).
 *
 * Запуск: npx electron scripts/test-agent-loop.mjs (agent.js тянет config.js,
 * которому нужен electron.app). Сеть не нужна: клиент OpenAI подменяется.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runAgent, trimMessages, toApiMessage } from '../electron/lib/agent.js';

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

const project = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-loop-'));
const target = path.join(project, 'out.txt');

/** Поток чанков chat.completions из сценария. */
function stream(step) {
  return {
    async *[Symbol.asyncIterator]() {
      if (step.text) yield { choices: [{ delta: { content: step.text } }] };
      for (const [index, call] of (step.calls || []).entries()) {
        yield {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index, id: `call_${index}_${call.name}`, function: { name: call.name, arguments: JSON.stringify(call.args || {}) } },
                ],
              },
            },
          ],
        };
      }
    },
  };
}

function fakeClient(script, bodies) {
  let i = 0;
  return () => ({
    chat: {
      completions: {
        create: async (body) => {
          bodies.push(JSON.parse(JSON.stringify(body)));
          const step = script[Math.min(i, script.length - 1)];
          i += 1;
          return stream(step);
        },
      },
    },
  });
}

function fakeMcp() {
  const calls = [];
  return {
    calls,
    status: () => [{ name: 'fs', status: 'ready', tools: ['write_file', 'read_file'] }],
    toolSchemas: () => [
      { type: 'function', function: { name: 'mcp__fs__write_file', description: 'write', parameters: { type: 'object' } }, annotations: {} },
      { type: 'function', function: { name: 'mcp__fs__read_file', description: 'read', parameters: { type: 'object' } }, annotations: { readOnlyHint: true } },
    ],
    call: async (name, args) => {
      calls.push({ name, args });
      if (name === 'mcp__fs__write_file') fs.writeFileSync(target, String(args.content), 'utf8');
      return 'ok';
    },
  };
}

const base = (extra) => ({
  settings: { maxIterations: 6, permissions: {} },
  provider: { baseURL: 'http://fake', apiKey: 'k', name: 'fake' },
  projectDir: project,
  model: 'fake-model',
  emit: () => {},
  signal: new AbortController().signal,
  ...extra,
});


console.log('\n[1] MCP-инструменты доходят до модели в chat.completions');
{
  const bodies = [];
  const mcp = fakeMcp();
  await runAgent(
    base({
      messages: [{ role: 'user', content: 'привет' }],
      mcp,
      clientFactory: fakeClient([{ text: 'готово' }], bodies),
      policy: { getMode: () => 'manual', getRules: () => ({}) },
    }),
  );
  const names = bodies[0].tools.map((t) => t?.function?.name);
  check('нет пустых схем инструментов', names.every(Boolean), JSON.stringify(names));
  check('MCP write в списке', names.includes('mcp__fs__write_file'));
  check('в схему не утекло поле annotations', bodies[0].tools.every((t) => !('annotations' in t)));
}

console.log('\n[2] MCP-вызов проходит через PolicyEngine');
{
  const bodies = [];
  const mcp = fakeMcp();
  const asked = [];
  const history = await runAgent(
    base({
      messages: [{ role: 'user', content: 'запиши' }],
      mcp,
      clientFactory: fakeClient([{ calls: [{ name: 'mcp__fs__write_file', args: { content: 'MCP' } }] }, { text: 'всё' }], bodies),
      policy: { getMode: () => 'manual', getRules: () => ({}) },
      approve: async (request) => {
        asked.push(request);
        return { allow: false, feedback: 'не трогай файл' };
      },
    }),
  );
  check('пользователя спросили про MCP', asked.length === 1 && asked[0].tool === 'mcp__fs__write_file');
  check('MCP не вызван после отказа', mcp.calls.length === 0);
  check('файл не создан', !fs.existsSync(target));
  const toolMsg = history.find((m) => m.role === 'tool');
  check('пояснение пользователя ушло модели', /не трогай файл/.test(toolMsg?.content || ''), toolMsg?.content);
}

console.log('\n[3] «План» скрывает MCP с действиями, оставляет read-only');
{
  const bodies = [];
  await runAgent(
    base({
      messages: [{ role: 'user', content: 'план' }],
      mcp: fakeMcp(),
      clientFactory: fakeClient([{ text: 'план' }], bodies),
      policy: { getMode: () => 'plan', getRules: () => ({}) },
    }),
  );
  const names = bodies[0].tools.map((t) => t.function.name);
  check('mcp write скрыт', !names.includes('mcp__fs__write_file'));
  check('mcp read виден', names.includes('mcp__fs__read_file'));
  check('write_file и run_shell скрыты', !names.includes('write_file') && !names.includes('run_shell'));
  check('read_file виден', names.includes('read_file'));
}

console.log('\n[4] Смена режима посреди прогона меняет список инструментов');
{
  const bodies = [];
  let mode = 'plan';
  await runAgent(
    base({
      messages: [{ role: 'user', content: 'x' }],
      mcp: fakeMcp(),
      clientFactory: fakeClient([{ calls: [{ name: 'read_file', args: { path: '.' } }] }, { text: 'конец' }], bodies),
      policy: {
        getMode: () => {
          const current = mode;
          mode = 'manual';
          return current;
        },
        getRules: () => ({}),
      },
    }),
  );
  const first = bodies[0].tools.map((t) => t.function.name);
  const second = bodies[1].tools.map((t) => t.function.name);
  check('на первой итерации write_file скрыт', !first.includes('write_file'));
  check('после переключения write_file виден', second.includes('write_file'));
}

console.log('\n[5] Смешанная сессия: runtime и review не уходят провайдеру как есть');
{
  const bodies = [];
  await runAgent(
    base({
      messages: [
        { role: 'user', content: 'спроси opencode' },
        { role: 'runtime', name: 'OpenCode', content: 'ответ CLI', code: 0 },
        { role: 'review', round: 1, content: '[Ревизор, раунд 1] уточни' },
        { role: 'user', content: 'продолжим' },
      ],
      mcp: fakeMcp(),
      clientFactory: fakeClient([{ text: 'ок' }], bodies),
      policy: { getMode: () => 'manual', getRules: () => ({}) },
    }),
  );
  const roles = bodies[0].messages.map((m) => m.role);
  check('только допустимые роли', roles.every((r) => ['system', 'user', 'assistant', 'tool'].includes(r)), JSON.stringify(roles));
  check('вывод рантайма сохранён как assistant', bodies[0].messages.some((m) => m.role === 'assistant' && /OpenCode/.test(m.content)));
  check('toApiMessage(runtime) → assistant', toApiMessage({ role: 'runtime', content: 'x' }).role === 'assistant');
}

console.log('\n[6] История сохраняется после каждого шага');
{
  const snapshots = [];
  const bodies = [];
  const finalHistory = await runAgent(
    base({
      messages: [{ role: 'user', content: 'читай' }],
      mcp: fakeMcp(),
      clientFactory: fakeClient([{ calls: [{ name: 'list_files', args: {} }] }, { text: 'итог' }], bodies),
      policy: { getMode: () => 'manual', getRules: () => ({}) },
      onHistory: (h) => snapshots.push(h.map((m) => m.role).join(',')),
    }),
  );
  check('снимков не меньше трёх', snapshots.length >= 3, JSON.stringify(snapshots));
  check('снимок с результатом инструмента до финала', snapshots.some((s) => s.endsWith('tool')), JSON.stringify(snapshots));
  check('у ответа ассистента сохранена модель', finalHistory.filter((m) => m.role === 'assistant').every((m) => m.model === 'fake-model'));
}

console.log('\n[7] Обрезка не разрывает пары tool_calls → tool');
{
  const big = 'x'.repeat(5000);
  const messages = [];
  for (let i = 0; i < 30; i += 1) {
    messages.push({ role: 'user', content: `задача ${i} ${big}` });
    messages.push({ role: 'assistant', content: null, tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'read_file', arguments: '{}' } }] });
    messages.push({ role: 'tool', tool_call_id: `c${i}`, content: big });
    messages.push({ role: 'assistant', content: `ответ ${i}` });
  }
  const trimmed = trimMessages(messages, 60_000);
  check('история обрезана', trimmed.length < messages.length);
  check('первое сообщение — user', trimmed[0].role === 'user');
  const ids = new Set(trimmed.filter((m) => m.tool_calls).flatMap((m) => m.tool_calls.map((c) => c.id)));
  check('у каждого tool есть родитель', trimmed.filter((m) => m.role === 'tool').every((m) => ids.has(m.tool_call_id)));

  const onlyTools = [{ role: 'user', content: big }];
  for (let i = 0; i < 20; i += 1) {
    onlyTools.push({ role: 'assistant', content: null, tool_calls: [{ id: `t${i}`, type: 'function', function: { name: 'grep', arguments: '{}' } }] });
    onlyTools.push({ role: 'tool', tool_call_id: `t${i}`, content: big });
  }
  const cut = trimMessages(onlyTools, 30_000);
  const ids2 = new Set(cut.filter((m) => m.tool_calls).flatMap((m) => m.tool_calls.map((c) => c.id)));
  check('длинный ход без user: начало — user-заметка', cut[0].role === 'user', cut[0].role);
  check('длинный ход без user: пары целы', cut.filter((m) => m.role === 'tool').every((m) => ids2.has(m.tool_call_id)));
}

fs.rmSync(project, { recursive: true, force: true });
console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
