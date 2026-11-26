/**
 * Куда синхронизировать задачи Multica: workspace и проект для папки проекта
 * (E2.3, ADR 0112). Без Electron и без CLI — чистые функции и запись настроек.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ignoreLocal } from './settings-levels.js';

/** UUID или slug. Значение с `-` в начале CLI принял бы за флаг — отказ. */
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function cleanId(value, label) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (!ID_RE.test(text)) throw new Error(`${label}: ожидается id или slug (латиница, цифры, - и _), получено «${text.slice(0, 40)}»`);
  return text;
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function projectFiles(projectDir) {
  return {
    project: path.join(projectDir, '.mai-code', 'settings.json'),
    local: path.join(projectDir, '.mai-code', 'settings.local.json'),
  };
}

/**
 * Куда синхронизировать: личный `settings.local.json` проекта → `settings.json` проекта
 * (общий для команды, в git) → личные настройки MAI. Файлы проекта читаются только
 * в доверенной папке (ADR 0028).
 * @returns {{ workspaceId: string, projectId: string, source: { workspaceId: string, projectId: string } }}
 */
export function resolveTarget({ projectDir = '', trusted = false, user = {} } = {}) {
  const levels = [];
  if (projectDir && trusted) {
    const files = projectFiles(projectDir);
    levels.push(['local', readJsonFile(files.local)?.multica || {}]);
    levels.push(['project', readJsonFile(files.project)?.multica || {}]);
  }
  levels.push(['user', user || {}]);
  const target = { workspaceId: '', projectId: '', source: { workspaceId: '', projectId: '' } };
  for (const key of ['workspaceId', 'projectId']) {
    for (const [level, data] of levels) {
      const value = String(data?.[key] ?? '').trim();
      if (!value) continue;
      target[key] = cleanId(value, key);
      target.source[key] = level;
      break;
    }
  }
  return target;
}

/** Глобальный флаг CLI: workspace на один вызов, без смены workspace по умолчанию. */
export function targetArgs(target = {}) {
  const id = cleanId(target.workspaceId, 'workspaceId');
  return id ? ['--workspace-id', id] : [];
}

export function issueListArgs(limit, target = {}) {
  const project = cleanId(target.projectId, 'projectId');
  return [...targetArgs(target), 'issue', 'list', '--output', 'json', '--limit', String(limit), ...(project ? ['--project', project] : [])];
}

export function issueCreateArgs({ title, description }, target = {}) {
  const project = cleanId(target.projectId, 'projectId');
  return [...targetArgs(target), 'issue', 'create', '--title', title, '--description', description, ...(project ? ['--project', project] : [])];
}

export function issueUpdateArgs(id, { title, description }, target = {}) {
  return [...targetArgs(target), 'issue', 'update', String(id), '--title', title, '--description', description];
}

/** Ответ CLI: массив или объект со списком под одним из ключей. */
export function pickList(data, keys) {
  if (Array.isArray(data)) return data;
  for (const key of keys) if (Array.isArray(data?.[key])) return data[key];
  return [];
}

export function normalizeWorkspaces(data) {
  return pickList(data, ['workspaces', 'items', 'data'])
    .map((w) => ({ id: String(w.id || w.workspace_id || ''), name: String(w.name || w.title || w.slug || ''), slug: String(w.slug || '') }))
    .filter((w) => w.id);
}

export function normalizeProjects(data) {
  return pickList(data, ['projects', 'items', 'data'])
    .map((p) => ({ id: String(p.id || p.project_id || ''), name: String(p.title || p.name || ''), status: String(p.status || '') }))
    .filter((p) => p.id);
}

/**
 * Записывает workspace и проект в настройки проекта. `scope: 'project'` — общий
 * `settings.json` (в git, для команды), `scope: 'local'` — личный `settings.local.json`.
 * Остальные ключи файла не трогаются. Пустое значение убирает ключ.
 */
export function saveProjectTarget(projectDir, { workspaceId = '', projectId = '' } = {}, { scope = 'project' } = {}) {
  if (!projectDir) throw new Error('Не выбрана папка проекта');
  if (!['project', 'local'].includes(scope)) throw new Error('scope: project или local');
  const file = projectFiles(projectDir)[scope];
  const data = readJsonFile(file) || {};
  const next = { ...(data.multica || {}) };
  for (const [key, value] of [['workspaceId', workspaceId], ['projectId', projectId]]) {
    const id = cleanId(value, key);
    if (id) next[key] = id;
    else delete next[key];
  }
  if (Object.keys(next).length) data.multica = next;
  else delete data.multica;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  // Личный файл не должен попасть в git (CC9.5).
  if (scope === 'local') ignoreLocal(path.dirname(file));
  return { ok: true, file, multica: data.multica || {} };
}
