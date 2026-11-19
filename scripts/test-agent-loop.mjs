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
import { loadPlugins } from '../electron/lib/plugins.js';
import { disposePluginHosts } from '../electron/lib/plugin-host.js';

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
      if (step.usage) yield { choices: [], usage: step.usage };
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

console.log('\n[8] Недоверенная папка: инструкции, навыки и плагины проекта не загружаются (ADR 0028)');
{
  fs.writeFileSync(path.join(project, 'AGENTS.md'), 'СЕКРЕТНОЕ-ПРАВИЛО-ПРОЕКТА', 'utf8');
  fs.mkdirSync(path.join(project, '.mai-code', 'skills', 'evil'), { recursive: true });
  fs.writeFileSync(path.join(project, '.mai-code', 'skills', 'evil', 'SKILL.md'), '---\nname: evil-skill\ndescription: x\n---\nтело', 'utf8');
  fs.mkdirSync(path.join(project, '.mai-code', 'plugins'), { recursive: true });
  fs.writeFileSync(
    path.join(project, '.mai-code', 'plugins', 'evil.js'),
    // Плагин исполняется в отдельном процессе (ADR 0030): факт загрузки — файл-маркер.
    `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(path.join(project, 'evil-loaded.txt'))}, '1'); export default { name: 'evil', tools: [] };`,
    'utf8',
  );
  const run = async (trusted) => {
    const bodies = [];
    await runAgent(
      base({
        messages: [{ role: 'user', content: 'x' }],
        mcp: fakeMcp(),
        trusted,
        clientFactory: fakeClient([{ text: 'ок' }], bodies),
        policy: { getMode: () => 'manual', getRules: () => ({}) },
      }),
    );
    return bodies[0].messages[0].content;
  };
  const untrusted = await run(false);
  const trusted = await run(true);
  check('без доверия AGENTS.md проекта не в промпте', !untrusted.includes('СЕКРЕТНОЕ-ПРАВИЛО-ПРОЕКТА'));
  check('без доверия навык проекта не в промпте', !untrusted.includes('evil-skill'));
  check('без доверия в промпте предупреждение', /Папка не доверена/.test(untrusted));
  check('с доверием AGENTS.md проекта в промпте', trusted.includes('СЕКРЕТНОЕ-ПРАВИЛО-ПРОЕКТА'));
  check('с доверием навык проекта в промпте', trusted.includes('evil-skill'));

  const skipped = await loadPlugins(project, { includeProject: false });
  check('плагин проекта не исполнен без доверия', !fs.existsSync(path.join(project, 'evil-loaded.txt')));
  check('пропуск виден в списке плагинов', skipped.loaded.some((p) => p.skipped));
  // Загрузку доверенных плагинов в отдельный процесс проверяет test-plugin-host.mjs:
  // utilityProcess требует app.ready, а этот тест работает без него.
}

console.log('\n[9] Изображения из вложений доходят до модели (F1)');
{
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  fs.mkdirSync(path.join(project, '.mai-code', 'uploads', 's'), { recursive: true });
  fs.writeFileSync(path.join(project, '.mai-code', 'uploads', 's', 'shot.png'), png);
  const messages = [{ role: 'user', content: 'что на скриншоте?', images: ['.mai-code/uploads/s/shot.png'] }];
  const run = async (model, clientFactory) => {
    const bodies = [];
    const notices = [];
    await runAgent(
      base({
        model,
        messages,
        mcp: fakeMcp(),
        emit: (e) => e.type === 'notice' && notices.push(e.text),
        clientFactory: clientFactory || fakeClient([{ text: 'кот' }], bodies),
        policy: { getMode: () => 'manual', getRules: () => ({}) },
      }),
    );
    return { bodies, notices };
  };
  const vision = await run('gpt-4o');
  const user = vision.bodies[0].messages.find((m) => m.role === 'user');
  check('модели с vision ушла картинка', Array.isArray(user.content) && user.content.some((p) => p.type === 'image_url' && p.image_url.url.startsWith('data:image/png')));
  const plain = await run('deepseek-v4.1-flash');
  check('модели без vision картинка не ушла', typeof plain.bodies[0].messages.find((m) => m.role === 'user').content === 'string');

  // Шлюз отвечает 400 на картинку — шаг повторяется без неё.
  const bodies = [];
  let calls = 0;
  const rejecting = () => ({
    chat: {
      completions: {
        create: async (body) => {
          calls += 1;
          bodies.push(JSON.parse(JSON.stringify(body)));
          if (calls === 1) {
            const err = new Error('400 image_url is not supported');
            err.status = 400;
            throw err;
          }
          return stream({ text: 'без картинки' });
        },
      },
    },
  });
  const rejected = await run('gpt-4o', rejecting);
  check('после отказа запрос повторён', calls === 2, String(calls));
  check('повтор без картинки', typeof bodies[1].messages.find((m) => m.role === 'user').content === 'string');
  check('пользователь предупреждён', rejected.notices.some((t) => /не принял изображение/.test(t)), JSON.stringify(rejected.notices));
}

console.log('\n[10] Учёт токенов (A3.8)');
{
  const bodies = [];
  const events = [];
  const history = await runAgent(
    base({
      messages: [{ role: 'user', content: 'x' }],
      mcp: fakeMcp(),
      emit: (e) => events.push(e),
      clientFactory: fakeClient([{ text: 'ок', usage: { prompt_tokens: 120, completion_tokens: 7, total_tokens: 127 } }], bodies),
      policy: { getMode: () => 'manual', getRules: () => ({}) },
    }),
  );
  check('запрошен usage в потоке', bodies[0].stream_options?.include_usage === true);
  const answer = history.find((m) => m.role === 'assistant');
  check('токены сохранены в ответе', answer.usage?.input === 120 && answer.usage?.output === 7, JSON.stringify(answer.usage));
  check('событие usage отправлено', events.some((e) => e.type === 'usage' && e.run.total === 127));

  let calls = 0;
  const strict = [];
  const noOptions = () => ({
    chat: {
      completions: {
        create: async (body) => {
          calls += 1;
          strict.push(JSON.parse(JSON.stringify(body)));
          if (body.stream_options) {
            const err = new Error('400 Unrecognized request argument: stream_options');
            err.status = 400;
            throw err;
          }
          return stream({ text: 'ок' });
        },
      },
    },
  });
  await runAgent(
    base({
      messages: [{ role: 'user', content: 'x' }],
      mcp: fakeMcp(),
      clientFactory: noOptions,
      policy: { getMode: () => 'manual', getRules: () => ({}) },
    }),
  );
  check('шлюз без stream_options: повтор без параметра', calls === 2 && !strict[1].stream_options, String(calls));
}

fs.rmSync(project, { recursive: true, force: true });
console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
disposePluginHosts();
process.exit(fail ? 1 : 0);
