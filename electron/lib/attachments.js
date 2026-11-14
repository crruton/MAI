import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { isSecretPath } from './guardrails.js';
import { ocrImage } from './ocr.js';

/**
 * Вложения сессии.
 *
 * Файл не вставляется в промпт. Он копируется в `<проект>/.mai-code/uploads/<session>/`,
 * а в контекст уходит только манифест: имя, размер, тип и путь. Агент читает файл
 * инструментами read_file / grep с offset и limit. Поэтому размер файла больше не
 * ограничен размером контекста.
 *
 * Текст из docx, xlsx, pdf и архивов извлекается в отдельный `.txt` рядом с файлом.
 * ZIP читается встроенным парсером (без внешних зависимостей). RAR, 7z, tar и gz
 * распаковываются внешним 7-Zip или tar, если они есть в системе.
 */

export const MAX_FILE_BYTES = 200 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 500 * 1024 * 1024;
export const MAX_FILES = 20;

const MAX_TEXT_BYTES = 16 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 5000;
const MAX_ARCHIVE_DEPTH = 3;

const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonc', '.json5', '.js', '.mjs', '.cjs', '.ts', '.tsx',
  '.jsx', '.css', '.scss', '.less', '.html', '.htm', '.xml', '.svg', '.yml', '.yaml', '.csv',
  '.tsv', '.log', '.ini', '.toml', '.cfg', '.conf', '.properties', '.py', '.java', '.c', '.h',
  '.cpp', '.hpp', '.cc', '.cs', '.go', '.rs', '.rb', '.php', '.sh', '.bash', '.ps1', '.bat',
  '.cmd', '.sql', '.kt', '.kts', '.swift', '.gradle', '.dockerfile', '.gitignore', '.editorconfig',
  '.env.example', '.diff', '.patch', '.mermaid', '.mmd', '.graphql', '.proto', '.tex', '.rst',
]);

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.avif']);

const ARCHIVE_EXT = new Set([
  '.zip', '.rar', '.7z', '.tar', '.gz', '.tgz', '.bz2', '.tbz2', '.xz', '.txz', '.cab', '.iso',
]);

const OFFICE_EXT = new Set(['.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp', '.epub']);

/* ---------- пути ---------- */

export function uploadsRoot(projectDir) {
  return path.join(projectDir, '.mai-code', 'uploads');
}

