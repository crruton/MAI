/**
 * Доверие к папке проекта (ADR 0028).
 *
 * Пока папке не доверяют, из неё не загружается ничего, что исполняется или
 * влияет на агента: плагины `.mai-code/plugins`, MCP-серверы `.mai-code/mcp.json`,
 * `AGENTS.md`, `memory.md` и навыки проекта. Решение хранится в `trust.json`
 * в папке данных приложения и наследуется вложенными папками.
 *
 * Состояния:
 * - `trusted`    — папка доверена, всё загружается;
 * - `restricted` — работать можно, но без кода и инструкций проекта;
 * - `unknown`    — решения нет, перед первым запуском спрашиваем.
 *
 * Модуль не зависит от Electron: папку данных передают явно.
 */
import fs from 'node:fs';
import path from 'node:path';

export const TRUST_STATES = ['trusted', 'restricted'];

function trustFile(dataDir) {
  return path.join(dataDir, 'trust.json');
}

/** Ключ папки: абсолютный путь без хвостового разделителя; на Windows — без учёта регистра. */
export function folderKey(dir) {
  if (!dir) return '';
  let full = path.resolve(String(dir));
  if (full.length > 1 && (full.endsWith(path.sep) || full.endsWith('/'))) full = full.slice(0, -1);
  return process.platform === 'win32' ? full.toLowerCase() : full;
}

export function readTrust(dataDir) {
  try {
    const data = JSON.parse(fs.readFileSync(trustFile(dataDir), 'utf8'));
    return { folders: data && typeof data.folders === 'object' ? data.folders : {} };
  } catch {
    return { folders: {} };
  }
}

function writeTrust(dataDir, data) {
  const file = trustFile(dataDir);
  const temp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(temp, file);
}

function isInside(child, parent) {
  if (!parent) return false;
  if (child === parent) return true;
  const rel = path.relative(parent, child);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Состояние доверия папки. Ищется ближайшее решение вверх по дереву: доверие к
 * `C:\work` распространяется на `C:\work\repo`. Папки из `autoTrusted`
 * (например, песочницы, созданные самим приложением) доверены всегда.
 */
export function trustState(dataDir, projectDir, { autoTrusted = [] } = {}) {
  const key = folderKey(projectDir);
  if (!key) return { state: 'unknown', folder: '', inherited: false };
  for (const root of autoTrusted) {
    const rootKey = folderKey(root);
    if (rootKey && isInside(key, rootKey)) return { state: 'trusted', folder: rootKey, inherited: key !== rootKey, auto: true };
  }
  const { folders } = readTrust(dataDir);
  let best = null;
  for (const [folder, entry] of Object.entries(folders)) {
    if (!TRUST_STATES.includes(entry?.state)) continue;
    if (!isInside(key, folder)) continue;
    if (!best || folder.length > best.folder.length) best = { folder, state: entry.state };
  }
  if (!best) return { state: 'unknown', folder: '', inherited: false };
  return { state: best.state, folder: best.folder, inherited: best.folder !== key };
}

export function setTrust(dataDir, projectDir, state) {
  const key = folderKey(projectDir);
  if (!key) throw new Error('Не задана папка проекта');
  if (!TRUST_STATES.includes(state)) throw new Error(`Неизвестное состояние доверия: ${state}`);
  const data = readTrust(dataDir);
  data.folders[key] = { state, at: new Date().toISOString() };
  writeTrust(dataDir, data);
  return trustState(dataDir, projectDir);
}

export function removeTrust(dataDir, projectDir) {
  const key = folderKey(projectDir);
  const data = readTrust(dataDir);
  delete data.folders[key];
  writeTrust(dataDir, data);
  return trustState(dataDir, projectDir);
}

export function listTrust(dataDir) {
  const { folders } = readTrust(dataDir);
  return Object.entries(folders)
    .map(([folder, entry]) => ({ folder, state: entry?.state, at: entry?.at || '' }))
    .filter((item) => TRUST_STATES.includes(item.state))
    .sort((a, b) => a.folder.localeCompare(b.folder));
}

function countEntries(dir, filter) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter(filter).length;
  } catch {
    return 0;
  }
}

/**
 * Что в папке исполняется или влияет на агента. Показывается в окне доверия,
 * чтобы решение было осознанным. Код не загружается, только перечисляется.
 */
export function inspectProject(projectDir) {
  if (!projectDir) return { plugins: 0, mcpServers: [], agents: false, memory: false, skills: 0, executable: false };
  const base = path.join(projectDir, '.mai-code');
  const plugins = countEntries(path.join(base, 'plugins'), (e) => e.isFile() && e.name.endsWith('.js'));
  let mcpServers = [];
  try {
    const data = JSON.parse(fs.readFileSync(path.join(base, 'mcp.json'), 'utf8'));
    mcpServers = Object.keys(data?.mcpServers || data || {});
  } catch {
    mcpServers = [];
  }
  const skills =
    countEntries(path.join(base, 'skills'), (e) => e.isDirectory()) +
    countEntries(path.join(projectDir, '.opencode', 'skills'), (e) => e.isDirectory());
  const agents = fs.existsSync(path.join(projectDir, 'AGENTS.md'));
  const memory = fs.existsSync(path.join(base, 'memory.md'));
  return { plugins, mcpServers, agents, memory, skills, executable: plugins > 0 || mcpServers.length > 0 };
}
