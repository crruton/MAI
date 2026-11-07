#!/usr/bin/env node
/**
 * Docker image/container GC для MAI Code.
 *
 * Зачем: повторные сборки и песочницы оставляют старые теги, dangling-образы
 * и остановленные контейнеры. Скрипт удаляет лишнее, сохраняя N последних
 * тегов на каждый репозиторий.
 *
 * Использование:
 *   npm run docker:gc:dry            # показать, что будет удалено
 *   npm run docker:gc                # удалить (keep=2)
 *   node scripts/docker-gc.mjs --keep 3 --all
 *
 * Флаги:
 *   --dry-run        ничего не удалять
 *   --keep N         сколько последних тегов оставлять (по умолчанию 2)
 *   --all            все локальные образы, а не только mai-code*
 *   --dangling       удалить <none>:<none> (по умолчанию да)
 *   --no-dangling    не трогать dangling-образы
 *   --build-cache    очистить build cache старше 72 часов
 *   --containers     удалить остановленные контейнеры песочниц
 *   --json           машинный вывод
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
  dryRun: has('--dry-run'),
  keep: Math.max(0, valueOf('--keep', 2)),
  all: has('--all'),
  dangling: !has('--no-dangling'),
  buildCache: has('--build-cache'),
  containers: !has('--no-containers'),
  json: has('--json'),
};

const PREFIXES = ['mai-code', 'mai_code', 'mai/code'];

function docker(argv, { input } = {}) {
  return spawnSync('docker', argv, {
    encoding: 'utf8',
    timeout: 120_000,
    input,
    windowsHide: true,
  });
}

function fail(message) {
  if (options.json) console.log(JSON.stringify({ ok: false, error: message }));
  else console.error(`Ошибка: ${message}`);
  process.exitCode = 1;
}

const version = docker(['--version']);
if (version.error || version.status !== 0) {
  fail(version.error?.message || (version.stderr || '').trim() || 'Docker недоступен');
  process.exit();
}

function listImages() {
  const result = docker(['images', '--format', '{{.Repository}}\t{{.Tag}}\t{{.ID}}\t{{.CreatedAt}}']);
  if (result.status !== 0) throw new Error((result.stderr || '').trim() || 'docker images failed');
  return String(result.stdout || '')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [repository, tag, id, createdAt] = line.split('\t');
      return { repository, tag, id, createdAt };
    });
}

function isMaiCode(repository) {
  if (options.all) return true;
  const name = String(repository || '').toLowerCase();
  return PREFIXES.some((prefix) => name.startsWith(prefix));
}

function removeImage(ref) {
  if (options.dryRun) return { ok: true, dryRun: true };
  const result = docker(['rmi', ref]);
  if (result.status === 0) return { ok: true };
  // Образ используется контейнером — не ломаем работу, просто сообщаем.
  return { ok: false, error: (result.stderr || result.stdout || '').trim() };
}

function groupImages(images) {
  const groups = new Map();
  for (const image of images) {
    if (!image.repository || image.repository === '<none>') continue;
    if (!isMaiCode(image.repository)) continue;
    if (!groups.has(image.repository)) groups.set(image.repository, []);
    groups.get(image.repository).push(image);
  }
  return groups;
}

function cleanupImages() {
  const images = listImages();
  const groups = groupImages(images);
  const removed = [];
  const kept = [];
  const skipped = [];

  for (const [repository, tags] of groups) {
    tags.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    tags.forEach((image, index) => {
      if (index < options.keep) {
        kept.push(`${repository}:${image.tag}`);
        return;
      }
      const ref = `${repository}:${image.tag}`;
      const result = removeImage(ref);
      if (result.ok) removed.push(ref);
      else skipped.push({ ref, reason: result.error });
    });
  }

  return { removed, kept, skipped };
}

function cleanupDangling() {
  if (!options.dangling) return [];
  const result = docker(['images', '--filter', 'dangling=true', '--format', '{{.ID}}']);
  if (result.status !== 0) return [];
  const ids = String(result.stdout || '').split(/\s+/).filter(Boolean);
  const removed = [];
  for (const id of ids) {
    if (options.dryRun) {
      removed.push(id);
      continue;
    }
    const rm = docker(['rmi', id]);
    if (rm.status === 0) removed.push(id);
  }
  return removed;
}

function cleanupContainers() {
  const result = docker(['ps', '-aq', '--filter', 'label=mai-code.sandbox=1', '--filter', 'status=exited']);
  if (result.status !== 0) return [];
  const ids = String(result.stdout || '').split(/\s+/).filter(Boolean);
  if (!ids.length) return [];
  if (!options.dryRun) docker(['rm', ...ids]);
  return ids;
}

function cleanupBuildCache() {
  if (!options.buildCache) return false;
  const result = docker(['builder', 'prune', '-f', '--filter', 'until=72h']);
  return result.status === 0;
}

let report;
try {
  report = {
    ok: true,
    dryRun: options.dryRun,
    keep: options.keep,
    images: cleanupImages(),
    dangling: cleanupDangling(),
    containers: cleanupContainers(),
    buildCache: cleanupBuildCache(),
  };
} catch (err) {
  fail(err.message);
  process.exit();
}

if (options.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const mode = report.dryRun ? 'DRY-RUN (ничего не удалено)' : 'удалено';
  console.log(`Docker GC: ${mode}`);
  console.log(`  образов удалено: ${report.images.removed.length}`);
  for (const ref of report.images.removed) console.log(`    - ${ref}`);
  if (report.images.skipped.length) {
    console.log(`  пропущено (используются): ${report.images.skipped.length}`);
    for (const item of report.images.skipped) console.log(`    ! ${item.ref}: ${item.reason}`);
  }
  console.log(`  оставлено последних тегов: ${report.images.kept.length} (keep=${report.keep})`);
  console.log(`  dangling: ${report.dangling.length}`);
  console.log(`  остановленных песочниц: ${report.containers.length}`);
  if (options.buildCache) console.log(`  build cache очищен: ${report.buildCache ? 'да' : 'нет'}`);
  if (report.dryRun) console.log('  Повторите без --dry-run, чтобы применить.');
}
