#!/usr/bin/env node
/**
 * `mai` — запуск MAI Code без окна из терминала (CC12.1, ADR 0077).
 * Передаёт флаги приложению Electron с `--cli`; вывод и код выхода — его.
 *   mai -p "задача" --output json
 *   mai ship review --mr <ссылка на MR>   (MAI Ship без Electron, ADR 0126)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// `mai ship <роль>` (E3.A5, ADR 0126): роли MAI Ship без Electron — в CI и в образе MAI Ship.
if (process.argv[2] === 'ship') {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'mai-ship.mjs'), ...process.argv.slice(3)], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
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
const args = process.argv.slice(2);
const env = { ...process.env, MAI_CLI_CWD: process.cwd() };
// `-p -`: stdin читает лаунчер — главный процесс Electron на Windows его не получает.
let promptFile = '';
const dash = args.findIndex((a, i) => a === '-' && ['-p', '--print'].includes(args[i - 1]));
if (dash >= 0 || args.includes('--print=-')) {
  promptFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mai-cli-')), 'prompt.txt');
  fs.writeFileSync(promptFile, fs.readFileSync(0));
  env.MAI_CLI_PROMPT_FILE = promptFile;
}
const cleanup = () => {
  if (promptFile) fs.rmSync(path.dirname(promptFile), { recursive: true, force: true });
};
const child = spawn(electron, [root, ...extra, '--cli', ...args], { stdio: ['ignore', 'inherit', 'inherit'], env });
child.on('exit', (code, signal) => {
  cleanup();
  process.exit(code ?? (signal ? 1 : 0));
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
