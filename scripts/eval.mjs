#!/usr/bin/env node
/**
 * Набор сценариев MAI (Q5, ADR 0082): 20 типовых задач, прогон по профилям
 * агента через `mai -p`, отчёт Markdown и JSON.
 *
 *   npm run eval                                   — все задачи, профили из evals/profiles.json
 *   npm run eval -- --tasks fix-bug,csv-summary    — выбранные задачи
 *   npm run eval -- --profiles мои-профили.json --out отчёты/
 *
 * Профиль: { name, model, mode, allow: [правила], kind? }. Каждая задача — в
 * чистой временной папке; проверки — по файлам и ответу (evals/tasks.json).
 * Прогон стоит денег: каждая задача — настоящий запрос к модели.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeFiles, gradeTask, validateTasks, reportMarkdown } from './eval-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, fallback = '') => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const tasksFile = flag('--tasks-file', path.join(root, 'evals', 'tasks.json'));
const profilesFile = flag('--profiles', path.join(root, 'evals', 'profiles.json'));
const outDir = path.resolve(flag('--out', path.join(root, 'evals', 'reports')));
const only = flag('--tasks').split(',').filter(Boolean);
const timeoutSec = Number(flag('--timeout', '600'));
// Для проверки самого раннера в CI: своя папка данных приложения.
const userDataDir = flag('--user-data-dir');

const data = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
const errors = validateTasks(data);
if (errors.length) {
  console.error(`Набор задач с ошибками:\n${errors.join('\n')}`);
  process.exit(2);
}
const tasks = data.tasks.filter((t) => !only.length || only.includes(t.id));
const profiles = JSON.parse(fs.readFileSync(profilesFile, 'utf8')).profiles || [];
if (!tasks.length || !profiles.length) {
  console.error('Нет задач или профилей');
  process.exit(2);
}

/** Один прогон агента через лаунчер `mai`: итог JSON из последней строки stdout. */
function runAgent(task, profile, dir) {
  const allow = task.allow ?? profile.allow ?? [];
  const argv = [
    path.join(root, 'bin', 'mai.mjs'),
    ...(userDataDir ? [`--user-data-dir=${userDataDir}`] : []),
    '-p', task.prompt,
    '--output', 'json',
    '--mode', task.mode || profile.mode || 'acceptEdits',
    '--kind', task.kind || profile.kind || 'code',
    '--cwd', dir,
    ...(profile.model ? ['--model', profile.model] : []),
    ...(profile.maxTurns ? ['--max-turns', String(profile.maxTurns)] : []),
    ...allow.flatMap((r) => ['--allow', r]),
  ];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, argv, { cwd: dir, env: { ...process.env, MAI_NO_SANDBOX: process.env.MAI_NO_SANDBOX || '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutSec * 1000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      let result = null;
      try {
        result = JSON.parse(out.trim().split('\n').filter((l) => l.startsWith('{')).at(-1));
      } catch {
        /* не JSON */
      }
      resolve({ code, result, stderr: err.replace(/^\[\d+:.*(ERROR|WARNING).*$/gm, '').trim().slice(-800) });
    });
  });
}

const startedAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const results = [];
for (const profile of profiles) {
  for (const task of tasks) {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `mai-eval-${task.id}-`)));
    writeFiles(dir, task.files);
    const started = Date.now();
    const run = await runAgent(task, profile, dir);
    const answer = run.result?.result || '';
    const grade = gradeTask(task, { dir, answer, original: task.files || {} });
    const row = {
      profile: profile.name,
      task: task.id,
      ok: Boolean(run.result?.ok) && grade.ok,
      checks: grade.checks,
      durationMs: Date.now() - started,
      usage: run.result?.usage || null,
      ...(run.result?.ok ? {} : { error: run.result?.error || `код ${run.code}: ${run.stderr.slice(-200)}` }),
      session: run.result?.session_id || '',
    };
    results.push(row);
    console.log(`${row.ok ? 'OK  ' : 'FAIL'} ${profile.name} · ${task.id}${row.ok ? '' : ` — ${row.error || row.checks.find((c) => !c.ok)?.detail}`}`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

fs.mkdirSync(outDir, { recursive: true });
const stamp = startedAt.replace(/[:]/g, '-');
const md = reportMarkdown({ results, profiles, tasks, startedAt });
fs.writeFileSync(path.join(outDir, `eval-${stamp}.md`), md);
fs.writeFileSync(path.join(outDir, `eval-${stamp}.json`), JSON.stringify({ startedAt, profiles, results }, null, 2));
console.log(`\n${md}`);
console.log(`Отчёт: ${path.join(outDir, `eval-${stamp}.md`)}`);
const passed = results.filter((r) => r.ok).length;
console.log(`\nИтог: ${passed} OK, ${results.length - passed} FAIL`);
process.exit(passed === results.length ? 0 : 1);
