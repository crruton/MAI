/**
 * Дымовая проверка безголового режима (CC12.1, CC12.2, ADR 0077) на настоящем
 * приложении: поддельный OpenAI-совместимый сервер, `--cli -p …` без окна.
 *
 *   node scripts/smoke-cli.mjs   (Linux: под xvfb-run)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';
import { setTrust } from '../electron/lib/trust.js';
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
    console.log(`  FAIL ${name} ${String(extra).slice(0, 500)}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-smoke-cli-'));
const data = path.join(tmp, 'data');
const project = path.join(tmp, 'project');
fs.mkdirSync(data, { recursive: true });
fs.mkdirSync(project, { recursive: true });

// Модель: записать итог.md (разрешено --allow), записать лишнее.md (нельзя), ответить.
let requests = [];
let replies = [];
const toolCall = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (!req.url.includes('/chat/completions')) {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [] }));
      return;
    }
    requests.push(JSON.parse(body || '{}'));
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
fs.writeFileSync(
  path.join(data, 'settings.json'),
  JSON.stringify({ providers: { fake: { name: 'Fake', baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'sk-test', models: [{ id: 'm', label: 'm' }] } }, activeModel: 'fake/m', projectDir: project }),
);
setTrust(data, project, 'trusted');

// Через лаунчер `mai` (stdin читает он) или напрямую через Electron.
const run = (args, { stdin = null } = {}) =>
  new Promise((resolve) => {
    const cmd = stdin !== null ? process.execPath : electronPath;
    const argv = stdin !== null ? [path.join(root, 'bin', 'mai.mjs'), `--user-data-dir=${data}`, ...args] : ['--no-sandbox', `--user-data-dir=${data}`, root, '--cli', ...args];
    const child = spawn(cmd, argv, {
      cwd: project,
      env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1', MAI_NO_SANDBOX: '1', MAI_CLI_CWD: project },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    if (stdin !== null) child.stdin.end(stdin);
    else child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });

console.log('[1] stream-json: события и итог');
replies = [
  { tool_calls: [toolCall('c1', 'write_file', { path: 'итог.md', content: 'готово из CLI' })] },
  { tool_calls: [toolCall('c2', 'write_file', { path: 'лишнее.md', content: 'нельзя' })] },
  { content: 'Сделал итог.md' },
];
requests = [];
let r = await run(['-p', 'Сделай итог', '--output', 'stream-json', '--allow', 'write_file(итог.md)']);
const lines = r.stdout.split('\n').filter((l) => l.trim().startsWith('{')).map((l) => JSON.parse(l));
const last = lines.at(-1) || {};
check('код выхода 0', r.code === 0, `${r.code} ${r.stderr.slice(-500)}`);
check('события построчно: вызовы и результаты инструментов', lines.some((e) => e.type === 'tool_call' && e.name === 'write_file') && lines.some((e) => e.type === 'tool_result'), r.stdout.slice(0, 400));
check('последняя строка — итог', last.type === 'result' && last.ok === true && last.result === 'Сделал итог.md' && last.session_id, JSON.stringify(last));
check('запись по --allow выполнена', fs.readFileSync(path.join(project, 'итог.md'), 'utf8') === 'готово из CLI');
check('запись без правила отклонена без вопроса', !fs.existsSync(path.join(project, 'лишнее.md')) && lines.some((e) => e.type === 'tool_result' && e.ok === false), JSON.stringify(lines.filter((e) => e.type === 'tool_result')).slice(0, 400));
check('режим по умолчанию — «Только разрешённое»', last.mode === 'dontAsk' && /Только разрешённое/.test(requests[0]?.messages?.[0]?.content || ''));
const session = createSessionStore(data).getSession(last.session_id);
check('чат сохранён — виден в приложении', /^CLI: Сделай итог/.test(session?.title || '') && session.run?.status === 'done', session?.title);

console.log('[2] json и stdin');
replies = [{ content: 'Ответ на вопрос' }];
requests = [];
r = await run(['-p', '-', '--output', 'json', '--mode', 'plan', '--kind', 'task'], { stdin: 'Вопрос из stdin\n' });
let obj = {};
try {
  obj = JSON.parse(r.stdout.trim().split('\n').at(-1));
} catch {
  /* не JSON */
}
check('json: один объект с ответом', r.code === 0 && obj.type === 'result' && obj.result === 'Ответ на вопрос' && obj.mode === 'plan', r.stdout.slice(0, 300) + r.stderr.slice(-300));
check('задача из stdin дошла до модели', requests[0]?.messages?.some((m) => m.role === 'user' && /Вопрос из stdin/.test(m.content)));
check('вид «Задача» и режим «План» в промпте', /помощник для рабочих задач/.test(requests[0]?.messages?.[0]?.content || '') && /План/.test(requests[0]?.messages?.[0]?.content || ''));

console.log('[3] text, ошибки, справка');
replies = [{ content: 'Просто текст' }];
r = await run(['-p', 'скажи']);
check('text: на stdout только ответ', r.code === 0 && r.stdout.trim() === 'Просто текст', JSON.stringify(r.stdout));
r = await run(['-p', 'x', '--mode', 'yolo']);
check('неверный флаг — код 2 и подсказка', r.code === 2 && /--mode/.test(r.stderr), `${r.code} ${r.stderr.slice(0, 200)}`);
r = await run(['--help']);
check('--help — справка, код 0', r.code === 0 && /mai -p/.test(r.stdout), r.stdout.slice(0, 100));
r = await run(['-p', 'x', '--model', 'nope/none', '--output', 'json']);
obj = {};
try {
  obj = JSON.parse(r.stdout.trim().split('\n').at(-1));
} catch {
  /* не JSON */
}
check('нет модели — код 1 и ошибка в json', r.code === 1 && obj.ok === false && obj.error, r.stdout.slice(0, 300));

server.close();
try {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
} catch {
  /* Electron держит файлы */
}
console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
