/**
 * Дымовая проверка раннера набора сценариев (Q5, ADR 0082): настоящее
 * приложение через `mai -p`, поддельная модель. Одна задача решается, вторая
 * намеренно проваливается — отчёт и код выхода должны это показать.
 *
 *   node scripts/smoke-eval.mjs   (Linux: под xvfb-run)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  OK   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name} ${String(extra).slice(0, 600)}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-smoke-eval-'));
const data = path.join(tmp, 'data');
const out = path.join(tmp, 'out');
fs.mkdirSync(data, { recursive: true });

// Модель: fix-json — переписать config.json и ответить; count-words — неверный ответ.
const toolCall = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (!req.url.includes('/chat/completions')) return res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"data":[]}');
    const msgs = JSON.parse(body || '{}').messages || [];
    const prompt = msgs.find((m) => m.role === 'user')?.content || '';
    const steps = msgs.filter((m) => m.role === 'tool').length;
    let reply;
    // Как настоящий агент: сначала прочитать (правка без чтения запрещена), потом переписать.
    if (/config\.json/.test(prompt)) {
      reply = steps === 0 ? { tool_calls: [toolCall('c0', 'read_file', { path: 'config.json' })] } : steps === 1 ? { tool_calls: [toolCall('c1', 'write_file', { path: 'config.json', content: '{\n  "name": "demo",\n  "port": 8080,\n  "features": ["a", "b"],\n  "debug": true\n}\n' })] } : { content: 'Исправил config.json' };
    }
    else reply = { content: 'Встречается 3 раза.' };
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
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ providers: { fake: { name: 'Fake', baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'sk-test', models: [{ id: 'm', label: 'm' }] } }, activeModel: 'fake/m' }));
const profiles = path.join(tmp, 'profiles.json');
fs.writeFileSync(profiles, JSON.stringify({ profiles: [{ name: 'поддельная', model: 'fake/m', mode: 'acceptEdits', allow: [] }] }));

const run = await new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(root, 'scripts', 'eval.mjs'), '--tasks', 'fix-json,count-words', '--profiles', profiles, '--user-data-dir', data, '--out', out, '--timeout', '120'], {
    env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1', MAI_NO_SANDBOX: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  child.on('exit', (code) => resolve({ code, stdout, stderr }));
});
server.close();

const reports = fs.existsSync(out) ? fs.readdirSync(out) : [];
const jsonFile = reports.find((f) => f.endsWith('.json'));
const report = jsonFile ? JSON.parse(fs.readFileSync(path.join(out, jsonFile), 'utf8')) : null;
const row = (id) => report?.results?.find((r) => r.task === id);
check('прогон дошёл до конца, код 1 — одна задача провалена', run.code === 1, `${run.code} ${run.stdout.slice(-400)} ${run.stderr.slice(-400)}`);
check('отчёт Markdown и JSON записаны', reports.some((f) => f.endsWith('.md')) && Boolean(report));
check('fix-json: агент переписал файл — все проверки ✅', row('fix-json')?.ok === true && row('fix-json').session, JSON.stringify(row('fix-json')));
check('count-words: неверный ответ — ❌ с причиной', row('count-words')?.ok === false && /в ответе нет/.test(row('count-words').checks.find((c) => !c.ok)?.detail || ''), JSON.stringify(row('count-words')));
check('в выводе — сводка «1 из 2»', /поддельная \| 1 из 2 \(50%\)/.test(run.stdout), run.stdout.slice(-600));

try {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
} catch {
  /* Electron держит файлы */
}
console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
