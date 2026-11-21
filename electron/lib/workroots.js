/**
 * Рабочие папки чата (бэклог CW1.2, ADR 0045).
 *
 * Основная — папка проекта. Дополнительные пользователь добавляет к чату сам;
 * агент обращается к ним как `@<имя>/путь`. Вне этих папок файловые
 * инструменты и рабочая папка команд не работают (если не включён доступ вне
 * проекта). Правила разрешений для дополнительных папок пишутся так же:
 * `write_file(@docs/**)`.
 *
 * Модуль не зависит от Electron.
 */
import path from 'node:path';

const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u;

function slug(dir) {
  const base = path.basename(path.resolve(dir)).replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^[-._]+/, '') || 'folder';
  return base.slice(0, 64);
}

/** [{ name, dir, primary }]: основная — первой, имена уникальны, дубли и вложенные в основную отброшены. */
export function normalizeRoots(projectDir, extraDirs = []) {
  const roots = [];
  if (projectDir) roots.push({ name: slug(projectDir), dir: path.resolve(projectDir), primary: true });
  const taken = new Set(roots.map((r) => r.name.toLowerCase()));
  for (const raw of extraDirs || []) {
    const dir = path.resolve(String(raw?.dir || raw || ''));
    if (!raw || roots.some((r) => r.dir === dir)) continue;
    let name = String(raw?.name || slug(dir));
    if (!NAME_RE.test(name)) name = slug(dir);
    let unique = name;
    for (let i = 2; taken.has(unique.toLowerCase()); i += 1) unique = `${name}-${i}`;
    taken.add(unique.toLowerCase());
    roots.push({ name: unique, dir, primary: false });
  }
  return roots;
}

function inside(dir, target) {
  const rel = path.relative(dir, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Папка, в которой лежит путь (самая глубокая), или null. */
export function rootOf(roots, full) {
  return [...roots].sort((a, b) => b.dir.length - a.dir.length).find((r) => inside(r.dir, full)) || null;
}

/**
 * Полный путь. `@имя/путь` — в дополнительной папке; относительный — от основной;
 * абсолютный — только внутри одной из папок. Вне папок — ошибка, кроме `allowOutside`.
 */
export function resolveIn(roots, target, { allowOutside = false, base = process.cwd() } = {}) {
  const text = String(target ?? '.') || '.';
  const at = /^@([^/\\]+)(?:[/\\](.*))?$/su.exec(text);
  if (at) {
    const root = roots.find((r) => r.name.toLowerCase() === at[1].toLowerCase());
    if (!root) throw new Error(`Нет рабочей папки @${at[1]}. Доступны: ${roots.map((r) => (r.primary ? r.dir : `@${r.name}`)).join(', ')}`);
    const full = path.resolve(root.dir, at[2] || '.');
    if (!inside(root.dir, full)) throw new Error(`Путь выходит из папки @${root.name}: ${full}`);
    return full;
  }
  const primary = roots.find((r) => r.primary);
  const full = path.resolve(primary?.dir || base, text);
  if (!allowOutside && !rootOf(roots, full)) {
    const where = roots.length > 1 ? 'рабочих папок чата' : 'проекта';
    throw new Error(`Путь вне ${where} запрещён: ${full}. Добавьте папку к чату или включите «Разрешить файлы вне проекта».`);
  }
  return full;
}

/** Предмет для правил: путь от основной папки или `@имя/путь` для дополнительной. */
export function subjectIn(roots, full) {
  const root = rootOf(roots, path.resolve(full));
  if (!root) {
    const primary = roots.find((r) => r.primary);
    const rel = primary ? path.relative(primary.dir, path.resolve(full)) : path.resolve(full);
    return rel.split(path.sep).join('/');
  }
  const rel = path.relative(root.dir, path.resolve(full)).split(path.sep).join('/') || '.';
  return root.primary ? rel : `@${root.name}${rel === '.' ? '' : `/${rel}`}`;
}

/** Строки для системного промпта. */
export function describeRoots(roots) {
  const extra = roots.filter((r) => !r.primary);
  if (!extra.length) return '';
  return [
    '\n# Рабочие папки',
    'Кроме папки проекта, пользователь дал доступ к папкам ниже. Обращайся к ним по имени: `@имя/путь`.',
    ...extra.map((r) => `- @${r.name} → ${r.dir}`),
    'Вне этих папок файлы недоступны.',
  ].join('\n');
}
