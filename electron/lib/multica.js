import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

/**
 * Официальный установщик добавляет `%USERPROFILE%\.multica\bin` в PATH, но
 * уже запущенный процесс (и Explorer до перезапуска) этого PATH не видит.
 * Поэтому ищем CLI и по стандартным местам установки, а не только в PATH.
 */
export function resolveCommand(name = command()) {
  const raw = String(name || '').trim();
  if (!raw) return '';
  if (path.isAbsolute(raw) || raw.includes('\\') || raw.includes('/')) {
    return fs.existsSync(raw) ? raw : '';
  }
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [raw], {
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
  const first = String(probe.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (probe.status === 0 && first) return first;

  const candidates = [
    path.join(os.homedir(), '.multica', 'bin', process.platform === 'win32' ? `${raw}.exe` : raw),
    path.join(os.homedir(), '.multica', 'bin', raw),
  ];
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'multica', `${raw}.exe`));
  }
  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

/**
 * cmd.exe на Windows печатает системные ошибки в OEM-кодировке (cp866),
 * а сам multica — в UTF-8. Поэтому декодируем буфер: сначала строгий UTF-8,
 * затем cp866/cp1251. Иначе в интерфейсе появляются «кракозябры».
 */
export function decodeOutput(buffer) {
  if (!Buffer.isBuffer(buffer)) return String(buffer ?? '');
  const attempts = ['utf-8', 'cp866', 'windows-1251'];
  for (const encoding of attempts) {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(buffer);
    } catch {
      /* пробуем следующую кодировку */
    }
  }
  return buffer.toString('utf8');
}

function runRaw(executable, args, options = {}) {
  return spawnSync(executable, args, {
    cwd: options.cwd,
    encoding: 'buffer',
    timeout: options.timeout ?? 45_000,
    input: options.input,
    // shell:false обязателен: описания задач содержат переводы строк и
    // кириллицу, а cmd.exe искажает их и ломает аргументы.
    shell: false,
    windowsHide: true,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
}

function run(args, { timeout = 45_000, cwd } = {}) {
  const executable = resolveCommand() || command();
  const result = runRaw(executable, args, { timeout, cwd });
  if (result.error) throw new Error(decodeOutput(result.error.message));
  const stdout = decodeOutput(result.stdout).trim();
  const stderr = decodeOutput(result.stderr).trim();
  if (result.status !== 0) {
    throw new Error(stderr || stdout || `multica завершился с кодом ${result.status}`);
  }
  return stdout;
}

function json(args, options) {
  const raw = run(args, options);
  if (!raw) return null;
  const start = Math.min(...[raw.indexOf('{'), raw.indexOf('[')].filter((i) => i >= 0));
  const text = Number.isFinite(start) ? raw.slice(start) : raw;
  return JSON.parse(text);
}

export function probeCommand(name = command()) {
  const resolved = resolveCommand(name);
  return { available: Boolean(resolved), path: resolved, output: resolved };
}

export function status() {
  const settings = loadSettings();
  const config = settings.multica || {};
  const probe = probeCommand();
  if (!probe.available) {
    return {
      available: false,
      version: '',
      error: `CLI «${command()}» не найден в PATH`,
      hint: 'Установите официальный CLI кнопкой «Установить CLI» в этой панели или командой: irm https://raw.githubusercontent.com/multica-ai/multica/main/scripts/install.ps1 | iex',
      config: {
        url: config.url || 'http://localhost:8080',
        appUrl: config.appUrl || 'http://localhost:3000',
        workspaceId: config.workspaceId || '',
        command: command(),
      },
    };
  }
  let version = '';
  let error = '';
  try {
    version = run(['version'], { timeout: 15_000 }).split(/\r?\n/)[0];
  } catch (err) {
    try {
      version = run(['--version'], { timeout: 15_000 }).split(/\r?\n/)[0];
    } catch {
      error = err.message;
    }
  }
  return {
    available: true,
    version,
    path: probe.path,
    error,
    config: {
      url: config.url || 'http://localhost:8080',
      appUrl: config.appUrl || 'http://localhost:3000',
      workspaceId: config.workspaceId || '',
      command: command(),
    },
  };
}

/** Устанавливает официальный CLI через скрипт multica (только Windows). */
export function installCli() {
  if (process.platform !== 'win32') {
    return { ok: false, error: 'Автоустановка реализована для Windows. Используйте brew install multica-ai/tap/multica.' };
  }
  const script = [
    '$ErrorActionPreference = "Stop";',
    'irm https://raw.githubusercontent.com/multica-ai/multica/main/scripts/install.ps1 | iex',
  ].join(' ');
  const result = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'buffer',
    timeout: 10 * 60 * 1000,
    windowsHide: true,
    env: { ...process.env, NO_COLOR: '1' },
  });
  const output = `${decodeOutput(result.stdout || Buffer.alloc(0))}${decodeOutput(result.stderr || Buffer.alloc(0))}`.trim();
  if (result.error) return { ok: false, error: decodeOutput(result.error.message), output };
  if (result.status !== 0) return { ok: false, error: `Установщик завершился с кодом ${result.status}`, output };
  return { ok: true, output: output.slice(-8000), note: 'CLI установлен в %USERPROFILE%\\.multica\\bin. Перезапустите приложение, если PATH ещё не обновился.' };
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