function sessionDir(projectDir, sessionId) {
  const safe = String(sessionId || 'draft').replace(/[^\w.-]/g, '_').slice(0, 64) || 'draft';
  const dir = path.join(uploadsRoot(projectDir), safe);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Убирает разделители пути и управляющие символы: имя приходит извне. */
function safeName(name) {
  const base = String(name || 'file')
    .split(/[\\/]/)
    .pop()
    .replace(/[\u0000-\u001f<>:"|?*]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  return (base || 'file').slice(0, 120);
}

function uniquePath(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length) || 'file';
  let candidate = path.join(dir, name);
  let index = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem}-${index}${ext}`);
    index += 1;
  }
  return candidate;
}

function relative(projectDir, target) {
  return path.relative(projectDir, target).replace(/\\/g, '/');
}

/* ---------- определение типа ---------- */

function looksBinary(buffer) {
  const limit = Math.min(buffer.length, 8000);
  for (let i = 0; i < limit; i += 1) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

export function detectKind(name, buffer) {
  const ext = path.extname(String(name || '')).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (ext === '.pdf') return 'pdf';
  if (ext === '.docx') return 'docx';
  if (ext === '.xlsx' || ext === '.ods') return 'xlsx';
  if (ext === '.pptx' || ext === '.odp') return 'pptx';
  if (ARCHIVE_EXT.has(ext)) return 'archive';
  if (TEXT_EXT.has(ext)) return 'text';
  if (buffer && !looksBinary(buffer)) return 'text';
  return 'binary';
}

/* ---------- ZIP ---------- */

function findEocd(buf) {
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

/** Читает оглавление ZIP: имя, метод сжатия, размеры, смещение. */
export function readZipIndex(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('это не ZIP-архив');
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const uncompSize = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);
    entries.push({ name, method, compSize, uncompSize, localOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Распаковывает одну запись ZIP. Поддержаны методы store (0) и deflate (8). */
export function readZipEntry(buf, entry) {
  const lo = entry.localOffset;
  if (lo + 30 > buf.length || buf.readUInt32LE(lo) !== 0x04034b50) {
    throw new Error(`битая запись ZIP: ${entry.name}`);
  }
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const start = lo + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compSize);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`метод сжатия ${entry.method} не поддерживается`);
}

function zipText(buf, entry) {
  return readZipEntry(buf, entry).toString('utf8');
}

/* ---------- DOCX / XLSX / PPTX ---------- */

function decodeXmlEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, '&');
}

function extractDocx(buf) {
  const entries = readZipIndex(buf);
  const doc = entries.find((e) => e.name === 'word/document.xml');
  if (!doc) throw new Error('в DOCX нет word/document.xml');
  const xml = zipText(buf, doc);
  const text = xml
    .replace(/<w:tab\b[^>]*\/>/g, '\t')
    .replace(/<w:br\b[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<\/w:tr>/g, '\n')
    .replace(/<\/w:tc>/g, '\t')
    .replace(/<[^>]+>/g, '');
  return decodeXmlEntities(text).replace(/\n{3,}/g, '\n\n').trim();
}

function extractXlsx(buf) {
  const entries = readZipIndex(buf);
  const shared = entries.find((e) => e.name === 'xl/sharedStrings.xml');
  const strings = [];
  if (shared) {
    const xml = zipText(buf, shared);
    for (const match of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      const parts = [...match[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]);
      strings.push(decodeXmlEntities(parts.join('')));
    }
  }
  const sheets = entries
    .filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const out = [];
  for (const sheet of sheets) {
    const xml = zipText(buf, sheet);
    out.push(`# ${path.basename(sheet.name)}`);
    for (const row of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const cell of row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        const attrs = cell[1];
        const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1] || '';
        const type = /t="([^"]+)"/.exec(attrs)?.[1] || '';
        const raw = /<v>([\s\S]*?)<\/v>/.exec(cell[2])?.[1] ?? '';
        let value = raw;
        if (type === 's') value = strings[Number(raw)] ?? '';
        else if (type === 'inlineStr') value = decodeXmlEntities(/<t[^>]*>([\s\S]*?)<\/t>/.exec(cell[2])?.[1] || '');
        else value = decodeXmlEntities(raw);
        if (value !== '') cells.push(`${ref}=${value}`);
      }
      if (cells.length) out.push(cells.join(' | '));
    }
    out.push('');
  }
  return out.join('\n').trim();
}

function extractPptx(buf) {
  const entries = readZipIndex(buf)
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const out = [];
  for (const slide of entries) {
    const xml = zipText(buf, slide);
    const texts = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXmlEntities(m[1]));
    out.push(`# ${path.basename(slide.name, '.xml')}`);
    out.push(texts.join('\n'));
    out.push('');
  }
  return out.join('\n').trim();
}

/* ---------- PDF ---------- */

/**
 * Извлекает текст из PDF без внешних зависимостей.
 *
 * Это разбор «по возможности»: находятся потоки FlateDecode, из них берутся
 * строковые литералы перед операторами Tj и TJ. Сложная вёрстка, шрифты без
 * ToUnicode и сканы без текстового слоя дадут пустой или частичный результат.
 * Такой PDF остаётся доступен как файл, но текст придётся смотреть глазами.
 */
