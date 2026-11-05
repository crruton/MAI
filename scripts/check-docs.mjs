import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Проверка документации:
 * - внутренние ссылки ведут на существующие файлы;
 * - каждая страница docs/ (кроме служебных) упомянута в docs/SUMMARY.md;
 * - нет пустых markdown-файлов.
 *
 * Код в блоках ``` игнорируется, чтобы примеры не давали ложных срабатываний.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docsDir = path.join(root, 'docs');
const problems = [];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

function stripCode(text) {
  return text.replace(/```[\s\S]*?```/g, '');
}

const files = [path.join(root, 'README.md'), path.join(root, 'CHANGELOG.md'), ...walk(docsDir)];

for (const file of files) {
  if (!fs.existsSync(file)) continue;
  const relative = path.relative(root, file).replace(/\\/g, '/');
  const content = fs.readFileSync(file, 'utf8');
  if (!content.trim()) problems.push(`${relative}: пустой файл`);

  const text = stripCode(content);
  const linkRe = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let match;
  while ((match = linkRe.exec(text))) {
    const target = match[1];
    if (/^(https?:|mailto:|tel:|data:)/i.test(target)) continue;
    if (target.startsWith('#')) continue;
    const clean = target.split('#')[0].split('?')[0];
    if (!clean) continue;
    const resolved = path.resolve(path.dirname(file), decodeURIComponent(clean));
    if (!fs.existsSync(resolved)) {
      problems.push(`${relative}: битая ссылка → ${target}`);
    }
  }
}

// SUMMARY.md должен перечислять все страницы docs, кроме самого SUMMARY,
// README (оглавление) и ADR (у них свой реестр).
const summaryFile = path.join(docsDir, 'SUMMARY.md');
if (fs.existsSync(summaryFile)) {
  const summary = fs.readFileSync(summaryFile, 'utf8');
  for (const file of walk(docsDir)) {
    const relative = path.relative(docsDir, file).replace(/\\/g, '/');
    if (['SUMMARY.md', 'README.md'].includes(relative)) continue;
    if (relative.startsWith('adr/')) continue;
    if (!summary.includes(relative) && !summary.includes(path.basename(relative))) {
      problems.push(`docs/SUMMARY.md: нет страницы ${relative}`);
    }
  }
}

if (problems.length) {
  console.error(`Проверка документации: ${problems.length} проблем`);
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}

console.log(`Проверка документации: OK (${files.length} файлов)`);
