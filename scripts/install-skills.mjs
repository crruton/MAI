import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'skills');
const appData = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'mai-code')
  : path.join(os.homedir(), '.config', 'mai-code');
const target = path.join(appData, 'skills');

if (!fs.existsSync(source)) {
  console.error(`Нет папки навыков: ${source}`);
  process.exit(1);
}

fs.mkdirSync(target, { recursive: true });
let installed = 0;
for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const from = path.join(source, entry.name);
  const to = path.join(target, entry.name);
  fs.cpSync(from, to, { recursive: true, force: true });
  installed += 1;
  console.log(`навык: ${entry.name} -> ${to}`);
}

console.log(`Установлено навыков: ${installed}. Папка: ${target}`);
