import fs from 'node:fs';
import path from 'node:path';
import { isSecretPath } from '../guardrails.js';

const MAX_READ_BYTES = 400_000;
const MAX_OUTPUT = 20_000;

function assertNotSecret(ctx, file, action = 'чтение') {
  const guardrails = ctx.guardrails || {};
  if (guardrails.protectSecrets === false || guardrails.allowSecrets) return;
  if (isSecretPath(file)) {
    throw new Error(
      `Guardrails: ${action} секретного файла запрещено (${path.basename(file)}). ` +
        'Включите «Разрешить доступ к секретам» в настройках, если это осознанно.',
    );
  }
}

const PREVIEW_BYTES = 1024 * 1024;

function resolveInside(ctx, target) {
  const base = ctx.projectDir || process.cwd();
  const resolved = path.resolve(base, target || '.');
  if (!ctx.allowOutsideProject) {
    const relative = path.relative(base, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(
        `Путь вне проекта запрещён: ${resolved}. Включите «Разрешить файлы вне проекта» в настройках.`,
      );
    }
  }
  return resolved;
}

function lineNumbers(text, offset = 1) {
  return text
    .split(/\r?\n/)
    .map((line, i) => `${String(i + offset).padStart(5)} | ${line}`)
    .join('\n');
}

function truncate(text) {
  if (text.length <= MAX_OUTPUT) return text;
  return `${text.slice(0, MAX_OUTPUT)}\n\n… обрезано (${text.length} символов, показаны первые ${MAX_OUTPUT})`;
}

