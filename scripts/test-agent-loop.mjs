/**
 * Агентный цикл на фейковом провайдере (ADR 0027).
 *
 * Запуск: npx electron scripts/test-agent-loop.mjs (agent.js тянет config.js,
 * которому нужен electron.app). Сеть не нужна: клиент OpenAI подменяется.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runAgent, trimMessages, toApiMessage, compactSession } from '../electron/lib/agent.js';
import { loadPlugins } from '../electron/lib/plugins.js';
import { createRecorder, rewindFiles, rewindPlan } from '../electron/lib/checkpoints.js';
import { createHookRunner, normalizeHooks } from '../electron/lib/hooks.js';
import { BUILTIN_AGENTS } from '../electron/lib/agent-defs.js';
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

console.log('\n[11] ask_user и exit_plan: ответ пользователя и смена режима (CC1.7, CC1.8)');
{
  const bodies = [];
  const questions = [];
  const history = await runAgent(
    base({
      messages: [{ role: 'user', content: 'настрой базу' }],
      mcp: fakeMcp(),
      ask: async (request) => {
        questions.push(request);
        return { answers: ['Postgres'] };
      },
      clientFactory: fakeClient(
        [
          { calls: [{ name: 'ask_user', args: { questions: [{ question: 'Какая база?', options: [{ label: 'SQLite' }, { label: 'Postgres', recommended: true }] }] } }] },
          { text: 'беру Postgres' },
        ],
        bodies,
      ),
      policy: { getMode: () => 'manual', getRules: () => ({}) },
    }),
  );
  const names = bodies[0].tools.map((t) => t.function.name);
  check('ask_user виден модели', names.includes('ask_user'));
  check('exit_plan вне «Плана» скрыт', !names.includes('exit_plan'));
  check('вопрос дошёл до интерфейса с рекомендацией первой', questions[0]?.questions?.[0]?.options?.[0]?.label === 'Postgres');
  check('ответ пользователя — результат инструмента', /Postgres/.test(history.find((m) => m.role === 'tool')?.content || ''));

  // «План» → exit_plan → пользователь одобряет «Принимать правки» → следующая итерация с записью.
  let mode = 'plan';
  const planBodies = [];
  await runAgent(
    base({
      messages: [{ role: 'user', content: 'спланируй' }],
      mcp: fakeMcp(),
      ask: async (request) => {
        if (request.kind === 'plan') mode = 'acceptEdits'; // так делает main после одобрения
        return { action: 'approve', mode: 'acceptEdits', alternative: 0 };
      },
      clientFactory: fakeClient(
        [{ calls: [{ name: 'exit_plan', args: { plan: '# шаги', alternatives: [{ title: 'A' }], recommended: 0 } }] }, { text: 'выполняю' }],
        planBodies,
      ),
      policy: { getMode: () => mode, getRules: () => ({}) },
    }),
  );
  const before = planBodies[0].tools.map((t) => t.function.name);
  const after = planBodies[1].tools.map((t) => t.function.name);
  check('в «Плане» exit_plan есть, записи нет', before.includes('exit_plan') && !before.includes('write_file'));
  check('после одобрения плана запись доступна', after.includes('write_file') && !after.includes('exit_plan'));

  const silent = [];
  await runAgent(
    base({
      messages: [{ role: 'user', content: 'x' }],
      mcp: fakeMcp(),
      ask: async () => ({}),
      clientFactory: fakeClient([{ text: 'ок' }], silent),
      policy: { getMode: () => 'dontAsk', getRules: () => ({}) },
    }),
  );
  check('в «Только разрешённое» ask_user скрыт', !silent[0].tools.map((t) => t.function.name).includes('ask_user'));
}

console.log('\n[12] Очередь сообщений, живой вывод и список задач (CC7.5, CC7.4, CC1.5)');
{
  const bodies = [];
  const events = [];
  const queue = [{ id: 'q1', text: 'и ещё добавь README', display: 'и ещё добавь README' }];
  let pulls = 0;
  const history = await runAgent(
    base({
      messages: [{ role: 'user', content: 'сделай' }],
      mcp: fakeMcp(),
      emit: (e) => events.push(e),
      // Сообщение «приходит» после первого шага.
      pullQueued: () => (pulls++ === 0 ? [] : queue.splice(0)),
      clientFactory: fakeClient(
        [
          { calls: [{ name: 'todo_write', args: { todos: [{ content: 'Сделать', status: 'in_progress' }] } }, { name: 'run_shell', args: { command: 'echo живой' } }] },
          { text: 'готово' },
          { text: 'и README тоже' },
        ],
        bodies,
      ),
      policy: { getMode: () => 'bypass', getRules: () => ({}) },
    }),
  );
  const queuedIndex = history.findIndex((m) => m.queued);
  check('сообщение из очереди попало в историю', queuedIndex > 0 && history[queuedIndex].content === 'и ещё добавь README');
  check('оно стоит после результатов инструментов', history[queuedIndex - 1].role === 'tool' || history[queuedIndex - 1].role === 'assistant');
  check('агент увидел его в следующем запросе', bodies.some((b) => b.messages.some((m) => m.role === 'user' && m.content === 'и ещё добавь README')));
  check('окно получило queued:consumed', events.some((e) => e.type === 'queued:consumed' && e.ids[0] === 'q1'));
  check('живой вывод команды пришёл событием', events.some((e) => e.type === 'tool_progress' && /живой/.test(e.text)));
  check('список задач пришёл событием', events.some((e) => e.type === 'todos' && e.todos[0].content === 'Сделать'));

  // Сообщение пришло, когда агент уже собирался закончить: прогон продолжается.
  const late = [{ id: 'q2', text: 'стоп, поправь', display: 'стоп, поправь' }];
  const lateBodies = [];
  let lateCalls = 0;
  await runAgent(
    base({
      messages: [{ role: 'user', content: 'x' }],
      mcp: fakeMcp(),
      pullQueued: () => (lateCalls++ === 0 ? late.splice(0) : []),
      clientFactory: fakeClient([{ text: 'ответ' }, { text: 'поправил' }], lateBodies),
      policy: { getMode: () => 'manual', getRules: () => ({}) },
    }),
  );
  check('сообщение перед концом ответа продлевает прогон', lateBodies.length === 2, String(lateBodies.length));
}

console.log('\n[13] Автокомпакция у порога контекста и /compact (CC5.1–CC5.3)');
{
  const pad = 'x'.repeat(9000);
  const messages = [];
  for (let i = 0; i < 4; i += 1) {
    messages.push({ role: 'user', content: `ранняя задача ${i} ${pad}` });
    messages.push({ role: 'assistant', content: `ответ ${i}` });
  }
  messages.push({ role: 'user', content: 'текущая задача' });
  const bodies = [];
  const summaries = [];
  const events = [];
  const client = () => ({
    chat: {
      completions: {
        create: async (body) => {
          if (!body.stream) {
            summaries.push(body.messages[0].content);
            return { choices: [{ message: { content: 'СВОДКА: делали задачи 0–3' } }] };
          }
          bodies.push(JSON.parse(JSON.stringify(body)));
          return stream({ text: 'готово' });
        },
      },
    },
  });
  const history = await runAgent(
    base({
      messages,
      mcp: fakeMcp(),
      contextWindow: 16_000,
      emit: (e) => events.push(e),
      clientFactory: client,
      policy: { getMode: () => 'manual', getRules: () => ({}) },
    }),
  );
  const marker = history.find((m) => m.role === 'compaction');
  check('маркер компакции в истории', marker?.auto === true && /СВОДКА/.test(marker.content));
  check('суммаризатор получил ранние задачи', /ранняя задача 0/.test(summaries[0] || ''));
  const sent = bodies[0].messages.map((m) => String(m.content || '')).join('\n');
  check('модель видит сводку', /СВОДКА/.test(sent));
  check('ранние сообщения модели не ушли', !/ранняя задача 0/.test(sent));
  check('текущая задача на месте', /текущая задача/.test(sent));
  check('ранние сообщения остались в сессии', history.some((m) => /ранняя задача 0/.test(String(m.content))));
  check('окно получило события context и compaction', events.some((e) => e.type === 'compaction') && events.some((e) => e.type === 'context' && e.window === 16_000));

  const manual = await compactSession({
    provider: { baseURL: 'http://fake', apiKey: 'k' },
    model: 'm',
    messages,
    instructions: 'сохрани решения',
    clientFactory: client,
  });
  check('/compact: маркер с пожеланием', manual.marker?.instructions === 'сохрани решения' && manual.marker.auto === false);
  check('/compact: пожелание дошло до суммаризатора', /сохрани решения/.test(summaries.at(-1)));
  const none = await compactSession({ provider: { baseURL: 'x', apiKey: 'k' }, model: 'm', messages: [{ role: 'user', content: 'один ход' }], clientFactory: client });
  check('/compact на одном ходе — нечего сжимать', none.marker === null);
}

console.log('\n[14] Чекпоинты настоящих правок и откат (CC6.1)');
{
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-loop-cp-'));
  const file = path.join(project, 'cp.txt');
  fs.writeFileSync(file, 'исходный', 'utf8');
  const checkpoint = createRecorder({ dataDir: data, sessionId: 'loop', projectDir: project });
  const history = await runAgent(
    base({
      messages: [{ role: 'user', content: 'старый ход' }, { role: 'assistant', content: 'ок' }, { role: 'user', content: 'поправь файл' }],
      mcp: fakeMcp(),
      checkpoint,
      clientFactory: fakeClient(
        [
          { calls: [{ name: 'edit_file', args: { path: 'cp.txt', old_string: 'исходный', new_string: 'правка 1' } }] },
          { calls: [{ name: 'write_file', args: { path: 'cp-new.txt', content: 'создан' } }] },
          { text: 'готово' },
        ],
        [],
      ),
      policy: { getMode: () => 'bypass', getRules: () => ({}) },
    }),
  );
  check('правки выполнены', fs.readFileSync(file, 'utf8') === 'правка 1' && fs.existsSync(path.join(project, 'cp-new.txt')));
  const plan = rewindPlan(data, 'loop', 2);
  check('чекпоинт привязан к сообщению «поправь файл» (индекс 2)', plan.length === 2, JSON.stringify(plan));
  rewindFiles(data, 'loop', 2);
  check('откат вернул исходный текст', fs.readFileSync(file, 'utf8') === 'исходный');
  check('откат удалил созданный файл', !fs.existsSync(path.join(project, 'cp-new.txt')));
  check('история прогона не тронута откатом кода', history.length > 3);
  fs.rmSync(data, { recursive: true, force: true });
}

console.log('\n[15] AGENTS.local.md, импорты и вложенные AGENTS.md (CC4.1, CC4.2)');
{
  fs.writeFileSync(path.join(project, 'AGENTS.md'), '# Корень\n@docs/rules.md', 'utf8');
  fs.mkdirSync(path.join(project, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(project, 'docs', 'rules.md'), 'ИМПОРТ-ПРАВИЛО', 'utf8');
  fs.writeFileSync(path.join(project, 'AGENTS.local.md'), 'ЛИЧНОЕ-ПРАВИЛО', 'utf8');
  fs.mkdirSync(path.join(project, 'svc'), { recursive: true });
  fs.writeFileSync(path.join(project, 'svc', 'AGENTS.md'), 'ПРАВИЛО-SVC', 'utf8');
  fs.writeFileSync(path.join(project, 'svc', 'a.txt'), 'a', 'utf8');
  const run = async (trusted) => {
    const bodies = [];
    const history = await runAgent(
      base({
        messages: [{ role: 'user', content: 'прочитай' }],
        mcp: fakeMcp(),
        trusted,
        clientFactory: fakeClient(
          [{ calls: [{ name: 'read_file', args: { path: 'svc/a.txt' } }, { name: 'read_file', args: { path: 'svc/a.txt' } }] }, { text: 'ок' }],
          bodies,
        ),
        policy: { getMode: () => 'manual', getRules: () => ({}) },
      }),
    );
    return { system: bodies[0].messages[0].content, tools: history.filter((m) => m.role === 'tool').map((m) => m.content) };
  };
  const trusted = await run(true);
  check('импорт из AGENTS.md в системном промпте', trusted.system.includes('ИМПОРТ-ПРАВИЛО'));
  check('AGENTS.local.md в системном промпте', trusted.system.includes('ЛИЧНОЕ-ПРАВИЛО'));
  check('вложенный AGENTS.md не в системном промпте', !trusted.system.includes('ПРАВИЛО-SVC'));
  check('вложенный AGENTS.md пришёл с первым чтением папки', /ПРАВИЛО-SVC/.test(trusted.tools[0]));
  check('второй раз не повторяется', !/ПРАВИЛО-SVC/.test(trusted.tools[1]));
  const untrusted = await run(false);
  check('без доверия — ни импортов, ни вложенных правил', !untrusted.system.includes('ИМПОРТ-ПРАВИЛО') && !untrusted.tools.some((t) => /ПРАВИЛО-SVC/.test(t)));
}

console.log('\n[16] Хук Stop не даёт закончить, пока условие не выполнено (ADR 0035)');
{
  const flag = path.join(project, 'stop-once.flag');
  const hookFile = path.join(project, 'stop-hook.cjs');
  fs.writeFileSync(
    hookFile,
    `const fs = require('fs'); if (!fs.existsSync(${JSON.stringify(flag)})) { fs.writeFileSync(${JSON.stringify(flag)}, '1'); process.stderr.write('тесты не запускались'); process.exit(2); }`,
    'utf8',
  );
  const hooks = createHookRunner({ hooks: normalizeHooks({ Stop: [{ hooks: [{ command: `"${process.execPath}" "${hookFile}"` }] }] }), projectDir: project });
  const bodies = [];
  const history = await runAgent(
    base({
      messages: [{ role: 'user', content: 'сделай' }],
      mcp: fakeMcp(),
      hooks,
      clientFactory: fakeClient([{ text: 'готово' }, { text: 'запустил тесты, всё зелёное' }], bodies),
      policy: { getMode: () => 'manual', getRules: () => ({}) },
    }),
  );
  const hookMsg = history.find((m) => m.role === 'hook');
  check('Stop заблокировал первый финал', /тесты не запускались/.test(hookMsg?.content || ''), JSON.stringify(hookMsg));
  check('агент продолжил и закончил со второго раза', bodies.length === 2 && history.at(-1).content === 'запустил тесты, всё зелёное');
  check('замечание хука ушло модели как сообщение пользователя', bodies[1].messages.some((m) => m.role === 'user' && /тесты не запускались/.test(m.content)));
}

console.log('\n[17] Субагенты: свой контекст, итог родителю, параллельность, разрешения (ADR 0036)');
{
  fs.writeFileSync(path.join(project, 'sub.txt'), 'исходный', 'utf8');
  // Один фейковый провайдер: субагента узнаём по системному промпту.
  const routed = (mainScript, subScript, log) => {
    let mi = 0;
    const si = {};
    return () => ({
      chat: {
        completions: {
          create: async (body) => {
            const system = body.messages[0].content;
            const sub = /Ты — субагент «(\w+)»/.exec(system)?.[1];
            const task = body.messages[1]?.content || '';
            log.push({ sub: sub || null, tools: body.tools.map((t) => t.function.name), at: Date.now(), messages: body.messages });
            if (!sub) return stream(mainScript[Math.min(mi++, mainScript.length - 1)]);
            const key = `${sub}:${task}`;
            si[key] = (si[key] || 0) + 1;
            await new Promise((r) => setTimeout(r, 150)); // чтобы параллельность была видна по времени
            return stream(subScript(sub, task, si[key]));
          },
        },
      },
    });
  };
  const log = [];
  const history = await runAgent(
    base({
      messages: [{ role: 'user', content: 'разберись' }],
      mcp: fakeMcp(),
      agentDefs: BUILTIN_AGENTS,
      clientFactory: routed(
        [
          {
            calls: [
              { name: 'agent', args: { type: 'explore', description: 'найти конфиг', prompt: 'найди А' } },
              { name: 'agent', args: { type: 'explore', description: 'найти тесты', prompt: 'найди Б' } },
            ],
          },
          { text: 'итог родителя' },
        ],
        (sub, task, n) => (n === 1 ? { calls: [{ name: 'read_file', args: { path: 'sub.txt' } }] } : { text: `нашёл для «${task}»` }),
        log,
      ),
      policy: { getMode: () => 'manual', getRules: () => ({}) },
    }),
  );
  const mainTools = log.find((l) => !l.sub).tools;
  const subCalls = log.filter((l) => l.sub === 'explore');
  check('основной агент видит инструмент agent', mainTools.includes('agent'));
  check('субагент explore — только чтение, без agent и ask_user', subCalls[0].tools.includes('read_file') && !subCalls[0].tools.includes('write_file') && !subCalls[0].tools.includes('agent') && !subCalls[0].tools.includes('ask_user'));
  check('субагент не видит диалог родителя', subCalls.every((c) => !c.messages.some((m) => m.content === 'разберись')));
  const results = history.filter((m) => m.role === 'tool' && m.name === 'agent').map((m) => m.content);
  check('родитель получил оба итога', results.length === 2 && /нашёл для «найди А»/.test(results[0]) && /нашёл для «найди Б»/.test(results[1]), JSON.stringify(results));
  check('в итоге — тип, название и число шагов', /\[Субагент explore «найти конфиг»: шагов 1/.test(results[0]), results[0]);
  check('шаги субагента не попали в историю родителя', !history.some((m) => m.role === 'tool' && m.name === 'read_file'));
  const firstTwo = subCalls.slice(0, 2);
  check('два explore работают параллельно', firstTwo.length === 2 && Math.abs(firstTwo[0].at - firstTwo[1].at) < 120, JSON.stringify(firstTwo.map((c) => c.at)));

  // general в «Вручную»: правка субагента спрашивает через то же подтверждение и идёт в чекпоинт хода родителя.
  const asked = [];
  const recorded = [];
  await runAgent(
    base({
      messages: [{ role: 'user', content: 'старое' }, { role: 'assistant', content: 'ок' }, { role: 'user', content: 'поправь через субагента' }],
      mcp: fakeMcp(),
      agentDefs: BUILTIN_AGENTS,
      approve: async (r) => (asked.push(r.tool), true),
      checkpoint: { record: (file, turn) => recorded.push({ file, turn }) },
      clientFactory: routed(
        [{ calls: [{ name: 'agent', args: { type: 'general', prompt: 'поправь sub.txt' } }] }, { text: 'готово' }],
        (sub, task, n) => (n === 1 ? { calls: [{ name: 'edit_file', args: { path: 'sub.txt', old_string: 'исходный', new_string: 'субагент' } }] } : { text: 'поправил' }),
        [],
      ),
      policy: { getMode: () => 'manual', getRules: () => ({}) },
    }),
  );
  check('правка субагента спросила разрешение как у родителя', asked.includes('edit_file'), JSON.stringify(asked));
  check('файл изменён после согласия', fs.readFileSync(path.join(project, 'sub.txt'), 'utf8') === 'субагент');
  check('чекпоинт — к сообщению родителя', recorded.some((r) => r.turn === 2 && r.file.endsWith('sub.txt')), JSON.stringify(recorded));

  // «План»: general не может писать — режим тот же.
  fs.writeFileSync(path.join(project, 'sub.txt'), 'исходный', 'utf8');
  const planLog = [];
  await runAgent(
    base({
      messages: [{ role: 'user', content: 'план' }],
      mcp: fakeMcp(),
      agentDefs: BUILTIN_AGENTS,
      clientFactory: routed([{ calls: [{ name: 'agent', args: { type: 'general', prompt: 'поправь' } }] }, { text: 'ок' }], () => ({ text: 'не могу писать' }), planLog),
      policy: { getMode: () => 'plan', getRules: () => ({}) },
    }),
  );
  const generalInPlan = planLog.find((l) => l.sub === 'general');
  check('в «Плане» у субагента нет записи', generalInPlan && !generalInPlan.tools.includes('edit_file') && !generalInPlan.tools.includes('run_shell'));
}

console.log('\n[18] Навыки пакета в промпте и в load_skill (ADR 0037)');
{
  const pkgSkills = path.join(project, 'pkg-skills');
  fs.mkdirSync(path.join(pkgSkills, 'pkg-review'), { recursive: true });
  fs.writeFileSync(path.join(pkgSkills, 'pkg-review', 'SKILL.md'), '---\nname: pkg-review\ndescription: ревью из пакета\n---\nТЕЛО-НАВЫКА-ПАКЕТА', 'utf8');
  const bodies = [];
  const history = await runAgent(
    base({
      messages: [{ role: 'user', content: 'x' }],
      mcp: fakeMcp(),
      skillDirs: [{ source: 'package:kit', dir: pkgSkills }],
      clientFactory: fakeClient([{ calls: [{ name: 'load_skill', args: { name: 'pkg-review' } }] }, { text: 'ок' }], bodies),
      policy: { getMode: () => 'manual', getRules: () => ({}) },
    }),
  );
  check('навык пакета в системном промпте', bodies[0].messages[0].content.includes('pkg-review: ревью из пакета'));
  check('load_skill находит навык пакета', /ТЕЛО-НАВЫКА-ПАКЕТА/.test(history.find((m) => m.role === 'tool')?.content || ''));
}

console.log('\n[19] Навык: файлы и allowed-tools (CC10.4)');
{
  const dir = path.join(project, 'skill-pkg');
  const skill = path.join(dir, 'deploy');
  fs.mkdirSync(path.join(skill, 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(skill, 'SKILL.md'),
    '---\nname: deploy\ndescription: выкладка\nallowed-tools: run_shell(echo skill-ok*), run_shell, write_file(*)\n---\nСначала прочитай reference.md',
    'utf8',
  );
  fs.writeFileSync(path.join(skill, 'reference.md'), 'СПРАВКА-НАВЫКА', 'utf8');
  fs.writeFileSync(path.join(skill, 'scripts', 'run.sh'), 'echo run', 'utf8');
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'СЕКРЕТ', 'utf8');
  const approvals = [];
  const events = [];
  const auditLog = [];
  const history = await runAgent(
    base({
      settings: { maxIterations: 8, permissions: {} },
      messages: [{ role: 'user', content: 'x' }],
      mcp: fakeMcp(),
      skillDirs: [{ source: 'package:kit', dir }],
      emit: (e) => events.push(e),
      audit: (r) => auditLog.push(r),
      approve: async (req) => {
        approvals.push(req.summary);
        return { allow: false };
      },
      clientFactory: fakeClient(
        [
          { calls: [{ name: 'run_shell', args: { command: 'echo skill-ok before' } }] },
          { calls: [{ name: 'load_skill', args: { name: 'deploy' } }] },
          { calls: [{ name: 'load_skill', args: { name: 'deploy', file: 'reference.md' } }, { name: 'load_skill', args: { name: 'deploy', file: '../secret.txt' } }] },
          { calls: [{ name: 'run_shell', args: { command: 'echo skill-ok after' } }] },
          { calls: [{ name: 'run_shell', args: { command: 'echo other' } }] },
          { text: 'ок' },
        ],
        [],
      ),
      policy: { getMode: () => 'manual', getRules: () => ({}) },
    }),
  );
  const tools = history.filter((m) => m.role === 'tool').map((m) => m.content);
  check('до загрузки навыка команда спрашивается', approvals[0] === 'echo skill-ok before', JSON.stringify(approvals));
  check('load_skill: тело и список файлов', /Сначала прочитай/.test(tools[1]) && /- reference\.md/.test(tools[1]) && /- scripts\/run\.sh/.test(tools[1]), tools[1]);
  check('выдано только узкое правило', /Разрешено навыком на этот прогон: run_shell\(echo skill-ok\*\)/.test(tools[1]) && /Не выданы \(слишком широкие\): run_shell, write_file\(\*\)/.test(tools[1]), tools[1]);
  check('файл навыка читается', /СПРАВКА-НАВЫКА/.test(tools[2]), tools[2]);
  check('выход из папки навыка — отказ', /вне папки навыка/.test(tools[3]) && !/СЕКРЕТ/.test(tools[3]), tools[3]);
  check('после загрузки команда по правилу — без вопроса', /skill-ok after/.test(tools[4]) && !approvals.includes('echo skill-ok after'), JSON.stringify(approvals));
  check('другая команда — по-прежнему с вопросом', approvals.includes('echo other'), JSON.stringify(approvals));
  check('пользователь видит выданное разрешение', events.some((e) => e.type === 'notice' && /Навык «deploy» разрешил/.test(e.text)));
  check('выдача записана в журнал', auditLog.some((r) => r.decision === 'grant' && r.subject === 'deploy'));
}

fs.rmSync(project, { recursive: true, force: true });
console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
disposePluginHosts();
process.exit(fail ? 1 : 0);
