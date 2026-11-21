import fs from 'node:fs';
import path from 'node:path';
import { isSecretPath } from '../guardrails.js';
import { moveToTrash } from '../trash.js';
import { normalizeRoots, resolveIn } from '../workroots.js';

const MAX_READ_BYTES = 400_000;
const MAX_OUTPUT = 20_000;

export function assertNotSecret(ctx, file, action = 'чтение') {
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

/** Путь внутри рабочих папок чата (ADR 0045): папка проекта и добавленные `@имя`. */
export function resolveInside(ctx, target) {
  const roots = ctx.roots || normalizeRoots(ctx.projectDir || process.cwd());
  return resolveIn(roots, target || '.', { allowOutside: Boolean(ctx.allowOutsideProject) });
}

function isRootDir(ctx, file) {
  const roots = ctx.roots || normalizeRoots(ctx.projectDir || process.cwd());
  return roots.some((r) => path.resolve(r.dir) === path.resolve(file));
}

/* ---------- чтение перед правкой и план правок (CC1.2) ---------- */

/** Отметка «агент видел файл в этом виде». ctx.readFiles — Map путь → mtime, общий на прогон. */
export function markRead(ctx, file) {
  if (!ctx?.readFiles) return;
  try {
    ctx.readFiles.set(path.resolve(file), fs.statSync(file).mtimeMs);
  } catch {
    /* файла нет — нечего отмечать */
  }
}

/** Ошибка, если существующий файл меняют вслепую или он изменился после чтения. */
function readGuard(ctx, file) {
  if (!ctx?.readFiles || !fs.existsSync(file)) return null;
  const seen = ctx.readFiles.get(path.resolve(file));
  if (seen === undefined) return `Сначала прочитай файл read_file: ${file} — правка без чтения запрещена`;
  if (fs.statSync(file).mtimeMs !== seen) return `Файл изменился после чтения: ${file} — прочитай его заново`;
  return null;
}

const toCrlf = (text) => String(text).replace(/\r?\n/g, '\r\n');

/** План правки: { file, before, after, edits, replaced } или текст ошибки. */
function planEdits(ctx, args) {
  const file = resolveInside(ctx, args.path);
  assertNotSecret(ctx, file, 'изменение');
  if (!fs.existsSync(file)) return `Файл не найден: ${file}`;
  const guard = readGuard(ctx, file);
  if (guard) return guard;
  const edits = Array.isArray(args.edits) && args.edits.length ? args.edits : [{ old_string: args.old_string, new_string: args.new_string, replace_all: args.replace_all }];
  const before = fs.readFileSync(file, 'utf8');
  const crlf = before.includes('\r\n');
  let text = before;
  let replaced = 0;
  for (const [i, raw] of edits.entries()) {
    const label = edits.length > 1 ? ` (правка ${i + 1})` : '';
    let oldText = String(raw?.old_string ?? '');
    let newText = String(raw?.new_string ?? '');
    if (!oldText) return `Пустой old_string${label}`;
    if (oldText === newText) return `old_string и new_string совпадают${label}`;
    // Файл с CRLF, а фрагмент с LF — приводим к переводам строк файла.
    if (crlf && !text.includes(oldText) && text.includes(toCrlf(oldText))) {
      oldText = toCrlf(oldText);
      newText = toCrlf(newText);
    }
    const count = text.split(oldText).length - 1;
    if (count === 0) return `Фрагмент не найден в ${file}${label}`;
    if (count > 1 && !raw?.replace_all) return `Фрагмент встречается ${count} раз в ${file}${label} — уточните old_string или replace_all: true`;
    text = raw?.replace_all ? text.split(oldText).join(newText) : text.replace(oldText, () => newText);
    replaced += raw?.replace_all ? count : 1;
  }
  return { file, before, after: text, edits, replaced };
}

/* ---------- glob (CC1.1) ---------- */

/** Маска → RegExp: ** — любые папки, * — без /, ?, {a,b}. */
export function globToRegExp(pattern) {
  let re = '';
  const text = String(pattern).replace(/\\/g, '/');
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '*' && text[i + 1] === '*') {
      const slash = text[i + 2] === '/';
      re += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const close = text.indexOf('}', i);
      if (close < 0) re += '\\{';
      else {
        re += `(?:${text.slice(i + 1, close).split(',').map((p) => p.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|')})`;
        i = close;
      }
    } else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, process.platform === 'win32' ? 'i' : '');
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
      markRead(ctx, file);
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
        name: 'glob',
        description: 'Найти файлы по маске: "**/*.ts", "src/**/*.{js,jsx}", "@Документы/**/*.docx". Новые — первыми. Пропускает node_modules и .git.',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Маска относительно path' },
            path: { type: 'string', description: 'Где искать, по умолчанию корень проекта' },
          },
          required: ['pattern'],
        },
      },
    },
    async run(ctx, args) {
      const root = resolveInside(ctx, args.path || '.');
      const re = globToRegExp(String(args.pattern || '**/*'));
      const explicit = /node_modules|\.git\b/.test(String(args.pattern));
      const skip = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv']);
      const found = [];
      let scanned = 0;
      const walk = (dir) => {
        if (scanned > 50_000) return;
        let entries = [];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          scanned += 1;
          if (!explicit && skip.has(entry.name)) continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.isFile()) {
            const rel = path.relative(root, full).split(path.sep).join('/');
            if (re.test(rel)) {
              let mtime = 0;
              try {
                mtime = fs.statSync(full).mtimeMs;
              } catch {
                /* файл исчез */
              }
              found.push({ rel, mtime });
            }
          }
        }
      };
      walk(root);
      if (!found.length) return 'Файлов по маске нет';
      found.sort((a, b) => b.mtime - a.mtime);
      const shown = found.slice(0, 500).map((f) => f.rel);
      return truncate(`${shown.join('\n')}${found.length > 500 ? `\n… и ещё ${found.length - 500}` : ''}`);
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
      // Перезапись существующего файла — только после чтения (CC1.2).
      return readGuard(ctx, file);
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
      // Чекпоинт до записи: откат вернёт исходное содержимое (CC6.1).
      ctx.beforeWrite?.(file);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, args.content ?? '', 'utf8');
      markRead(ctx, file);
      return `Записано: ${file} (${(args.content || '').length} символов)`;
    },
  },
  {
    schema: {
      type: 'function',
      function: {
        name: 'edit_file',
        description:
          'Заменить точный фрагмент текста в файле. Файл нужно сначала прочитать read_file. old_string должен встречаться ровно один раз ' +
          '(или replace_all: true — заменить все). Несколько правок одного файла — массивом edits, применяются по порядку и атомарно. ' +
          'Переводы строк Windows (CRLF) учитываются сами.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            old_string: { type: 'string', description: 'Что заменить' },
            new_string: { type: 'string', description: 'На что заменить' },
            replace_all: { type: 'boolean', description: 'Заменить все вхождения' },
            edits: {
              type: 'array',
              description: 'Несколько правок по порядку (вместо old_string/new_string)',
              items: {
                type: 'object',
                properties: { old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } },
                required: ['old_string', 'new_string'],
              },
            },
          },
          required: ['path'],
        },
      },
    },
    /** До запроса разрешения: если правку не применить, пользователя не спрашивают зря. */
    precheck(ctx, args) {
      const plan = planEdits(ctx, args);
      return typeof plan === 'string' ? plan : null;
    },
    preview(ctx, args) {
      const plan = planEdits(ctx, args);
      if (typeof plan === 'string') return { before: '', after: '' };
      if (plan.before.length > PREVIEW_BYTES) return { before: plan.edits.map((e) => e.old_string).join('\n…\n'), after: plan.edits.map((e) => e.new_string).join('\n…\n') };
      return { before: plan.before, after: plan.after };
    },
    async run(ctx, args) {
      const plan = planEdits(ctx, args);
      if (typeof plan === 'string') return plan;
      ctx.beforeWrite?.(plan.file);
      fs.writeFileSync(plan.file, plan.after, 'utf8');
      markRead(ctx, plan.file);
      return `Изменено: ${plan.file} (правок: ${plan.edits.length}, замен: ${plan.replaced})`;
    },
  },
  {
    schema: {
      type: 'function',
      function: {
        name: 'delete_file',
        description:
          'Удалить файл или папку: переносится в корзину приложения, пользователь может восстановить. ' +
          'Подтверждение спрашивается всегда, кроме режима «Без вопросов». Не удаляй через run_shell (rm, del) — используй этот инструмент.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
    },
    precheck(ctx, args) {
      const file = resolveInside(ctx, args.path);
      assertNotSecret(ctx, file, 'удаление');
      if (!fs.existsSync(file)) return `Не найдено: ${file}`;
      if (isRootDir(ctx, file)) return 'Нельзя удалить рабочую папку целиком';
      if (!ctx.trashDir) return 'Корзина недоступна — удаление отключено';
      return null;
    },
    async run(ctx, args) {
      const file = resolveInside(ctx, args.path);
      assertNotSecret(ctx, file, 'удаление');
      if (!ctx.trashDir) return 'Ошибка: корзина недоступна — удаление отключено';
      if (isRootDir(ctx, file)) return 'Ошибка: нельзя удалить рабочую папку целиком';
      // Файл — ещё и в чекпоинт: «откат к сообщению» вернёт его (CC6.1).
      if (fs.existsSync(file) && fs.statSync(file).isFile()) ctx.beforeWrite?.(file);
      const meta = moveToTrash(file, ctx.trashDir, { projectDir: ctx.projectDir || '' });
      return `Перемещено в корзину: ${file}${meta.dir ? ` (папка, файлов: ${meta.files})` : ''}. Восстановить — /trash.`;
    },
  },
];
