/**
 * Маркетплейс пакетов (бэклог CC10.2, ADR 0042).
 *
 * Каталог — git-репозиторий или папка с `mai-marketplace.json`:
 *
 *   { "name": "team", "description": "…",
 *     "packages": [
 *       { "name": "review-kit", "version": "1.2.0", "description": "…", "source": "packages/review-kit" },
 *       { "name": "git-kit", "version": "0.3.0", "source": "https://git.example.com/git-kit.git", "ref": "v0.3.0" }
 *     ] }
 *
 * `source` — папка внутри каталога (без выхода наружу) или git-URL; `ref` —
 * тег или ветка. Каталоги из git кешируются в `<данные>/marketplaces/<имя>/`
 * и обновляются кнопкой «Обновить каталоги». Установка — `installPackage`
 * (ADR 0037) с проверкой, что имя и версия совпадают с обещанными каталогом.
 *
 * Модуль не зависит от Electron.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { installPackage, readJson, NAME_RE } from './packages.js';

export const CATALOG = 'mai-marketplace.json';
const GIT_RE = /^(https?:\/\/|git@|ssh:\/\/)|\.git$/;

export function isGitSource(source) {
  return GIT_RE.test(String(source || '').trim());
}

/** 1.10.0 > 1.9.2; суффиксы (-beta) меньше релиза. */
export function compareVersions(a, b) {
  const parse = (v) => {
    const [core, pre = ''] = String(v || '0').replace(/^v/, '').split('-');
    return { nums: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i += 1) {
    const d = (x.nums[i] || 0) - (y.nums[i] || 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

function cacheDir(dataDir, name) {
  return path.join(dataDir, 'marketplaces', name);
}

/** Папка, где лежит каталог: локальная или кеш клона. */
export function catalogDir(market, dataDir) {
  return isGitSource(market.url) ? cacheDir(dataDir, market.name) : path.resolve(String(market.url));
}

/** Скачивает или обновляет каталог из git. Локальный каталог читается как есть. */
export function refreshMarketplace(market, dataDir, { git = 'git' } = {}) {
  if (!isGitSource(market.url)) return { ok: fs.existsSync(path.join(catalogDir(market, dataDir), CATALOG)) };
  const dir = cacheDir(dataDir, market.name);
  const temp = `${dir}.${process.pid}.tmp`;
  fs.rmSync(temp, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const result = spawnSync(git, ['clone', '--depth', '1', '--', market.url, temp], { encoding: 'utf8', timeout: 120_000, windowsHide: true });
  if (result.status !== 0) {
    fs.rmSync(temp, { recursive: true, force: true });
    throw new Error(`Каталог ${market.name}: git clone не удался: ${(result.stderr || result.error?.message || '').trim().slice(0, 300)}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(temp, dir);
  return { ok: true };
}

/** Читает каталог: имя, описание и проверенные записи пакетов. */
export function readCatalog(market, dataDir) {
  const dir = catalogDir(market, dataDir);
  const data = readJson(path.join(dir, CATALOG));
  if (!data || !Array.isArray(data.packages)) return { name: market.name, error: `нет ${CATALOG}${isGitSource(market.url) ? ' — обновите каталог' : ''}`, packages: [] };
  const packages = [];
  const seen = new Set();
  for (const raw of data.packages) {
    const name = String(raw?.name || '');
    const source = String(raw?.source || '').trim();
    if (!NAME_RE.test(name) || !source || seen.has(name)) continue;
    let resolved = source;
    if (!isGitSource(source)) {
      resolved = path.resolve(dir, source);
      const rel = path.relative(dir, resolved);
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue; // без выхода из каталога
    }
    seen.add(name);
    packages.push({
      name,
      version: String(raw.version || ''),
      description: String(raw.description || '').slice(0, 500),
      source: resolved,
      ref: raw.ref ? String(raw.ref) : '',
      remote: isGitSource(source),
    });
  }
  return { name: market.name, description: String(data.description || ''), packages };
}

/**
 * Сводка для окна: каталоги и их пакеты с установленной версией и признаком
 * обновления. `installed` — список из listPackages.
 */
export function listMarketplaces(markets, dataDir, installed = []) {
  const byName = new Map(installed.filter((p) => p.source === 'global').map((p) => [p.name, p]));
  return markets.map((market) => {
    const catalog = readCatalog(market, dataDir);
    return {
      ...market,
      description: catalog.description || '',
      error: catalog.error || '',
      packages: catalog.packages.map((entry) => {
        const current = byName.get(entry.name);
        return {
          ...entry,
          installedVersion: current ? current.version : null,
          updateAvailable: Boolean(current && entry.version && compareVersions(entry.version, current.version) > 0),
        };
      }),
    };
  });
}

/** Ставит или обновляет пакет из каталога. */
export function installFromMarketplace({ market, name, dataDir, replace = false, git = 'git' }) {
  const entry = readCatalog(market, dataDir).packages.find((p) => p.name === name);
  if (!entry) throw new Error(`В каталоге ${market.name} нет пакета «${name}»`);
  const pkg = installPackage({ from: entry.source, ref: entry.ref, dataDir, replace, git, expect: { name: entry.name, version: entry.version } });
  return { package: pkg, origin: { marketplace: market.name, version: pkg.version } };
}

/** Проверка нового каталога из настроек. */
export function normalizeMarketplace(raw) {
  const url = String(raw?.url || '').trim();
  if (!url) throw new Error('Не указан адрес каталога');
  const fallback = path.basename(url.replace(/\.git$/, '').replace(/[\\/]+$/, '')) || 'catalog';
  const name = String(raw?.name || fallback).toLowerCase().replace(/[^a-z0-9._-]/g, '-').slice(0, 64);
  if (!NAME_RE.test(name)) throw new Error(`Неверное имя каталога: ${name}`);
  return { name, url };
}