export function extractPdf(buf) {
  const raw = buf.toString('latin1');
  const chunks = [];
  let index = 0;
  while (chunks.length < 4000) {
    const start = raw.indexOf('stream', index);
    if (start < 0) break;
    let dataStart = start + 6;
    if (raw[dataStart] === '\r') dataStart += 1;
    if (raw[dataStart] === '\n') dataStart += 1;
    const end = raw.indexOf('endstream', dataStart);
    if (end < 0) break;
    index = end + 9;
    const slice = buf.subarray(dataStart, end);
    let content = null;
    try {
      content = zlib.inflateSync(slice).toString('latin1');
    } catch {
      try {
        content = zlib.inflateRawSync(slice).toString('latin1');
      } catch {
        content = null;
      }
    }
    if (!content) continue;
    if (!/\bT[jJ]\b/.test(content)) continue;
    chunks.push(pdfContentText(content));
  }
  return chunks.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function pdfContentText(content) {
  const out = [];
  let line = '';
  let i = 0;
  const push = () => {
    if (line.trim()) out.push(line.trim());
    line = '';
  };
  while (i < content.length) {
    const ch = content[i];
    if (ch === '(') {
      let depth = 1;
      let text = '';
      i += 1;
      while (i < content.length && depth > 0) {
        const c = content[i];
        if (c === '\\') {
          const next = content[i + 1];
          const map = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
          if (next in map) {
            text += map[next];
            i += 2;
            continue;
          }
          if (/[0-7]/.test(next || '')) {
            const oct = /^[0-7]{1,3}/.exec(content.slice(i + 1))[0];
            text += String.fromCharCode(parseInt(oct, 8));
            i += 1 + oct.length;
            continue;
          }
          i += 2;
          continue;
        }
        if (c === '(') depth += 1;
        if (c === ')') {
          depth -= 1;
          if (depth === 0) {
            i += 1;
            break;
          }
        }
        text += c;
        i += 1;
      }
      line += text;
      continue;
    }
    if (ch === '<' && content[i + 1] !== '<') {
      const close = content.indexOf('>', i);
      if (close > 0) {
        const hex = content.slice(i + 1, close).replace(/[^0-9a-f]/gi, '');
        let text = '';
        for (let k = 0; k + 1 < hex.length; k += 2) {
          const code = parseInt(hex.slice(k, k + 2), 16);
          if (code >= 32 || code === 10) text += String.fromCharCode(code);
        }
        line += text;
        i = close + 1;
        continue;
      }
    }
    if (ch === 'T' && (content[i + 1] === 'd' || content[i + 1] === 'D' || content[i + 1] === '*')) {
      push();
      i += 2;
      continue;
    }
    if (ch === 'E' && content[i + 1] === 'T') {
      push();
      i += 2;
      continue;
    }
    i += 1;
  }
  push();
  return out.join('\n');
}

/* ---------- архивы ---------- */

function find7z() {
  const candidates = [
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', '7-Zip', '7z.exe'),
    '/usr/bin/7z',
    '/usr/local/bin/7z',
    '/opt/homebrew/bin/7z',
  ];
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch {
      /* нет доступа — пробуем следующий */
    }
  }
  const probe = spawnSync('7z', ['i'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  return probe.status === 0 ? '7z' : '';
}

function runTool(command, args, timeout = 120000) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    timeout,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
}

/** Распаковывает ZIP встроенным парсером. Возвращает число записанных файлов. */
function extractZipBuiltin(filePath, outDir) {
  const buf = fs.readFileSync(filePath);
  const entries = readZipIndex(buf);
  let written = 0;
  for (const entry of entries) {
    if (written >= MAX_ARCHIVE_ENTRIES) break;
    if (entry.name.endsWith('/')) continue;
    const target = path.join(outDir, entry.name);
    const rel = path.relative(outDir, target);
    // Защита от zip-slip: запись не должна выйти за папку распаковки.
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, readZipEntry(buf, entry));
    written += 1;
  }
  return written;
}

