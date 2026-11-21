/**
 * Слэш-команды и упоминания файлов (бэклог CC7.7, CC7.8, CC7.9).
 *
 * - Встроенные команды выполняет окно (`/clear`, `/model`, …): здесь только их описание.
 * - Свои команды — Markdown-файлы `.mai-code/commands/<имя>.md` (проект, только
 *   доверенная папка) и `<данные>/commands/<имя>.md` (глобально). Тело — шаблон
 *   запроса с `$ARGUMENTS` и `$1`…`$9`; frontmatter: description, argument-hint.
 * - Навыки вызываются как `/<навык>`.
 *
 * Модуль не зависит от Electron: папки передают явно.
 */
import fs from 'node:fs';
import path from 'node:path';

export const BUILTIN_COMMANDS = [
  { name: 'help', description: 'Список команд и клавиш' },
  { name: 'clear', description: 'Новый чат' },
  { name: 'resume', description: 'Найти и продолжить чат', argumentHint: '[поиск]' },
  { name: 'model', description: 'Сменить модель', argumentHint: '<часть названия>' },
  { name: 'mode', description: 'Режим разрешений', argumentHint: 'manual | acceptEdits | plan | dontAsk | bypass' },
  { name: 'init', description: 'Изучить проект и написать AGENTS.md' },
  { name: 'memory', description: 'Открыть память проекта' },
  { name: 'export', description: 'Скачать чат', argumentHint: 'md | txt | docx | xlsx' },
  { name: 'context', description: 'Из чего состоит контекст модели' },
  { name: 'compact', description: 'Сжать раннюю часть диалога в сводку', argumentHint: '[что сохранить]' },
  { name: 'cost', description: 'Токены и стоимость чата' },
  { name: 'hooks', description: 'Хуки на события агента' },
  { name: 'permissions', description: 'Правила разрешений по уровням и проверка вызова' },
  { name: 'trash', description: 'Корзина: удалённые агентом файлы, восстановление' },
  { name: 'agents', description: 'Типы субагентов' },
  { name: 'packages', description: 'Пакеты плагинов: список, установка, включение' },
];

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

function parseFrontmatter(raw) {
  const text = String(raw || '').replace(/^﻿/, '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { meta: {}, body: text };
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (m) meta[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return { meta, body: text.slice(match[0].length) };
}

/** Порядок: проект → пакеты (ADR 0037) → глобальные; первая команда с именем побеждает. */
export function commandDirs(projectDir, dataDir, { includeProject = true, extraDirs = [] } = {}) {
  const dirs = [];
  if (includeProject && projectDir) dirs.push({ source: 'project', dir: path.join(projectDir, '.mai-code', 'commands') });
  dirs.push(...extraDirs);
  if (dataDir) dirs.push({ source: 'global', dir: path.join(dataDir, 'commands') });
  return dirs;
}

/** Свои команды. Команда проекта сильнее глобальной с тем же именем. */
export function listCustomCommands(projectDir, dataDir, options = {}) {
  const seen = new Map();
  for (const { source, dir } of commandDirs(projectDir, dataDir, options)) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const name = entry.name.slice(0, -3);
      if (!NAME_RE.test(name) || seen.has(name.toLowerCase())) continue;
      if (BUILTIN_COMMANDS.some((c) => c.name === name.toLowerCase())) continue; // встроенные не переопределяются
      const file = path.join(dir, entry.name);
      try {
        const { meta, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
        seen.set(name.toLowerCase(), {
          name,
          description: meta.description || body.split(/\r?\n/).find((l) => l.trim())?.slice(0, 120) || '',
          argumentHint: meta['argument-hint'] || '',
          source,
          file,
          body,
        });
      } catch {
        /* нечитаемый файл пропускаем */
      }
    }
  }
  return [...seen.values()];
}

/** Разбор аргументов: слова и строки в кавычках. */
export function splitArgs(text) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(text || '')))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** Подстановка `$ARGUMENTS` и `$1`…`$9`. Без `$ARGUMENTS` аргументы дописываются в конец. */
export function expandTemplate(body, argsText) {
  const raw = String(argsText || '').trim();
  const parts = splitArgs(raw);
  let used = false;
  let text = String(body || '').replace(/\$ARGUMENTS\b/g, () => {
    used = true;
    return raw;
  });
  text = text.replace(/\$([1-9])\b/g, (_m, n) => {
    used = true;
    return parts[Number(n) - 1] ?? '';
  });
  if (!used && raw) text = `${text.trimEnd()}\n\n${raw}`;
  return text.trim();
}

/* ---------- упоминания файлов (@путь) ---------- */

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', 'release', '.next', '.venv', 'venv', '__pycache__', '.repowise', 'coverage']);
const MAX_FILES = 20_000;
const cache = new Map(); // projectDir → { at, files }

export function projectFiles(projectDir, { ttlMs = 30_000 } = {}) {
  const key = path.resolve(projectDir || '.');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.files;
  const files = [];
  const walk = (dir, rel) => {
    if (files.length >= MAX_FILES) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return;
      const name = entry.name;
      const next = rel ? `${rel}/${name}` : name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(name) || (name.startsWith('.') && name !== '.mai-code' && name !== '.github')) continue;
        if (rel === '.mai-code' && name === 'uploads') continue;
        files.push(`${next}/`);
        walk(path.join(dir, name), next);
      } else if (entry.isFile()) {
        files.push(next);
      }
    }
  };
  walk(key, '');
  cache.set(key, { at: Date.now(), files });
  return files;
}

/**
 * Поиск файла по части пути: сначала совпадение имени с начала, затем вхождение
 * в имя, затем в путь. Короткие пути выше длинных.
 */
export function searchFiles(projectDir, query, { limit = 20 } = {}) {
  const q = String(query || '').toLowerCase().replace(/\\/g, '/');
  const files = projectFiles(projectDir);
  if (!q) return files.filter((f) => !f.includes('/') || (f.endsWith('/') && f.split('/').length === 2)).slice(0, limit);
  const scored = [];
  for (const file of files) {
    const lower = file.toLowerCase();
    const base = lower.replace(/\/$/, '').split('/').pop();
    let score = -1;
    if (base.startsWith(q)) score = 0;
    else if (base.includes(q)) score = 1;
    else if (lower.includes(q)) score = 2;
    if (score >= 0) scored.push({ file, score, len: file.length });
  }
  scored.sort((a, b) => a.score - b.score || a.len - b.len || a.file.localeCompare(b.file));
  return scored.slice(0, limit).map((s) => s.file);
}

/** Упоминания `@путь` в тексте, существующие внутри проекта. */
export function resolveMentions(projectDir, text) {
  const found = [];
  const re = /(^|\s)@([^\s@]+)/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const rel = m[2].replace(/[.,;:!?)]+$/, '');
    const full = path.resolve(projectDir, rel);
    const inside = path.relative(projectDir, full);
    if (inside.startsWith('..') || path.isAbsolute(inside)) continue;
    try {
      const stat = fs.statSync(full);
      if (!found.some((f) => f.path === rel)) found.push({ path: rel.replace(/\\/g, '/'), dir: stat.isDirectory() });
    } catch {
      /* не файл проекта — обычный текст с @ */
    }
  }
  return found;
}

export function clearFileCache() {
  cache.clear();
}
