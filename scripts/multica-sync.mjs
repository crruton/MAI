import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { listChanges, taskMarker, statusUpdatesFromIssues, applyTaskStatuses } from '../electron/lib/openspec.js';

/**
 * CLI-версия синхронизации OpenSpec → Multica.
 * Использует тот же парсер, что и приложение.
 *
 * Настройки: переменные окружения MULTICA_COMMAND (по умолчанию multica).
 * Проект: текущая папка или первый аргумент.
 * `--pull` — обратно (F14): задачи «готово» в Multica ставят [x] в tasks.md.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const pull = argv.includes('--pull');
const projectDir = path.resolve(argv.find((a) => !a.startsWith('--')) || root);
const command = process.env.MULTICA_COMMAND || 'multica';

function run(args) {
  const result = spawnSync(command, args, {
    cwd: projectDir,
    encoding: 'utf8',
    timeout: 45_000,
    shell: process.platform === 'win32',
    windowsHide: true,
  });
  if (result.error) throw new Error(result.error.message);
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || '').trim() || `код ${result.status}`);
  }
  return (result.stdout || '').trim();
}

function json(args) {
  const raw = run(args);
  if (!raw) return null;
  const start = Math.min(...[raw.indexOf('{'), raw.indexOf('[')].filter((i) => i >= 0));
  return JSON.parse(Number.isFinite(start) ? raw.slice(start) : raw);
}

const changes = listChanges(projectDir);
if (!changes.length) {
  console.log('В openspec/changes нет изменений.');
  process.exit(0);
}

let issues = [];
try {
  const data = json(['issue', 'list', '--output', 'json', '--limit', '100']);
  issues = Array.isArray(data) ? data : data?.issues || [];
} catch (err) {
  console.error(`Не удалось получить задачи Multica: ${err.message}`);
  console.error('Проверьте: multica auth status');
  process.exit(1);
}

if (pull) {
  const { updates, cancelled } = statusUpdatesFromIssues(issues);
  const report = applyTaskStatuses(projectDir, updates);
  for (const item of report.marked) console.log(`отмечено: ${item}`);
  for (const item of cancelled) console.log(`отменено в Multica (без галочки): ${item.change}:${item.taskId}`);
  for (const item of report.missing) console.log(`не найдено в tasks.md: ${item}`);
  console.log(`Готово: отмечено ${report.marked.length}, уже отмечено ${report.already.length}.`);
  process.exit(0);
}

let created = 0;
let updated = 0;
let skipped = 0;

for (const change of changes) {
  for (const task of change.tasks) {
    if (task.done) {
      skipped += 1;
      continue;
    }
    const marker = taskMarker(change.name, task.id);
    const title = `[OpenSpec] ${change.name}: ${task.text}`.slice(0, 180);
    const description = [
      `Изменение OpenSpec: \`${change.name}\``,
      '',
      change.summary || change.title,
      '',
      `Задача: ${task.text}`,
      '',
      `Файл: \`openspec/changes/${change.name}/tasks.md\` (строка ${task.line})`,
      '',
      marker,
    ].join('\n');

    const existing = issues.find((issue) => String(issue.description || '').includes(marker));
    if (existing) {
      run(['issue', 'update', existing.id, '--title', title, '--description', description]);
      updated += 1;
      console.log(`обновлено: ${title}`);
    } else {
      run(['issue', 'create', '--title', title, '--description', description]);
      created += 1;
      issues.push({ id: `local-${created}`, description });
      console.log(`создано: ${title}`);
    }
  }
}

console.log(`Готово: создано ${created}, обновлено ${updated}, пропущено ${skipped}.`);
