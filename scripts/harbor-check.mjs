#!/usr/bin/env node
/**
 * Проверка, потянет ли машина Harbor и какие порты/инструменты доступны.
 * Ничего не устанавливает.
 *
 *   npm run harbor:check
 */

import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const MIN_RAM_GB = 4;
const MIN_DISK_GB = 40;

function command(name, args = ['--version']) {
  const result = spawnSync(name, args, { encoding: 'utf8', timeout: 15_000, windowsHide: true });
  return {
    available: !result.error && result.status === 0,
    output: `${result.stdout || ''}${result.stderr || ''}`.trim().split(/\r?\n/)[0] || '',
  };
}

function portFree(port) {
  const result = spawnSync(
    process.platform === 'win32' ? 'powershell' : 'sh',
    process.platform === 'win32'
      ? ['-NoProfile', '-Command', `(Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | Measure-Object).Count`]
      : ['-c', `(ss -ltn 2>/dev/null || netstat -ltn) | grep -c ':${port} ' || true`],
    { encoding: 'utf8', timeout: 15_000, windowsHide: true },
  );
  const count = Number(String(result.stdout || '').trim());
  return Number.isFinite(count) ? count === 0 : null;
}

function diskFreeGb() {
  try {
    const stats = fs.statfsSync(process.cwd());
    return (Number(stats.bavail) * Number(stats.bsize)) / 1024 ** 3;
  } catch {
    return null;
  }
}

const docker = command('docker');
const dockerCompose = command('docker', ['compose', 'version']);
const wsl = command('wsl', ['--status']);
const bash = command('bash', ['--version']);
const ramGb = os.totalmem() / 1024 ** 3;
const diskGb = diskFreeGb();
const ports = { 8088: portFree(8088), 8080: portFree(8080), 443: portFree(443) };

const checks = [
  { name: 'Docker', ok: docker.available, detail: docker.output || 'не найден' },
  { name: 'Docker Compose v2', ok: dockerCompose.available, detail: dockerCompose.output || 'не найден' },
  { name: `RAM ≥ ${MIN_RAM_GB} ГБ`, ok: ramGb >= MIN_RAM_GB, detail: `${ramGb.toFixed(1)} ГБ` },
  {
    name: `Свободно ≥ ${MIN_DISK_GB} ГБ`,
    ok: diskGb === null ? null : diskGb >= MIN_DISK_GB,
    detail: diskGb === null ? 'не удалось определить' : `${diskGb.toFixed(1)} ГБ`,
  },
  { name: 'Порт 8088 свободен', ok: ports[8088], detail: ports[8088] === null ? 'неизвестно' : ports[8088] ? 'свободен' : 'занят' },
  {
    name: 'Bash (install.sh)',
    ok: wsl.available || bash.available,
    detail: bash.available ? 'bash есть' : wsl.available ? 'есть WSL2' : 'нет bash/WSL — installer не запустится нативно',
  },
];

console.log('Harbor feasibility check\n');
let failed = 0;
for (const check of checks) {
  const mark = check.ok === true ? 'OK  ' : check.ok === false ? 'FAIL' : '?   ';
  if (check.ok === false) failed += 1;
  console.log(`  [${mark}] ${check.name}: ${check.detail}`);
}

console.log('\nВывод:');
if (failed === 0) {
  console.log('  Harbor можно поднять локально. Используйте WSL2/Git Bash и официальный installer.');
  console.log('  Инструкция: infra/harbor/README.md');
} else {
  console.log(`  Не хватает условий: ${failed}. Harbor поднимется после их устранения.`);
}
console.log('  Harbor — это registry (хранение образов), а не среда запуска сервисов.');
