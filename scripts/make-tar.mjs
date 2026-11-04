import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Собирает tar.gz с исходниками для установки без сборки.
 * Использует системный tar (есть в Windows 10+, Linux и macOS).
 * node_modules, dist и локальные данные в архив не попадают.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const name = `mai-code-${pkg.version}`;
const out = path.join(root, 'dist', `${name}.tar.gz`);

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
if (fs.existsSync(out)) fs.rmSync(out);

const excludes = [
  'node_modules',
  'dist',
  '.git',
  '.github',
  '.claude',
  '.repowise',
  '.mai-code',
  'out',
  '*.log',
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '*.key',
  '*.pem',
  'settings.json',
  'sessions.json',
  'mai-api-key.txt',
];

const args = ['-czf', out, ...excludes.map((item) => `--exclude=${item}`), '.'];
const result = spawnSync('tar', args, { cwd: root, encoding: 'utf8' });

if (result.error) {
  console.error(`tar недоступен: ${result.error.message}`);
  console.error('Установите tar или соберите архив вручную: tar -czf dist/mai-code.tar.gz .');
  process.exit(1);
}
if (result.status !== 0) {
  console.error(result.stderr || `tar завершился с кодом ${result.status}`);
  process.exit(result.status || 1);
}

const size = (fs.statSync(out).size / 1024 / 1024).toFixed(2);
console.log(`Архив: ${out} (${size} МБ)`);
