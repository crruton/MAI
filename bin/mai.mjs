#!/usr/bin/env node
/**
 * `mai` — запуск MAI Code без окна из терминала (CC12.1, ADR 0077).
 * Передаёт флаги приложению Electron с `--cli`; вывод и код выхода — его.
 *   mai -p "задача" --output json
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let electron;
try {
  electron = require('electron');
} catch {
  console.error('mai: Electron не найден — выполните npm install в папке MAI Code или запустите установленное приложение с флагом --cli');
  process.exit(2);
}
const extra = [];
// Linux без дисплея (CI, сервер): Chromium без окна. Флаги — после пути приложения:
// перезапуск с --use-system-ca передаёт дальше всё, что после него.
if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) extra.push('--ozone-platform=headless');
if (process.env.MAI_NO_SANDBOX === '1') extra.push('--no-sandbox');
const child = spawn(electron, [root, ...extra, '--cli', ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, MAI_CLI_CWD: process.cwd() } });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
