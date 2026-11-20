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

/** Корневые инструкции проекта: AGENTS.md + AGENTS.local.md с подстановкой импортов. */
export function projectInstructions(projectDir) {
  const parts = [];
  for (const name of ['AGENTS.md', 'AGENTS.local.md']) {
    const file = path.join(projectDir, name);
    try {
      const text = fs.readFileSync(file, 'utf8');
      if (text.trim()) parts.push({ name, text: expandImports(text, { baseDir: projectDir, projectDir, seen: new Set([path.resolve(file)]) }) });
    } catch {
      /* файла нет */
    }
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