/** Распаковывает архив во вложенную папку. Возвращает список файлов. */
function extractArchive(filePath, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const ext = path.extname(filePath).toLowerCase();

  // ZIP читаем сами: это работает без внешних программ и без 7-Zip.
  if (ext === '.zip') {
    try {
      extractZipBuiltin(filePath, outDir);
      return listTree(outDir);
    } catch (err) {
      const sevenZip = find7z();
      if (!sevenZip) throw err;
      const res = runTool(sevenZip, ['x', '-y', `-o${outDir}`, filePath]);
      if (res.status !== 0) throw err;
      return listTree(outDir);
    }
  }

  const sevenZip = find7z();
  if (sevenZip) {
    const res = runTool(sevenZip, ['x', '-y', `-o${outDir}`, filePath]);
    if (res.status !== 0) {
      throw new Error(`7-Zip не распаковал архив: ${(res.stderr || res.stdout || '').trim().slice(0, 300)}`);
    }
    return listTree(outDir);
  }

  if (['.tar', '.tgz', '.gz', '.bz2', '.xz'].includes(ext)) {
    const res = runTool('tar', ['-xf', filePath, '-C', outDir]);
    if (res.status !== 0) {
      throw new Error(`tar не распаковал архив: ${(res.stderr || '').trim().slice(0, 300)}`);
    }
    return listTree(outDir);
  }

  throw new Error(
    `формат ${ext || 'без расширения'} требует 7-Zip. Установите 7-Zip или распакуйте архив вручную.`,
  );
}

function listTree(root, depth = 0, out = []) {
  if (depth > MAX_ARCHIVE_DEPTH || out.length >= MAX_ARCHIVE_ENTRIES) return out;
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(root, entry.name);
    const rel = path.relative(root, full).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      out.push(`${rel}/`);
      listTree(full, depth + 1, out);
    } else {
      let size = 0;
      try {
        size = fs.statSync(full).size;
      } catch {
        size = 0;
      }
      out.push(`${rel} (${size} Б)`);
    }
    if (out.length >= MAX_ARCHIVE_ENTRIES) break;
  }
  return out;
}

/* ---------- извлечение текста ---------- */

function writeTextFile(target, text) {
  const clipped = text.length > MAX_TEXT_BYTES ? text.slice(0, MAX_TEXT_BYTES) : text;
  fs.writeFileSync(target, clipped, 'utf8');
  return { bytes: Buffer.byteLength(clipped, 'utf8'), truncated: text.length > MAX_TEXT_BYTES };
}

/**
 * Описывает уже лежащий в папке вложений файл: тип, извлечённый текст, метаданные.
 * Ошибки извлечения не отменяют вложение: файл остаётся доступен агенту.
 */
