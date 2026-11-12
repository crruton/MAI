#!/usr/bin/env node
/**
 * Отчёт по памяти Docker для MAI Code.
 *
 * Зачем: на машине одновременно живут пять стеков (приложение, Keycloak,
 * Multica, observability, k3d). Без лимитов контейнеры занимают всю RAM.
 * Скрипт показывает фактическое потребление, лимиты и контейнеры без лимита.
 *
 * Использование:
 *   npm run docker:mem              # таблица: имя, память, лимит
 *   npm run docker:mem -- --json    # машинный вывод
 *   npm run docker:mem -- --check   # код 1 при контейнере без лимита
 *                                   # или при переподписке памяти
 *
 * Флаги:
 *   --json    машинный вывод
 *   --check   код 1, если есть контейнер без лимита памяти или сумма лимитов
 *             больше памяти, доступной демону (в WSL2 — лимита виртуальной
 *             машины). Вторая проверка ловит случай «ограничили WSL2 слишком
 *             сильно, и контейнеры падают по OOM».
 *   --top N   сколько строк показать (по умолчанию 20)
 */

import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag, fallback) => {
  const index = args.indexOf(flag);
  if (index < 0) return fallback;
  const value = Number(args[index + 1]);
  return Number.isFinite(value) ? value : fallback;
};

const options = {
  json: has('--json'),
  check: has('--check'),
  top: Math.max(1, valueOf('--top', 20)),
};

function docker(argv, { timeout = 60_000 } = {}) {
  return spawnSync('docker', argv, {
    encoding: 'utf8',
    timeout,
    windowsHide: true,
  });
}

function fail(message) {
  if (options.json) console.log(JSON.stringify({ ok: false, error: message }));
  else console.error(`Ошибка: ${message}`);
  process.exitCode = 1;
}

/** Разбирает "123.4MiB / 2GiB" в мегабайты. */
function toMb(text) {
  const match = /^([\d.]+)\s*([KMG]i?B)$/i.exec(String(text || '').trim());
  if (!match) return 0;
  const value = Number(match[1]);
  const unit = match[2].toUpperCase();
  const factor = unit.startsWith('K') ? 1 / 1024 : unit.startsWith('G') ? 1024 : 1;
  return Math.round(value * factor * 10) / 10;
}

const version = docker(['--version'], { timeout: 15_000 });
if (version.error || version.status !== 0) {
  fail(version.error?.message || (version.stderr || '').trim() || 'Docker недоступен');
  process.exit();
}

