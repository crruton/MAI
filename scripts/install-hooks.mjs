/**
 * Установка git-хуков проекта: копирует scripts/hooks/* в .git/hooks.
 *
 * Копированием, а не core.hooksPath: в .git/hooks уже лежит post-commit от
 * repowise, и смена hooksPath отключила бы его.
 *
 * Запуск: npm run hooks:install
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const gitDir = execFileSync('git', ['rev-parse', '--git-dir'], { encoding: 'utf8' }).trim();
const srcDir = 'scripts/hooks';
const dstDir = path.join(gitDir, 'hooks');

const names = fs.readdirSync(srcDir).filter((n) => !n.endsWith('.md'));
for (const name of names) {
  const src = path.join(srcDir, name);
  const dst = path.join(dstDir, name);
  const content = fs.readFileSync(src, 'utf8').replace(/\r\n/g, '\n');
  if (fs.existsSync(dst) && fs.readFileSync(dst, 'utf8').replace(/\r\n/g, '\n') === content) {
    console.log(`без изменений: ${name}`);
    continue;
  }
  fs.writeFileSync(dst, content, { mode: 0o755 });
  console.log(`установлен: ${name}`);
}
console.log(`Хуки в ${dstDir}`);
