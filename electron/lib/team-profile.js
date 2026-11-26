/**
 * Профиль команды (E2.2, ADR 0118).
 *
 * Профиль — git-репозиторий или папка с `mai-team.json`:
 *
 *   {
 *     "name": "team",
 *     "marketplaces": [{ "name": "mai-team", "url": "https://github.com/org/catalog.git" }],
 *     "mcpServers": { "docs": { "type": "http", "url": "https://mcp.example.com/mcp" } },
 *     "agents": "AGENTS.md",
 *     "multica": { "workspaceId": "…" }
 *   }
 *
 * Адрес профиля задаёт организация (`managed-settings.json` → `teamProfile`) или admin в
 * настройках. Профиль — нижний слой: личные настройки и настройки проекта сильнее. Секретов
 * в профиле нет: значения с токенами и ключами отклоняются, заголовки — только `${ПЕРЕМЕННАЯ}`.
 * Без Electron.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { scanText } from './catalog-check.js';
import { removeTree } from './remove-tree.js';

export const PROFILE_FILE = 'mai-team.json';
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const GIT_RE = /^(https:\/\/|ssh:\/\/|git@)[^\s]+$/;
const MAX_AGENTS = 64 * 1024;

export function profileCacheDir(dataDir) {
  return path.join(dataDir, 'team-profile');
}

/** Откуда профиль: настройки организации сильнее настроек пользователя. */
export function profileSource({ managed = {}, settings = {} } = {}) {
  const raw = managed.teamProfile || settings.teamProfile || null;
  if (!raw) return null;
  const url = String(typeof raw === 'string' ? raw : raw.url || '').trim();
  if (!url) return null;
  const ref = String(raw.ref || '').trim();
  if (ref && !/^[A-Za-z0-9._/-]{1,100}$/.test(ref)) throw new Error(`teamProfile.ref: недопустимое значение «${ref}»`);
  return { url, ref, git: GIT_RE.test(url), from: managed.teamProfile ? 'managed' : 'settings' };
}

/** Папка, из которой читается профиль: кэш git-клона или локальная папка. */
export function profileDir(source, dataDir) {
  if (!source) return '';
  return source.git ? profileCacheDir(dataDir) : path.resolve(source.url);
}

/** Скачивает профиль из git во временную папку и заменяет кэш только при успехе. */
export function refreshProfile(source, dataDir, { git = 'git' } = {}) {
  if (!source) return { ok: false, error: 'Профиль команды не настроен' };
  if (!source.git) return { ok: fs.existsSync(path.join(profileDir(source, dataDir), PROFILE_FILE)) };
  const dir = profileCacheDir(dataDir);
  const temp = `${dir}.${process.pid}.tmp`;
  removeTree(temp);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const args = ['clone', '--depth', '1', ...(source.ref ? ['--branch', source.ref] : []), '--', source.url, temp];
  const r = spawnSync(git, args, { encoding: 'utf8', timeout: 120_000, windowsHide: true });
  if (r.status !== 0) {
    removeTree(temp);
    return { ok: false, error: `git clone профиля не удался: ${(r.stderr || r.error?.message || '').trim().slice(0, 300)}` };
  }
  removeTree(dir);
  fs.renameSync(temp, dir);
  return { ok: true };
}

function isPlaceholder(value) {
  return /^\$\{[A-Z_][A-Z0-9_]*\}$/.test(String(value));
}

