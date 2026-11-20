/**
 * Пакеты плагинов (бэклог CC10.1, ADR 0037).
 *
 * Пакет — папка с манифестом `mai-package.json`, которая собирает в одно целое:
 *   commands/   свои слэш-команды (*.md)
 *   agents/     типы субагентов (*.md)
 *   skills/     навыки (<имя>/SKILL.md)
 *   plugins/    плагины (*.js, исполняются в отдельном процессе, ADR 0030)
 *   hooks.json  хуки (ADR 0035)
 *   mcp.json    MCP-серверы
 *
 * Где лежат: `<данные>/packages/<имя>/` (глобальные, ставит admin) и
 * `<проект>/.mai-code/packages/<имя>/` (только для доверенной папки, ADR 0028).
 * Выключенные пакеты — `settings.packages.<имя>.enabled = false`.
 *
 * Модуль не зависит от Electron.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const MANIFEST = 'mai-package.json';
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const PARTS = ['commands', 'agents', 'skills', 'plugins'];

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function countEntries(dir, filter) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter(filter).length;
  } catch {
    return 0;
  }
}

/** Манифест и содержимое пакета. null — это не пакет. */
export function readPackage(dir, source) {
  const manifest = readJson(path.join(dir, MANIFEST));
  if (!manifest || typeof manifest !== 'object') return null;
  const name = String(manifest.name || path.basename(dir));
  if (!NAME_RE.test(name)) return null;
  const parts = {
    commands: countEntries(path.join(dir, 'commands'), (e) => e.isFile() && e.name.endsWith('.md')),
    agents: countEntries(path.join(dir, 'agents'), (e) => e.isFile() && e.name.endsWith('.md')),
    skills: countEntries(path.join(dir, 'skills'), (e) => e.isDirectory()),
    plugins: countEntries(path.join(dir, 'plugins'), (e) => e.isFile() && e.name.endsWith('.js')),
    hooks: fs.existsSync(path.join(dir, 'hooks.json')),
    mcp: Object.keys(readJson(path.join(dir, 'mcp.json'))?.mcpServers || {}).length,
  };
  return {
    name,
    version: String(manifest.version || ''),
    description: String(manifest.description || ''),
    dir,
    source,
    parts,
    executable: parts.plugins > 0 || parts.hooks || parts.mcp > 0,
  };
}

export function packageRoots(projectDir, dataDir, { includeProject = true } = {}) {
  const roots = [];
  if (includeProject && projectDir) roots.push({ source: 'project', dir: path.join(projectDir, '.mai-code', 'packages') });
  if (dataDir) roots.push({ source: 'global', dir: path.join(dataDir, 'packages') });
  return roots;
}

/**
 * Все пакеты. Пакет проекта с тем же именем сильнее глобального.
 * `settings` — `settings.packages`: { <имя>: { enabled: false } }.
 */
export function listPackages(projectDir, dataDir, { includeProject = true, settings = {} } = {}) {
  const found = new Map();
  for (const { source, dir } of packageRoots(projectDir, dataDir, { includeProject })) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const pkg = readPackage(path.join(dir, entry.name), source);
      if (!pkg || found.has(pkg.name)) continue;
      found.set(pkg.name, { ...pkg, enabled: settings?.[pkg.name]?.enabled !== false });
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Папки одного вида из включённых пакетов: [{ source: 'package:<имя>', dir }]. */
export function packageDirs(packages, kind) {
  if (!PARTS.includes(kind)) throw new Error(`Неизвестная часть пакета: ${kind}`);
  return (packages || [])
    .filter((p) => p.enabled && p.parts?.[kind])
    .map((p) => ({ source: `package:${p.name}`, dir: path.join(p.dir, kind) }));
}

/** Хуки включённых пакетов: [{ source, config }]. */
export function packageHooks(packages) {
  return (packages || [])
    .filter((p) => p.enabled && p.parts?.hooks)
    .map((p) => ({ source: `package:${p.name}`, config: readJson(path.join(p.dir, 'hooks.json')) || {} }));
}

/** MCP-серверы включённых пакетов: имя сервера → конфигурация, `cwd` по умолчанию — папка пакета. */
export function packageMcpServers(packages) {
  const servers = {};
  for (const p of packages || []) {
    if (!p.enabled || !p.parts?.mcp) continue;
    const config = readJson(path.join(p.dir, 'mcp.json'))?.mcpServers || {};
    for (const [name, server] of Object.entries(config)) {
      if (!servers[name]) servers[name] = { cwd: p.dir, ...server, package: p.name };
    }
  }
  return servers;
}

/* ---------- установка ---------- */

function copyPackage(from, to) {
  fs.cpSync(from, to, {
    recursive: true,
    filter: (src) => !/[\\/](\.git|node_modules)([\\/]|$)/.test(path.relative(from, src) ? `/${path.relative(from, src)}` : ''),
  });
}

/**
 * Ставит пакет в `<данные>/packages/<имя>`. Источник — папка или git-URL
 * (`https://…`, `git@…`, `…\.git`). Уже стоящий пакет с тем же именем
 * заменяется только при `replace: true`.
 */
export function installPackage({ from, dataDir, replace = false, git = 'git' }) {
  const source = String(from || '').trim();
  if (!source) throw new Error('Не указан источник пакета');
  const isGit = /^(https?:\/\/|git@|ssh:\/\/)/.test(source) || /\.git$/.test(source);
  let tempDir = '';
  let dir = source;
  try {
    if (isGit) {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-package-'));
      const result = spawnSync(git, ['clone', '--depth', '1', '--', source, path.join(tempDir, 'src')], {
        encoding: 'utf8',
        timeout: 120_000,
        windowsHide: true,
      });
      if (result.status !== 0) throw new Error(`git clone не удался: ${(result.stderr || result.error?.message || '').trim().slice(0, 400)}`);
      dir = path.join(tempDir, 'src');
    }
    const pkg = readPackage(dir, 'global');
    if (!pkg) throw new Error(`В ${source} нет ${MANIFEST} с полем name (буквы, цифры, . _ -)`);
    const target = path.join(dataDir, 'packages', pkg.name);
    if (fs.existsSync(target)) {
      if (!replace) throw new Error(`Пакет «${pkg.name}» уже установлен`);
      fs.rmSync(target, { recursive: true, force: true });
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    copyPackage(dir, target);
    return readPackage(target, 'global');
  } finally {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export function uninstallPackage({ name, dataDir }) {
  if (!NAME_RE.test(String(name || ''))) throw new Error('Неверное имя пакета');
  const target = path.join(dataDir, 'packages', name);
  if (!fs.existsSync(path.join(target, MANIFEST))) throw new Error(`Пакет «${name}» не установлен глобально`);
  fs.rmSync(target, { recursive: true, force: true });
  return true;
}
