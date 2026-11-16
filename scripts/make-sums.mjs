import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Пересчитывает SHA-256 для всех артефактов в dist/ и пишет SHA256SUMS.txt.
 *
 * Причина: `make-offline.mjs` дописывал только строку архива. Хеши EXE,
 * собранных electron-builder, оставались от прошлой сборки и не совпадали
 * с файлами. Проверка целостности на чистой машине давала ложный провал.
 *
 * Формат строки — как у `sha256sum`: `<хеш>  <имя файла>`.
 */

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');

/** Артефакты, для которых пишем суммы. Порядок важен для читаемости файла. */
const PATTERNS = [
  /^MAI Code-.*\.exe$/,
  /^mai-code-.*\.tar\.gz$/,
  /^latest\.yml$/,
];

function sha256(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let read = 0;
    do {
      read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read > 0) hash.update(buffer.subarray(0, read));
    } while (read > 0);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

if (!fs.existsSync(dist)) {
  console.error(`[sums] Папка dist не найдена: ${dist}`);
  process.exit(1);
}

const files = fs
  .readdirSync(dist, { withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name)
  .filter((name) => PATTERNS.some((re) => re.test(name)))
  .sort((a, b) => a.localeCompare(b));

if (!files.length) {
  console.error('[sums] В dist нет артефактов для подсчёта.');
  process.exit(1);
}

const rows = [];
for (const name of files) {
  const file = path.join(dist, name);
  const size = fs.statSync(file).size;
  const hash = sha256(file);
  rows.push(`${hash}  ${name}`);
  console.log(`[sums] ${name} (${(size / 1024 / 1024).toFixed(1)} МБ) ${hash}`);
}

const target = path.join(dist, 'SHA256SUMS.txt');
fs.writeFileSync(target, `${rows.join('\n')}\n`, 'utf8');
console.log(`[sums] записано ${rows.length} строк: ${target}`);
