/**
 * Дымовая проверка плановых задач (ADR 0050) на настоящем приложении:
 * поддельный OpenAI-совместимый сервер, задача в scheduled.json — приложение
 * должно само выполнить её в режиме «Только разрешённое», записать файл по
 * правилу allow, отказать в записи без правила и оставить запись в журнале.
 *
 *   node scripts/smoke-scheduler.mjs   (Linux: под xvfb-run)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTrust } from '../electron/lib/trust.js';
import electronPath from 'electron';
import { createSessionStore } from '../electron/lib/session-store.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-smoke-sched-'));
const data = path.join(tmp, 'data');
const project = path.join(tmp, 'project');
fs.mkdirSync(data, { recursive: true });
fs.mkdirSync(project, { recursive: true });

// Модель: 1) записать сводка.md (разрешено правилом), 2) записать секрет.md (правила нет), 3) ответ.
const requests = [];
const toolCall = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const replies = [
  { tool_calls: [toolCall('c1', 'write_file', { path: 'сводка.md', content: 'Сводка: всё хорошо' })] },
  { tool_calls: [toolCall('c2', 'write_file', { path: 'другое/x.md', content: 'нельзя' })] },
  { content: 'Сводка готова: сводка.md' },
];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (!req.url.includes('/chat/completions')) {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [] }));
      return;
    }
    const parsed = JSON.parse(body || '{}');
    requests.push(parsed);
    const reply = replies[Math.min(requests.length - 1, replies.length - 1)];
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    if (reply.tool_calls) {
      res.write(chunk({ role: 'assistant', tool_calls: reply.tool_calls.map((t, i) => ({ index: i, ...t })) }));
      res.write(chunk({}, 'tool_calls'));
    } else {
      res.write(chunk({ role: 'assistant', content: reply.content }));
      res.write(chunk({}, 'stop'));
    }
    res.end('data: [DONE]\n\n');
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/v1`;

fs.writeFileSync(
  path.join(data, 'settings.json'),
  JSON.stringify({
    providers: { fake: { name: 'Fake', baseURL: base, apiKey: 'sk-test', models: [{ id: 'm', label: 'm' }] } },
    activeModel: 'fake/m',
    projectDir: project,
    permissions: { allow: ['write_file(сводка.md)'], ask: [], deny: [] },
  }),
);
setTrust(data, project, 'trusted');
const created = new Date(Date.now() - 3600_000).toISOString();
fs.writeFileSync(
  path.join(data, 'scheduled.json'),
  JSON.stringify({ tasks: [{ id: 'smoke', title: 'Сводка', prompt: 'Сделай сводку', projectDir: project, kind: 'task', model: 'fake/m', enabled: true, schedule: { type: 'interval', everyMinutes: 15 }, createdAt: created }] }),
);

// Чат, прогон которого «шёл», когда приложение закрыли (CW5.2).
const stuck = createSessionStore(data).createSession({ title: 'Прерванный', projectDir: project });
createSessionStore(data).setSessionRun(stuck.id, { status: 'running', startedAt: new Date().toISOString() });

// Из Node пакет electron отдаёт путь к исполняемому файлу — без .cmd и оболочки.
const child = spawn(electronPath, ['--no-sandbox', `--user-data-dir=${data}`, root], {
  env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1', MAI_SCHEDULER_DELAY_MS: '2000' },
  stdio: 'ignore',
});
const runsFile = path.join(data, 'scheduled-runs.jsonl');
const started = Date.now();
while (!fs.existsSync(runsFile) && Date.now() - started < 90_000) await new Promise((r) => setTimeout(r, 500));
await new Promise((r) => setTimeout(r, 500));
try {
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
  else child.kill('SIGTERM');
} catch {
  /* уже завершён */
}
server.close();

const runs = fs.existsSync(runsFile) ? fs.readFileSync(runsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
check('задача выполнена сама, запись в журнале', runs.length === 1 && runs[0].taskId === 'smoke' && runs[0].status === 'ok', JSON.stringify(runs));
check('модель вызвана три раза', requests.length === 3, String(requests.length));
check('запрос в режиме «Только разрешённое», вид «Задача»', /Только разрешённое/.test(requests[0]?.messages?.[0]?.content || '') && /помощник для рабочих задач/.test(requests[0]?.messages?.[0]?.content || ''));
check('ask_user недоступен', !(requests[0]?.tools || []).some((t) => t.function.name === 'ask_user'));
check('запись по правилу allow выполнена', fs.existsSync(path.join(project, 'сводка.md')) && fs.readFileSync(path.join(project, 'сводка.md'), 'utf8') === 'Сводка: всё хорошо');
check('запись без правила отклонена без вопроса', !fs.existsSync(path.join(project, 'другое', 'x.md')) && /Только разрешённое/.test(JSON.stringify(requests[2]?.messages?.slice(-1))));
const tasks = JSON.parse(fs.readFileSync(path.join(data, 'scheduled.json'), 'utf8')).tasks;
check('отметка последнего запуска', tasks[0].lastStatus === 'ok' && tasks[0].lastRun && tasks[0].lastSessionId);
const sessionFile = fs.readdirSync(path.join(data, 'sessions')).find((f) => f.includes(tasks[0].lastSessionId));
const session = sessionFile ? JSON.parse(fs.readFileSync(path.join(data, 'sessions', sessionFile), 'utf8')) : null;
check('чат «⏰ Сводка — …» с ответом', /^⏰ Сводка — /.test(session?.title || '') && session.messages.some((m) => m.role === 'assistant' && /Сводка готова/.test(m.content || '')), session?.title);
check('прогон, шедший при закрытии, отмечен «прерван»', createSessionStore(data).getSession(stuck.id)?.run?.status === 'interrupted');
check('завершённый плановый прогон — done', session?.run?.status === 'done', JSON.stringify(session?.run));

try {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
} catch {
  /* Electron держит файлы — не провал */
}
console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
