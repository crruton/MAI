import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Офлайн-дистрибутив: исходники + node_modules + Electron.
 *
 * Пользователь распаковывает архив на машине без Node.js и сети и запускает
 * start-mai-code.cmd. Portable EXE из dist/win-unpacked — второй способ.
 *
 * Скрипт намеренно не запускает electron-builder: если сборка уже есть,
 * она попадёт в архив отдельной папкой. Это позволяет собрать офлайн-архив
 * даже там, где electron-builder недоступен.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const name = `mai-code-${pkg.version}-offline-win-x64`;
const outDir = path.join(root, 'dist', 'offline');
const stage = path.join(outDir, name);
const archive = path.join(root, 'dist', `${name}.tar.gz`);

const COPY = [
  'electron',
  'renderer',
  'assets',
  'skills',
  'docs',
  'openspec',
  'scripts',
  'package.json',
  'package-lock.json',
  'README.md',
  'CHANGELOG.md',
  'AGENTS.md',
  'SECURITY.md',
  'LICENSE',
  'electron-builder.yml',
];

function log(message) {
  console.log(`[offline] ${message}`);
}

function copy(source, target) {
  if (!fs.existsSync(source)) return false;
  fs.cpSync(source, target, { recursive: true, force: true, dereference: false });
  return true;
}

if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

log('копирую исходники');
for (const item of COPY) {
  const ok = copy(path.join(root, item), path.join(stage, item));
  if (!ok) log(`пропущено: ${item}`);
}

log('копирую node_modules (это долго)');
if (!copy(path.join(root, 'node_modules'), path.join(stage, 'node_modules'))) {
  console.error('[offline] node_modules не найден. Выполните npm.cmd install.');
  process.exit(1);
}

// Electron внутри node_modules нужен для запуска без установки.
const electronExe = path.join(stage, 'node_modules', 'electron', 'dist', 'electron.exe');
if (!fs.existsSync(electronExe)) {
  console.warn('[offline] В node_modules нет electron/dist/electron.exe.');
  console.warn('[offline] Запустите: npm.cmd install-scripts approve electron && npm.cmd rebuild electron');
}

const startCmd = `@echo off
setlocal
cd /d "%~dp0"
if not exist "node_modules\\electron\\dist\\electron.exe" (
  echo Electron не найден в node_modules.
  echo Распакуйте архив полностью или используйте dist\\win-unpacked\\MAI Code.exe.
  pause
  exit /b 1
)
set NODE_OPTIONS=%NODE_OPTIONS% --use-system-ca
"node_modules\\electron\\dist\\electron.exe" . %*
`;
fs.writeFileSync(path.join(stage, 'start-mai-code.cmd'), startCmd, 'utf8');

const offlineReadme = `MAI Code ${pkg.version} — офлайн-дистрибутив (Windows x64)

Запуск
1. Распакуйте архив целиком. Не запускайте файлы из ZIP-просмотрщика.
2. Запустите start-mai-code.cmd.
3. При первом запуске укажите ключ провайдера в панели «Провайдеры».

Что внутри
- исходники приложения (electron/, renderer/, skills/, docs/);
- node_modules вместе с Electron;
- openspec/ и AGENTS.md;
- start-mai-code.cmd.

Ограничения
- Установщик не подписан. SmartScreen покажет предупреждение.
- Автообновления нет. Новая версия — новый архив.
- Нужна Windows x64. node_modules собран под эту платформу.
- Для работы модели нужен доступ к API провайдера. Офлайн работает только
  интерфейс, документация и локальные инструменты.
- Портативная сборка без Node.js: dist/win-unpacked/MAI Code.exe.

Проверка целостности
certutil -hashfile ${name}.tar.gz SHA256
`;
fs.writeFileSync(path.join(stage, 'README-OFFLINE.txt'), offlineReadme, 'utf8');

if (fs.existsSync(archive)) fs.rmSync(archive);
log('упаковываю tar.gz');
const tar = spawnSync('tar', ['-czf', archive, '-C', outDir, name], { encoding: 'utf8' });
if (tar.error || tar.status !== 0) {
  console.error(tar.error?.message || tar.stderr || `tar завершился с кодом ${tar.status}`);
  process.exit(1);
}

const hash = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
const sums = path.join(root, 'dist', 'SHA256SUMS.txt');
const line = `${hash}  ${path.basename(archive)}\n`;
fs.appendFileSync(sums, line, 'utf8');

const size = (fs.statSync(archive).size / 1024 / 1024).toFixed(1);
log(`готово: ${archive} (${size} МБ)`);
log(`sha256: ${hash}`);
log(`контрольные суммы: ${sums}`);
