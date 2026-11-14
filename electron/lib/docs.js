import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

/**
 * Встроенная документация в стиле GitBook.
 *
 * Читает markdown-файлы из docs/ приложения и README.md. Наружу отдаёт
 * только относительные пути: попытка выйти за пределы docs/ отклоняется.
 */

const TITLE_OVERRIDES = {
  'README.md': 'MAI Code — обзор',
  'docs/README.md': 'Документация',
  'docs/ARCHITECTURE.md': 'Архитектура',
  'docs/BACKLOG.md': 'Бэклог',
  'docs/BOARDS.md': 'Доски',
  'docs/DEPLOYMENT.md': 'Развёртывание',
  'docs/DNS.md': 'DNS и домены',
  'docs/DOMAIN.md': 'Доменное имя',
  'docs/KUBERNETES.md': 'Kubernetes',
  'docs/MULTICA.md': 'Multica',
  'docs/OCR.md': 'OCR — распознавание текста',
  'docs/OPENSCION.md': 'OpenScion',
  'docs/OPENSPEC.md': 'OpenSpec',
  'docs/PRESETS.md': 'Пресеты моделей',
  'docs/PROVIDERS.md': 'Провайдеры',
  'docs/REPOWISE.md': 'Repowise',
  'docs/ROADMAP.md': 'План развития',
  'docs/SANDBOXES.md': 'Песочницы',
  'docs/STORAGE.md': 'Хранилище',
  'docs/adr/README.md': 'ADR — решения',
};

function appRoot() {
  // В упакованном приложении app.getAppPath() указывает на app.asar,
  // и fs умеет читать файлы внутри архива.
  return app.getAppPath();
}

export function docsRoot() {
  return path.join(appRoot(), 'docs');
}

function safeRelative(value) {
  const raw = String(value || '').replace(/\\/g, '/');
  if (!raw || raw.includes('\0')) throw new Error('Пустой путь к документу');
  const normalized = path.posix.normalize(raw).replace(/^\.\//, '');
  if (normalized.startsWith('..') || path.posix.isAbsolute(normalized)) {
    throw new Error('Документ вне папки docs');
  }
  return normalized;
}

function resolveDoc(relative) {
  const root = appRoot();
  const clean = safeRelative(relative);
  const allowed = clean === 'README.md' || clean === 'SECURITY.md' || clean.startsWith('docs/');
  if (!allowed) throw new Error('Документ вне папки docs');
  const file = path.join(root, clean);
  const resolvedRoot = path.resolve(root);
  if (!path.resolve(file).startsWith(resolvedRoot + path.sep)) {
    throw new Error('Документ вне папки docs');
  }
  return { file, relative: clean };
}

function titleOf(relative, content) {
  if (TITLE_OVERRIDES[relative]) return TITLE_OVERRIDES[relative];
  const heading = /^#\s+(.+)$/m.exec(content || '');
  if (heading) return heading[1].replace(/[`*_]/g, '').trim();
  return path.posix.basename(relative, '.md');
}

function sectionOf(relative) {
  const parts = relative.split('/');
  if (parts[0] === 'docs' && parts.length > 2) return parts[1];
  return parts[0] === 'docs' ? 'Основное' : 'Корень';
}

function walk(dir, base, out, depth = 0) {
  if (depth > 4 || !fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      walk(full, base, out, depth + 1);
      continue;
    }
    if (!entry.name.endsWith('.md')) continue;
    const relative = path.relative(base, full).replace(/\\/g, '/');
    let content = '';
    try {
      content = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    out.push({
      path: relative,
      title: titleOf(relative, content),
      section: sectionOf(relative),
      bytes: Buffer.byteLength(content, 'utf8'),
    });
  }
}

export function listDocs() {
  const root = appRoot();
  const files = [];
  const readme = path.join(root, 'README.md');
  if (fs.existsSync(readme)) {
    const content = fs.readFileSync(readme, 'utf8');
    files.push({
      path: 'README.md',
      title: titleOf('README.md', content),
      section: 'Корень',
      bytes: Buffer.byteLength(content, 'utf8'),
    });
  }
  walk(path.join(root, 'docs'), root, files);
  const order = { 'README.md': 0, 'docs/README.md': 1 };
  files.sort((a, b) => {
    const ao = order[a.path] ?? 10;
    const bo = order[b.path] ?? 10;
    if (ao !== bo) return ao - bo;
    return a.path.localeCompare(b.path, 'ru');
  });
  const sections = [...new Set(files.map((f) => f.section))];
  return { root: path.join(root, 'docs'), files, sections };
}

export function readDoc(relative) {
  const { file, relative: clean } = resolveDoc(relative);
  if (!fs.existsSync(file)) throw new Error(`Документ не найден: ${clean}`);
  const content = fs.readFileSync(file, 'utf8');
  return {
    path: clean,
    title: titleOf(clean, content),
    content,
    updatedAt: fs.statSync(file).mtime.toISOString(),
  };
}

/** Поиск по заголовкам и тексту. Возвращает сниппеты с номером строки. */
export function searchDocs(query, limit = 40) {
  const needle = String(query || '').trim().toLowerCase();
  if (needle.length < 2) return [];
  const results = [];
  for (const doc of listDocs().files) {
    let content = '';
    try {
      content = readDoc(doc.path).content;
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (!lines[i].toLowerCase().includes(needle)) continue;
      results.push({
        path: doc.path,
        title: doc.title,
        line: i + 1,
        snippet: lines[i].trim().slice(0, 220),
      });
      if (results.length >= limit) return results;
    }
  }
  return results;
}
