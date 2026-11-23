/**
 * Инструкции проекта сверх корневого AGENTS.md (бэклог CC4.1, CC4.2).
 *
 * - `AGENTS.local.md` в корне — личные правила, не для git; читается вместе с AGENTS.md.
 * - Строка `@путь/к/файлу.md` в AGENTS.md подставляет файл (внутри проекта,
 *   глубина до 3, не больше 20 КБ на файл).
 * - Вложенные `AGENTS.md` в подпапках не грузятся в системный промпт: их
 *   правила приходят агенту вместе с результатом инструмента, когда он впервые
 *   трогает файл в этой папке.
 *
 * Всё это — только для доверенной папки (ADR 0028). Модуль не зависит от Electron.
 */
import fs from 'node:fs';
import path from 'node:path';

const MAX_IMPORT_BYTES = 20 * 1024;
const MAX_DEPTH = 3;

function inside(projectDir, target) {
  const rel = path.relative(projectDir, target);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Подставляет строки `@путь` содержимым файлов. Циклы и выход из проекта пропускаются. */
export function expandImports(text, { baseDir, projectDir, depth = 0, seen = new Set() } = {}) {
  return String(text || '').replace(/^@(\S+)\s*$/gm, (line, rel) => {
    if (depth >= MAX_DEPTH) return line;
    const full = path.resolve(baseDir, rel);
    if (!inside(projectDir, full) || seen.has(full)) return line;
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile() || stat.size > MAX_IMPORT_BYTES) return `${line} (не подставлен: файл больше 20 КБ или не файл)`;
      const next = new Set(seen).add(full);
      const body = expandImports(fs.readFileSync(full, 'utf8'), { baseDir: path.dirname(full), projectDir, depth: depth + 1, seen: next });
      return `<!-- из ${path.relative(projectDir, full).split(path.sep).join('/')} -->\n${body.trim()}`;
    } catch {
      return line;
    }
  });
}

// Инструкции других агентов (CC4.6, ADR 0080): Claude Code, Gemini CLI, Copilot.
const COMPAT_FILES = ['CLAUDE.md', 'CLAUDE.local.md', 'GEMINI.md', '.github/copilot-instructions.md'];

const normalize = (text) => String(text || '').replace(/\r\n/g, '\n').replace(/\s+$/gm, '').trim();

/** Файл — только ссылка на AGENTS.md (`@AGENTS.md`, «см. AGENTS.md»): дублировать незачем. */
function onlyPointsToAgents(text) {
  const lines = normalize(text).split('\n').filter((l) => l.trim() && !/^#/.test(l.trim()));
  return lines.length > 0 && lines.length <= 2 && lines.every((l) => /AGENTS\.md/i.test(l));
}

/** Правила Cursor: `.cursor/rules/*.mdc` (frontmatter alwaysApply/description/globs) и `.cursorrules`. */
export function cursorRules(projectDir) {
  const out = [];
  const legacy = path.join(projectDir, '.cursorrules');
  try {
    const text = fs.readFileSync(legacy, 'utf8');
    if (text.trim()) out.push({ name: '.cursorrules', always: true, text: text.slice(0, MAX_IMPORT_BYTES) });
  } catch {
    /* нет */
  }
  const dir = path.join(projectDir, '.cursor', 'rules');
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.filter((e) => e.isFile() && /\.mdc?$/i.test(e.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    try {
      const raw = fs.readFileSync(path.join(dir, entry.name), 'utf8').replace(/^\uFEFF/, '');
      const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
      const meta = {};
      for (const line of (m?.[1] || '').split(/\r?\n/)) {
        const kv = /^([A-Za-z]+)\s*:\s*(.*)$/.exec(line.trim());
        if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
      }
      const body = (m ? raw.slice(m[0].length) : raw).trim();
      if (!body) continue;
      out.push({ name: `.cursor/rules/${entry.name}`, always: String(meta.alwaysApply) === 'true', description: meta.description || '', globs: meta.globs || '', text: body.slice(0, MAX_IMPORT_BYTES) });
    } catch {
      /* нечитаемый — пропускаем */
    }
  }
  return out;
}

/**
 * Корневые инструкции проекта: AGENTS.md + AGENTS.local.md с подстановкой импортов;
 * при `compat` — ещё CLAUDE.md, GEMINI.md, Copilot и правила Cursor, если они не
 * повторяют AGENTS.md (CC4.6). Правила Cursor без alwaysApply — списком: агент
 * дочитает нужное сам.
 */
export function projectInstructions(projectDir, { compat = true } = {}) {
  const parts = [];
  const seenTexts = new Set();
  const add = (name, file) => {
    try {
      const text = fs.readFileSync(file, 'utf8');
      if (!text.trim()) return;
      if (name !== 'AGENTS.md' && name !== 'AGENTS.local.md' && onlyPointsToAgents(text)) return;
      const expanded = expandImports(text, { baseDir: path.dirname(file), projectDir, seen: new Set([path.resolve(file)]) });
      const key = normalize(expanded);
      if (seenTexts.has(key)) return;
      seenTexts.add(key);
      parts.push({ name, text: expanded });
    } catch {
      /* файла нет */
    }
  };
  for (const name of ['AGENTS.md', 'AGENTS.local.md']) add(name, path.join(projectDir, name));
  if (!compat) return parts;
  for (const name of COMPAT_FILES) add(name, path.join(projectDir, name));
  const rules = cursorRules(projectDir);
  for (const rule of rules.filter((r) => r.always)) {
    const key = normalize(rule.text);
    if (!seenTexts.has(key)) {
      seenTexts.add(key);
      parts.push({ name: rule.name, text: rule.text });
    }
  }
  const onDemand = rules.filter((r) => !r.always);
  if (onDemand.length) {
    parts.push({
      name: 'правила Cursor по запросу',
      text: `Прочитай нужное read_file, когда задача их касается:\n${onDemand.map((r) => `- ${r.name}${r.description ? ` — ${r.description}` : ''}${r.globs ? ` (файлы: ${r.globs})` : ''}`).join('\n')}`,
    });
  }
  return parts;
}

/**
 * Вложенные AGENTS.md между папкой файла и корнем проекта (корень не включается:
 * он уже в системном промпте), ещё не показанные агенту. Ближние к корню — первыми.
 */
export function nestedInstructions(projectDir, filePath, loaded = new Set()) {
  if (!projectDir || !filePath) return [];
  const root = path.resolve(projectDir);
  let dir = path.resolve(filePath);
  try {
    if (!fs.statSync(dir).isDirectory()) dir = path.dirname(dir);
  } catch {
    dir = path.dirname(dir);
  }
  const found = [];
  while (inside(root, dir) && dir !== root) {
    const file = path.join(dir, 'AGENTS.md');
    if (!loaded.has(file) && fs.existsSync(file)) {
      try {
        const text = fs.readFileSync(file, 'utf8').trim();
        if (text) found.unshift({ file, rel: path.relative(root, file).split(path.sep).join('/'), text: text.slice(0, MAX_IMPORT_BYTES) });
      } catch {
        /* нечитаемый — пропускаем */
      }
    }
    dir = path.dirname(dir);
  }
  for (const item of found) loaded.add(item.file);
  return found;
}
