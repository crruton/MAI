/**
 * Типы субагентов (бэклог CC8.1–CC8.3, ADR 0036).
 *
 * Встроенные: explore (только чтение), plan (только чтение, итог — план),
 * general (все инструменты родителя, кроме диалоговых). Свои — Markdown-файлы
 * `.mai-code/agents/<имя>.md` (проект, только доверенная папка) и
 * `<данные>/agents/<имя>.md`; frontmatter: description, tools (через запятую).
 * Тело — дополнение к системному промпту субагента.
 *
 * Модуль не зависит от Electron.
 */
import fs from 'node:fs';
import path from 'node:path';

const READ_TOOLS = ['read_file', 'read_document', 'list_files', 'glob', 'grep', 'load_skill', 'memory_read', 'repowise_ask', 'repowise_context', 'repowise_risk', 'repowise_search'];

/** Инструменты, которых у субагента нет никогда: диалог с пользователем и вложенные субагенты. */
export const NEVER_FOR_SUBAGENT = new Set(['agent', 'ask_user', 'exit_plan', 'todo_write']);

export const BUILTIN_AGENTS = [
  {
    name: 'explore',
    description: 'Исследователь: быстро найти файлы, код и факты в проекте. Только чтение.',
    tools: READ_TOOLS,
    prompt:
      'Ты — субагент-исследователь. Найди то, о чём просят, и верни короткий отчёт: факты, пути файлов с номерами строк, ' +
      'что не нашлось. Файлы не меняешь и команды не запускаешь.',
    source: 'builtin',
  },
  {
    name: 'plan',
    description: 'Планировщик: изучить код и вернуть план изменений с файлами и рисками. Только чтение.',
    tools: READ_TOOLS,
    prompt:
      'Ты — субагент-планировщик. Изучи код и верни план: шаги, конкретные файлы и функции, риски, как проверить. ' +
      'Файлы не меняешь и команды не запускаешь.',
    source: 'builtin',
  },
  {
    name: 'general',
    description: 'Исполнитель: самостоятельная подзадача с правками и командами в рамках режима разрешений.',
    tools: null, // все инструменты родителя
    prompt: 'Ты — субагент-исполнитель. Выполни подзадачу до конца, проверь результат и верни отчёт: что сделано, какие файлы изменены, что проверено.',
    source: 'builtin',
  },
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

/** Встроенные и свои типы. Свой тип проекта сильнее глобального; встроенные имена не переопределяются. */
export function listAgentDefs(projectDir, dataDir, { includeProject = true, extraDirs = [] } = {}) {
  const defs = new Map(BUILTIN_AGENTS.map((d) => [d.name, d]));
  const dirs = [];
  if (includeProject && projectDir) dirs.push({ source: 'project', dir: path.join(projectDir, '.mai-code', 'agents') });
  dirs.push(...extraDirs); // пакеты (ADR 0037)
  if (dataDir) dirs.push({ source: 'global', dir: path.join(dataDir, 'agents') });
  for (const { source, dir } of dirs) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const name = entry.name.slice(0, -3);
      if (!NAME_RE.test(name) || defs.has(name)) continue;
      try {
        const { meta, body } = parseFrontmatter(fs.readFileSync(path.join(dir, entry.name), 'utf8'));
        const tools = String(meta.tools || '')
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean);
        defs.set(name, {
          name,
          description: meta.description || body.split(/\r?\n/).find((l) => l.trim())?.slice(0, 160) || name,
          tools: tools.length ? tools : null,
          prompt: body.trim(),
          source,
        });
      } catch {
        /* нечитаемый файл пропускаем */
      }
    }
  }
  return [...defs.values()];
}

/** Субагент только читает: все его инструменты — из списка чтения. Такие можно запускать параллельно. */
export function isReadOnlyDef(def) {
  return Array.isArray(def?.tools) && def.tools.every((t) => READ_TOOLS.includes(t));
}

/** Схема инструмента agent: типы и их описания — в описании, чтобы модель выбирала осознанно. */
export function agentToolSchema(defs) {
  const list = defs.map((d) => `- ${d.name}: ${d.description}`).join('\n');
  return {
    type: 'function',
    function: {
      name: 'agent',
      description:
        'Поручить подзадачу субагенту со своим контекстом: вернётся только его итог. Полезно, чтобы не засорять контекст ' +
        'поиском по коду или разбором большого объёма. Несколько субагентов только для чтения в одном шаге работают параллельно.\n' +
        `Типы:\n${list}`,
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: defs.map((d) => d.name), description: 'Тип субагента' },
          description: { type: 'string', description: 'Короткое название задачи, 3–6 слов' },
          prompt: { type: 'string', description: 'Полная задача: субагент не видит этот диалог' },
        },
        required: ['type', 'prompt'],
      },
    },
  };
}