// Список контейнеров берём из ps: он дешёвый и работает, даже когда stats
// падает с 500 (так бывает на машине под давлением памяти).
const ps = docker(['ps', '--format', '{{.Names}}'], { timeout: 180_000 });
if (ps.status !== 0) {
  fail(ps.error?.message || (ps.stderr || '').trim() || 'docker ps завершился с ошибкой');
  process.exit();
}
const names = String(ps.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

// stats медленный (2–10 с, на загруженной машине до 2 мин) и может упасть.
// Без него отчёт остаётся полезным: лимиты видны из inspect.
const usage = new Map();
const stats = docker(['stats', '--no-stream', '--format', '{{.Name}}\t{{.MemUsage}}\t{{.MemPerc}}'], {
  timeout: 240_000,
});
const statsError = stats.status === 0
  ? ''
  : stats.error?.message || (stats.stderr || '').trim() || 'docker stats завершился с ошибкой';
if (!statsError) {
  for (const line of String(stats.stdout || '').split(/\r?\n/).filter(Boolean)) {
    const [name, memUsage, memPerc] = line.split('\t');
    const [used] = String(memUsage || '').split('/');
    usage.set(name, {
      usedMb: toMb(used),
      percent: String(memPerc || '').trim(),
    });
  }
}

const limits = new Map();
if (names.length) {
  const inspect = docker(['inspect', ...names], { timeout: 60_000 });
  if (inspect.status === 0) {
    let data = [];
    try {
      data = JSON.parse(inspect.stdout || '[]');
    } catch {
      data = [];
    }
    for (const item of data) {
      const name = String(item.Name || '').replace(/^\//, '');
      const bytes = Number(item.HostConfig?.Memory || 0);
      limits.set(name, bytes > 0 ? Math.round(bytes / 1024 / 1024) : 0);
    }
  }
}

const containers = names
  .map((name) => {
    const item = usage.get(name) || { usedMb: 0, percent: '—' };
    const limitMb = limits.get(name) ?? 0;
    return {
      name,
      usedMb: item.usedMb,
      limitMb,
      percent: item.percent,
      unlimited: limitMb === 0,
    };
  })
  .sort((a, b) => b.usedMb - a.usedMb);

const totalUsedMb = Math.round(containers.reduce((sum, c) => sum + c.usedMb, 0) * 10) / 10;
const unlimited = containers.filter((c) => c.unlimited);
const totalLimitMb = containers.reduce((sum, c) => sum + c.limitMb, 0);

// Память, доступная демону (в WSL2 это лимит виртуальной машины).
let daemonMemoryMb = 0;
const info = docker(['info', '--format', '{{.MemTotal}}'], { timeout: 30_000 });
if (info.status === 0) {
  const bytes = Number(String(info.stdout || '').trim());
  if (Number.isFinite(bytes) && bytes > 0) daemonMemoryMb = Math.round(bytes / 1024 / 1024);
}

// Запас: сумма лимитов не должна превышать память демона. Иначе при
// одновременной нагрузке контейнеры падают по OOM, а Docker выглядит «сломанным».
const headroomMb = daemonMemoryMb ? daemonMemoryMb - totalLimitMb : 0;
const overcommitted = daemonMemoryMb > 0 && totalLimitMb > daemonMemoryMb;

const report = {
  ok: true,
  containers: containers.length,
  statsError,
  totalUsedMb,
  totalLimitMb,
  daemonMemoryMb,
  headroomMb,
  overcommitted,
  unlimited: unlimited.map((c) => c.name),
  top: containers.slice(0, options.top),
};

if (options.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`Docker: ${report.containers} запущенных контейнеров, суммарно ${totalUsedMb} МБ`);
  if (statsError) {
    console.log(`Потребление недоступно: ${statsError}`);
    console.log('  Лимиты ниже взяты из docker inspect и остаются верными.');
  }
  if (daemonMemoryMb) {
    console.log(
      `Лимиты: ${totalLimitMb} МБ из ${daemonMemoryMb} МБ доступных демону, запас ${headroomMb} МБ`,
    );
  } else {
    console.log(`Лимиты: ${totalLimitMb} МБ (память демона неизвестна)`);
  }
  console.log('');
  console.log('  ПАМЯТЬ   ЛИМИТ    %     ИМЯ');
  for (const item of report.top) {
    const limit = item.unlimited ? 'нет' : `${item.limitMb} МБ`;
    console.log(
      `  ${String(item.usedMb).padStart(6)} МБ ${limit.padStart(8)} ${String(item.percent).padStart(6)}  ${item.name}`,
    );
  }
  if (unlimited.length) {
    console.log('');
    console.log(`Без лимита памяти: ${unlimited.length}`);
    for (const item of unlimited) console.log(`  ! ${item.name} (${item.usedMb} МБ)`);
    console.log('  Добавьте mem_limit в compose-файл или --memory в docker run.');
  }
  if (overcommitted) {
    console.log('');
    console.log(`ВНИМАНИЕ: сумма лимитов ${totalLimitMb} МБ больше памяти демона ${daemonMemoryMb} МБ.`);
    console.log('  При одновременной нагрузке контейнеры упадут по OOM.');
    console.log('  Уменьшите число запущенных стеков или поднимите лимит WSL2 (.wslconfig).');
  }
}

if (options.check && (unlimited.length || overcommitted)) process.exitCode = 1;