/** Ошибки профиля. Пустой список — профиль можно применять. */
export function validateProfile(data) {
  const errors = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [`${PROFILE_FILE}: не объект`];
  if (!NAME_RE.test(String(data.name || ''))) errors.push('name: латиница, цифры, . _ -');
  if (data.marketplaces !== undefined) {
    if (!Array.isArray(data.marketplaces)) errors.push('marketplaces — список');
    else for (const [i, m] of data.marketplaces.entries()) {
      if (!NAME_RE.test(String(m?.name || ''))) errors.push(`marketplaces[${i}].name`);
      if (!GIT_RE.test(String(m?.url || ''))) errors.push(`marketplaces[${i}].url: git-адрес https, ssh или git@`);
    }
  }
  if (data.mcpServers !== undefined) {
    if (!data.mcpServers || typeof data.mcpServers !== 'object' || Array.isArray(data.mcpServers)) errors.push('mcpServers — объект');
    else for (const [name, server] of Object.entries(data.mcpServers)) {
      if (!NAME_RE.test(name)) errors.push(`mcpServers: имя «${name}»`);
      if (!server || typeof server !== 'object' || !(server.command || server.url)) errors.push(`mcpServers.${name}: нужен command или url`);
      for (const [key, value] of Object.entries({ ...(server?.env || {}), ...(server?.headers || {}) })) {
        if (!isPlaceholder(value)) errors.push(`mcpServers.${name}: ${key} — только \${ПЕРЕМЕННАЯ}, секретов в профиле нет`);
      }
    }
  }
  if (data.agents !== undefined) {
    const agents = String(data.agents);
    if (!/^[A-Za-z0-9._/-]+\.md$/.test(agents) || agents.startsWith('/') || agents.split('/').includes('..')) errors.push('agents: путь к .md внутри профиля');
  }
  if (data.multica !== undefined) {
    const m = data.multica;
    if (!m || typeof m !== 'object') errors.push('multica — объект');
    else {
      for (const key of Object.keys(m)) if (key !== 'workspaceId') errors.push(`multica.${key}: в профиле только workspaceId`);
      if (m.workspaceId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(String(m.workspaceId))) errors.push('multica.workspaceId: id или slug');
    }
  }
  const secrets = scanText(JSON.stringify(data), {}).filter((p) => !p.startsWith('email'));
  for (const s of secrets) errors.push(`похоже на секрет: ${s}`);
  return errors;
}

/**
 * Профиль из папки: данные, текст AGENTS.md команды и ошибки. Битый профиль не применяется
 * целиком — ни одна его часть.
 */
export function readProfile(dir) {
  const empty = { ok: false, name: '', marketplaces: [], mcpServers: {}, agents: '', multica: {}, errors: [] };
  if (!dir) return { ...empty, errors: ['профиль не настроен'] };
  let data;
  try {
    data = JSON.parse(fs.readFileSync(path.join(dir, PROFILE_FILE), 'utf8'));
  } catch (err) {
    return { ...empty, errors: [`${PROFILE_FILE}: ${err.code === 'ENOENT' ? 'нет файла' : 'не JSON'}`] };
  }
  const errors = validateProfile(data);
  let agents = '';
  if (!errors.length && data.agents) {
    const file = path.resolve(dir, data.agents);
    const rel = path.relative(dir, file);
    if (rel.startsWith('..') || path.isAbsolute(rel)) errors.push('agents: путь вне профиля');
    else {
      try {
        agents = fs.readFileSync(file, 'utf8').slice(0, MAX_AGENTS);
        const leak = scanText(agents, {}).filter((p) => !p.startsWith('email'));
        if (leak.length) errors.push(`${data.agents}: похоже на секрет (${leak.join(', ')})`);
      } catch {
        errors.push(`${data.agents}: нет файла`);
      }
    }
  }
  if (errors.length) return { ...empty, name: String(data.name || ''), errors };
  return {
    ok: true,
    name: data.name,
    marketplaces: data.marketplaces || [],
    mcpServers: data.mcpServers || {},
    agents,
    multica: data.multica || {},
    errors: [],
  };
}

/** Каталоги: личные сильнее профиля, совпадение по имени — личный. */
export function mergeMarketplaces(own = [], team = []) {
  const names = new Set(own.map((m) => m.name));
  return [...own, ...team.filter((m) => !names.has(m.name)).map((m) => ({ ...m, source: 'team' }))];
}