export const fsTools = [
  {
    schema: {
      type: 'function',
      function: {
        name: 'read_file',
        description:
          'Прочитать текстовый файл. Возвращает содержимое с номерами строк. Используй offset/limit для больших файлов.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Путь относительно корня проекта или абсолютный' },
            offset: { type: 'integer', description: 'С какой строки начать (1-based)' },
            limit: { type: 'integer', description: 'Сколько строк прочитать' },
          },
          required: ['path'],
        },
      },
    },
    async run(ctx, args) {
      const file = resolveInside(ctx, args.path);
      assertNotSecret(ctx, file, 'чтение');
      const stat = fs.statSync(file);
      if (stat.size > MAX_READ_BYTES) throw new Error(`Файл слишком большой: ${stat.size} байт`);
      const text = fs.readFileSync(file, 'utf8');
      const lines = text.split(/\r?\n/);
      const start = Math.max(0, (args.offset || 1) - 1);
      const end = args.limit ? start + args.limit : lines.length;
      return truncate(lineNumbers(lines.slice(start, end).join('\n'), start + 1));
    },
  },
  {
    schema: {
      type: 'function',
      function: {
        name: 'list_files',
        description: 'Показать дерево файлов и папок в проекте. Пропускает node_modules, .git, dist.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Папка относительно корня проекта' },
            depth: { type: 'integer', description: 'Глубина, по умолчанию 2' },
          },
        },
      },
    },
    async run(ctx, args) {
      const root = resolveInside(ctx, args.path || '.');
      const maxDepth = Math.min(args.depth || 2, 5);
      const skip = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv']);
      const out = [];
      const walk = (dir, prefix, depth) => {
        if (depth > maxDepth) return;
        let entries = [];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        entries
          .filter((e) => !skip.has(e.name))
          .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
          .forEach((entry, index, list) => {
            const last = index === list.length - 1;
            out.push(`${prefix}${last ? '└─ ' : '├─ '}${entry.name}${entry.isDirectory() ? '/' : ''}`);
            if (entry.isDirectory()) walk(path.join(dir, entry.name), prefix + (last ? '   ' : '│  '), depth + 1);
          });
      };
      walk(root, '', 1);
      return truncate(out.join('\n') || '(пусто)');
    },
  },
  {
    schema: {
      type: 'function',
      function: {
        name: 'grep',
        description: 'Найти строки по регулярному выражению в файлах проекта.',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Регулярное выражение (JavaScript)' },
            path: { type: 'string', description: 'Где искать, по умолчанию корень проекта' },
            include: { type: 'string', description: 'Фильтр файлов, например .js или .tsx' },
          },
          required: ['pattern'],
        },
      },
    },
    async run(ctx, args) {
      const root = resolveInside(ctx, args.path || '.');
      const re = new RegExp(args.pattern, 'i');
      const skip = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv']);
      const hits = [];
      // Путь может указывать на файл. Раньше readdirSync падал, ошибка глушилась
      // и grep молча возвращал «Совпадений нет» — агент делал лишние итерации.
      const scanFile = (full) => {
        if (args.include && !full.endsWith(args.include)) return;
        if (isSecretPath(full) && !(ctx.guardrails?.allowSecrets)) return;
        let text = '';
        try {
          const stat = fs.statSync(full);
          if (!stat.isFile() || stat.size > 500_000) return;
          text = fs.readFileSync(full, 'utf8');
        } catch {
          return;
        }
        text.split(/\r?\n/).forEach((line, i) => {
          if (re.test(line)) hits.push(`${path.relative(ctx.projectDir, full)}:${i + 1}: ${line.trim().slice(0, 300)}`);
        });
      };
      const walk = (dir) => {
        if (hits.length > 300) return;
        let entries = [];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (skip.has(entry.name)) continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
            continue;
          }
          scanFile(full);
        }
      };
      let rootIsFile = false;
      try {
        rootIsFile = fs.statSync(root).isFile();
      } catch {
        return `Путь не найден: ${root}`;
      }
      if (rootIsFile) scanFile(root);
      else walk(root);
      return truncate(hits.join('\n') || 'Совпадений нет');
    },
  },
  {
    schema: {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Создать или полностью перезаписать файл. Подтверждение зависит от режима разрешений.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            content: { type: 'string' },
          },
          required: ['path', 'content'],
        },
      },
    },
    precheck(ctx, args) {
      const file = resolveInside(ctx, args.path);
      assertNotSecret(ctx, file, 'запись');
      return null;
    },
    /** Было/стало для diff в запросе разрешения (CC7.3). Большие файлы не сравниваем. */
    preview(ctx, args) {
      const file = resolveInside(ctx, args.path);
      const before = fs.existsSync(file) && fs.statSync(file).size <= PREVIEW_BYTES ? fs.readFileSync(file, 'utf8') : '';
      return { before, after: String(args.content ?? '') };
    },
    async run(ctx, args) {
      const file = resolveInside(ctx, args.path);
      assertNotSecret(ctx, file, 'запись');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, args.content ?? '', 'utf8');
      return `Записано: ${file} (${(args.content || '').length} символов)`;
    },
  },
  {
    schema: {
      type: 'function',
      function: {
        name: 'edit_file',
        description: 'Заменить точный фрагмент текста в файле. Подтверждение зависит от режима разрешений.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            old_string: { type: 'string', description: 'Что заменить (должно встречаться ровно один раз)' },
            new_string: { type: 'string', description: 'На что заменить' },
          },
          required: ['path', 'old_string', 'new_string'],
        },
      },
    },
    /**
     * Проверка до запроса разрешения: если фрагмента нет, пользователя не
     * спрашивают зря. Возвращает текст ошибки или null.
     */
    precheck(ctx, args) {
      const file = resolveInside(ctx, args.path);
      assertNotSecret(ctx, file, 'изменение');
      if (!fs.existsSync(file)) return `Файл не найден: ${file}`;
      const text = fs.readFileSync(file, 'utf8');
      const count = text.split(args.old_string).length - 1;
      if (count === 0) return `Фрагмент не найден в ${file}`;
      if (count > 1) return `Фрагмент встречается ${count} раз — уточните old_string`;
      return null;
    },
    preview(ctx, args) {
      const file = resolveInside(ctx, args.path);
      if (fs.statSync(file).size > PREVIEW_BYTES) {
        return { before: String(args.old_string ?? ''), after: String(args.new_string ?? '') };
      }
      const before = fs.readFileSync(file, 'utf8');
      return { before, after: before.replace(args.old_string, () => args.new_string) };
    },
    async run(ctx, args) {
      const file = resolveInside(ctx, args.path);
      assertNotSecret(ctx, file, 'изменение');
      const text = fs.readFileSync(file, 'utf8');
      const count = text.split(args.old_string).length - 1;
      if (count === 0) return `Фрагмент не найден в ${file}`;
      if (count > 1) return `Фрагмент встречается ${count} раз — уточните old_string`;
      fs.writeFileSync(file, text.replace(args.old_string, () => args.new_string), 'utf8');
      return `Изменено: ${file}`;
    },
  },
];
