import { spawnSync } from 'node:child_process';
import { loadSettings } from './config.js';
import { listChanges, taskMarker } from './openspec.js';

/**
 * Синхронизация OpenSpec → Multica через официальный CLI.
 *
 * Почему CLI, а не REST: CLI — документированный интерфейс Multica
 * (`multica issue create/list/update`). Внутренний REST API не гарантирует
 * стабильность между версиями, поэтому прямые HTTP-вызовы не используются.
 *
 * Идемпотентность: в описание задачи добавляется маркер
 * `<!-- openspec:<change>:<task> -->`. Повторный sync находит задачу по
 * маркеру и обновляет её, а не создаёт дубль.
 */

function command() {
  const settings = loadSettings();
  return String(settings.multica?.command || 'multica').trim() || 'multica';
}

function run(args, { timeout = 45_000, cwd } = {}) {
  const result = spawnSync(command(), args, {
    cwd,
    encoding: 'utf8',
    timeout,
    shell: process.platform === 'win32',
    windowsHide: true,
  });
  if (result.error) throw new Error(result.error.message);
  if (result.status !== 0) {
    const message = (result.stderr || result.stdout || '').trim();
    throw new Error(message || `multica завершился с кодом ${result.status}`);
  }
  return (result.stdout || '').trim();
}

function json(args, options) {
  const raw = run(args, options);
  if (!raw) return null;
  const start = Math.min(...[raw.indexOf('{'), raw.indexOf('[')].filter((i) => i >= 0));
  const text = Number.isFinite(start) ? raw.slice(start) : raw;
  return JSON.parse(text);
}

export function status() {
  const settings = loadSettings();
  const config = settings.multica || {};
  let available = false;
  let version = '';
  try {
    const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [command()], {
      encoding: 'utf8',
      timeout: 10_000,
      shell: process.platform === 'win32',
      windowsHide: true,
    });
    available = probe.status === 0;
    if (available) {
      version = run(['--version'], { timeout: 10_000 }).split(/\r?\n/)[0];
    }
  } catch (err) {
    return {
      available: false,
      version: '',
      error: err.message,
      config: { url: config.url || 'http://localhost:8080', appUrl: config.appUrl || 'http://localhost:3000' },
    };
  }
  return {
    available,
    version,
    error: available ? '' : `CLI «${command()}» не найден в PATH`,
    config: {
      url: config.url || 'http://localhost:8080',
      appUrl: config.appUrl || 'http://localhost:3000',
      workspaceId: config.workspaceId || '',
      command: command(),
    },
  };
}

export function authStatus() {
  try {
    return { ok: true, output: run(['auth', 'status'], { timeout: 20_000 }) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export function listIssues(limit = 30) {
  try {
    const data = json(['issue', 'list', '--output', 'json', '--limit', String(limit)]);
    const issues = Array.isArray(data) ? data : data?.issues || [];
    return {
      ok: true,
      issues: issues.map((issue) => ({
        id: issue.id,
        key: issue.identifier || issue.key || '',
        title: issue.title || '',
        status: issue.status || '',
        priority: issue.priority || '',
        description: issue.description || '',
      })),
    };
  } catch (err) {
    return { ok: false, error: err.message, issues: [] };
  }
}

function findIssue(issues, marker) {
  return issues.find((issue) => String(issue.description || '').includes(marker));
}

export function syncOpenSpec(projectDir) {
  if (!projectDir) throw new Error('Не выбрана папка проекта');
  const changes = listChanges(projectDir);
  if (!changes.length) {
    return { ok: true, created: 0, updated: 0, skipped: 0, changes: 0, message: 'В openspec/changes нет изменений' };
  }

  const listing = listIssues(100);
  if (!listing.ok) throw new Error(listing.error);
  const issues = [...listing.issues];

  let created = 0;
  let updated = 0;
  let skipped = 0;
  const details = [];

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

      const existing = findIssue(issues, marker);
      try {
        if (existing) {
          run(['issue', 'update', existing.id, '--title', title, '--description', description]);
          updated += 1;
          details.push({ action: 'updated', id: existing.id, title });
        } else {
          const output = run(['issue', 'create', '--title', title, '--description', description]);
          created += 1;
          details.push({ action: 'created', title, output: output.slice(0, 200) });
          // Добавляем в локальный список, чтобы не создать дубль внутри одного запуска.
          issues.push({ id: `local-${created}`, title, description });
        }
      } catch (err) {
        throw new Error(`Задача «${task.text}»: ${err.message}`);
      }
    }
  }

  return {
    ok: true,
    created,
    updated,
    skipped,
    changes: changes.length,
    details,
    message: `OpenSpec → Multica: создано ${created}, обновлено ${updated}, пропущено ${skipped}`,
  };
}