function describe(projectDir, target) {
  const name = path.basename(target);
  const stat = fs.statSync(target);
  const buffer = fs.readFileSync(target);
  const kind = detectKind(name, buffer);

  const entry = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    size: stat.size,
    kind,
    path: relative(projectDir, target),
    textPath: '',
    meta: {},
    note: '',
  };

  try {
    if (kind === 'text') {
      const text = buffer.toString('utf8');
      if (text.includes('\u0000')) {
        entry.kind = 'binary';
        entry.note = 'файл содержит двоичные данные';
      } else {
        entry.meta.lines = text.split(/\r?\n/).length;
      }
    } else if (kind === 'docx') {
      const text = extractDocx(buffer);
      const info = writeTextFile(`${target}.txt`, text);
      entry.textPath = relative(projectDir, `${target}.txt`);
      entry.meta.chars = info.bytes;
      entry.meta.pages = Math.max(1, Math.round(text.split(/\s+/).length / 450));
      if (info.truncated) entry.note = 'текст обрезан при извлечении';
    } else if (kind === 'xlsx') {
      const text = extractXlsx(buffer);
      const info = writeTextFile(`${target}.txt`, text);
      entry.textPath = relative(projectDir, `${target}.txt`);
      entry.meta.chars = info.bytes;
      entry.meta.sheets = (text.match(/^# /gm) || []).length;
      if (info.truncated) entry.note = 'текст обрезан при извлечении';
    } else if (kind === 'pptx') {
      const text = extractPptx(buffer);
      const info = writeTextFile(`${target}.txt`, text);
      entry.textPath = relative(projectDir, `${target}.txt`);
      entry.meta.chars = info.bytes;
      entry.meta.slides = (text.match(/^# /gm) || []).length;
      if (info.truncated) entry.note = 'текст обрезан при извлечении';
    } else if (kind === 'pdf') {
      const text = extractPdf(buffer);
      if (text.trim()) {
        const info = writeTextFile(`${target}.txt`, text);
        entry.textPath = relative(projectDir, `${target}.txt`);
        entry.meta.chars = info.bytes;
        entry.meta.pages = (buffer.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length || null;
        if (info.truncated) entry.note = 'текст обрезан при извлечении';
      } else {
        entry.note = 'текстовый слой не найден: вероятно скан или защищённый PDF';
      }
    } else if (kind === 'archive') {
      const outDir = `${target}.extracted`;
      const listing = extractArchive(target, outDir);
      const indexFile = `${target}.index.txt`;
      writeTextFile(indexFile, listing.join('\n'));
      entry.textPath = relative(projectDir, indexFile);
      entry.meta.entries = listing.length;
      entry.meta.extracted = relative(projectDir, outDir);
      entry.note = 'архив распакован, в textPath — список файлов';
    } else if (kind === 'image') {
      entry.meta.image = true;
    } else {
      entry.note = 'двоичный файл: агент видит только путь и размер';
    }
  } catch (err) {
    entry.note = `не удалось извлечь текст: ${err?.message || String(err)}`;
  }

  return entry;
}

/** Копирует файл в папку вложений и описывает его. */
function ingest(projectDir, dir, sourcePath, displayName) {
  const original = path.basename(displayName || sourcePath);
  // Проверяем исходное имя: safeName срезает ведущие точки, и «.env» стал бы «env».
  if (isSecretPath(original)) {
    throw new Error(`${original}: секретные файлы прикреплять нельзя (guardrails)`);
  }
  const name = safeName(original);
  if (isSecretPath(name)) {
    throw new Error(`${original}: секретные файлы прикреплять нельзя (guardrails)`);
  }
  const stat = fs.statSync(sourcePath);
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(`${name}: файл больше ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} МБ`);
  }
  const target = uniquePath(dir, name);
  fs.copyFileSync(sourcePath, target);
  return describe(projectDir, target);
}

/** Сохраняет файлы по путям на диске. Пути приходят из drag&drop и выбора файлов. */
export function saveFromPaths({ projectDir, sessionId, paths }) {
  if (!projectDir) throw new Error('Сначала выберите папку проекта');
  const list = Array.isArray(paths) ? paths.filter(Boolean) : [];
  if (!list.length) return { entries: [], errors: [] };
  if (list.length > MAX_FILES) throw new Error(`Можно прикрепить не больше ${MAX_FILES} файлов`);

  const dir = sessionDir(projectDir, sessionId);
  const entries = [];
  const errors = [];
  let total = 0;

  for (const sourcePath of list) {
    try {
      const stat = fs.statSync(sourcePath);
      if (!stat.isFile()) {
        errors.push(`${path.basename(sourcePath)}: это не файл`);
        continue;
      }
      if (total + stat.size > MAX_TOTAL_BYTES) {
        errors.push(`${path.basename(sourcePath)}: превышен общий размер вложений`);
        continue;
      }
      const entry = ingest(projectDir, dir, sourcePath, path.basename(sourcePath));
      total += entry.size;
      entries.push(entry);
    } catch (err) {
      errors.push(err?.message || String(err));
    }
  }

  return { entries, errors };
}

/** Сохраняет изображение из буфера обмена (data URL в base64). */
export function saveImage({ projectDir, sessionId, name, dataUrl }) {
  if (!projectDir) throw new Error('Сначала выберите папку проекта');
  const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(String(dataUrl || ''));
  if (!match) throw new Error('Буфер обмена не содержит изображения');
  const mime = match[1].toLowerCase();
  const ext = mime === 'image/jpeg' ? '.jpg' : mime === 'image/svg+xml' ? '.svg' : `.${mime.split('/')[1] || 'png'}`;
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > MAX_FILE_BYTES) {
    throw new Error(`изображение больше ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} МБ`);
  }
  const dir = sessionDir(projectDir, sessionId);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const target = uniquePath(dir, safeName(name || `clipboard-${stamp}${ext}`));
  fs.writeFileSync(target, buffer);
  return describe(projectDir, target);
}

/**
 * Распознаёт текст на изображении-вложении и пишет его в `.txt` рядом с файлом.
 *
 * Отдельная асинхронная функция, а не часть `describe()`: OCR запускает внешний
 * процесс или сетевой запрос, а `saveFromPaths` остаётся синхронным и быстрым.
 * Ошибка OCR не отменяет вложение: файл остаётся доступен агенту.
 */
export async function recognizeAttachment({ projectDir, path: relativePath, language, engine, settings } = {}) {
  if (!projectDir) throw new Error('Сначала выберите папку проекта');
  if (!relativePath) throw new Error('не указан путь к вложению');
  const full = path.resolve(projectDir, relativePath);
  const rel = path.relative(projectDir, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('путь вне проекта');
  if (!fs.existsSync(full)) throw new Error(`файл не найден: ${path.basename(full)}`);

  const result = await ocrImage({ filePath: full, language, engine, settings });
  const text = String(result.text || '').trim();
  if (!text) {
    return { ok: false, error: 'текст на изображении не найден', engine: result.engine, textPath: '' };
  }

  const info = writeTextFile(`${full}.txt`, text);
  return {
    ok: true,
    engine: result.engine,
    language: result.language || '',
    textPath: relative(projectDir, `${full}.txt`),
    chars: info.bytes,
    lines: Array.isArray(result.lines) ? result.lines.length : text.split(/\r?\n/).length,
    truncated: info.truncated,
    note: result.note || '',
  };
}

/** Читает файл вложения как data URL: нужно для мультимодальных запросов. */
export function imageDataUrl(projectDir, relativePath) {
  const full = path.resolve(projectDir, relativePath);
  const rel = path.relative(projectDir, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('путь вне проекта');
  const ext = path.extname(full).toLowerCase();
  const mime =
    ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
      : ext === '.gif' ? 'image/gif'
        : ext === '.webp' ? 'image/webp'
          : ext === '.bmp' ? 'image/bmp'
            : ext === '.svg' ? 'image/svg+xml'
              : 'image/png';
  const data = fs.readFileSync(full).toString('base64');
  return `data:${mime};base64,${data}`;
}

/** Удаляет папку вложений сессии. Вызывается при удалении сессии. */
export function removeSessionUploads(projectDir, sessionId) {
  if (!projectDir) return false;
  const dir = path.join(uploadsRoot(projectDir), String(sessionId || '').replace(/[^\w.-]/g, '_'));
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Переносит вложения черновика в папку сессии.
 * Файлы прикрепляют до создания сессии, поэтому сначала они лежат в `draft`.
 * Возвращает старый и новый относительные пути, чтобы вызывающий код исправил
 * ссылки в тексте запроса.
 */
export function adoptDraftUploads(projectDir, sessionId) {
  if (!projectDir || !sessionId) return null;
  const from = path.join(uploadsRoot(projectDir), 'draft');
  if (!fs.existsSync(from)) return null;
  const to = path.join(uploadsRoot(projectDir), String(sessionId).replace(/[^\w.-]/g, '_'));
  if (path.resolve(from) === path.resolve(to)) return null;
  try {
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) {
      const source = path.join(from, name);
      let target = path.join(to, name);
      if (fs.existsSync(target)) {
        const ext = path.extname(name);
        const stem = name.slice(0, name.length - ext.length);
        let index = 1;
        while (fs.existsSync(target)) {
          target = path.join(to, `${stem}-${index}${ext}`);
          index += 1;
        }
      }
      fs.renameSync(source, target);
    }
    fs.rmSync(from, { recursive: true, force: true });
    return {
      from: relative(projectDir, from),
      to: relative(projectDir, to),
    };
  } catch {
    return null;
  }
}
